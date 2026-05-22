import axios, { type AxiosInstance } from 'axios'
import { config } from '../config'
import { redis } from '../redis'

const GONG_BASE = 'https://api.gong.io/v2'
const CACHE_TTL_SECONDS = 60 * 60 // 1 hour — Gong rate limits: 3 req/s, 10k req/day
const CACHE_KEY = 'gong:call_index'

// ─── Raw Gong API types ────────────────────────────────────────────────────

interface GongCallMetadata {
  id: string
  started: string  // ISO-8601
  duration: number // seconds
  title: string
  url: string
}

interface GongCrmObject {
  objectType: string  // "Opportunity", "Account", "Contact", etc.
  objectId: string    // SFDC record ID
  fields?: Record<string, unknown>
}

interface GongCrmContext {
  system: string  // "Salesforce", "HubSpot", etc.
  objects: GongCrmObject[]
}

interface GongParty {
  emailAddress?: string
  name?: string
  userId?: string   // populated for internal (Gong) users
  context?: GongCrmContext[]
}

interface GongCallContent {
  highlights?: GongHighlight[]
  callOutcome?: { name?: string; category?: string }
}

interface GongHighlight {
  type: string
  title?: string
  monologue?: { text: string; speaker?: string }[]
}

interface GongExtensiveCall {
  metaData: GongCallMetadata
  parties: GongParty[]
  content?: GongCallContent
}

interface GongExtensiveResponse {
  calls: GongExtensiveCall[]
  records: {
    totalRecords: number
    currentPageNumber: number
    currentPageSize: number
    cursor?: string
  }
}

// ─── Derived types used by alert evaluators ────────────────────────────────

export interface GongOpportunityActivity {
  sfdcOpportunityId: string
  lastCallDate: string | null   // ISO-8601
  totalCalls: number
  // Unique external participant email addresses across all linked calls
  uniqueExternalParticipants: Set<string>
  // True if any call content contains risk phrases
  hasRiskPhrases: boolean
  riskPhrasesFound: string[]
}

// ─── Risk phrase detection ─────────────────────────────────────────────────

const RISK_PHRASES = [
  'no budget', 'budget cut', 'budget freeze', 'lost funding',
  'going with competitor', 'going with another', 'chosen another vendor',
  'not moving forward', 'put on hold', 'pausing', 'postponed',
  'not interested', 'dropping priority', 'lower priority',
  'executive sponsor left', 'champion left', 'champion changed',
  'internal politics', 'reorganization', 'reorg',
  'procurement blocked', 'legal hold',
]

function detectRiskPhrases(calls: GongExtensiveCall[]): { found: boolean; phrases: string[] } {
  const found = new Set<string>()

  for (const call of calls) {
    const highlights = call.content?.highlights ?? []
    for (const h of highlights) {
      const texts = (h.monologue ?? []).map((m) => m.text.toLowerCase())
      for (const phrase of RISK_PHRASES) {
        if (texts.some((t) => t.includes(phrase))) {
          found.add(phrase)
        }
      }
    }
  }

  return { found: found.size > 0, phrases: Array.from(found) }
}

// ─── Gong API client ───────────────────────────────────────────────────────

function makeClient(): AxiosInstance {
  return axios.create({
    baseURL: GONG_BASE,
    auth: {
      username: config.GONG_ACCESS_KEY,
      password: config.GONG_ACCESS_SECRET,
    },
    headers: { 'Content-Type': 'application/json' },
    timeout: 30_000,
  })
}

// Fetch all calls for a rolling window with cursor pagination
async function fetchAllCallsExtensive(
  client: AxiosInstance,
  fromDate: Date,
  toDate: Date
): Promise<GongExtensiveCall[]> {
  const calls: GongExtensiveCall[] = []
  let cursor: string | undefined

  do {
    const body: Record<string, unknown> = {
      filter: {
        fromDateTime: fromDate.toISOString(),
        toDateTime: toDate.toISOString(),
      },
      contentSelector: {
        highlights: true,
        callOutcome: true,
      },
      ...(cursor ? { cursor } : {}),
    }

    const res = await client.post<GongExtensiveResponse>('/calls/extensive', body)
    calls.push(...(res.data.calls ?? []))
    cursor = res.data.records?.cursor
  } while (cursor)

  return calls
}

// ─── Build the opportunity index ───────────────────────────────────────────

// Returns a map of SFDC Opportunity ID → activity summary
// Result is cached in Redis to avoid hammering the Gong API on every alert run
export async function buildOpportunityActivityIndex(
  sfdcIds: string[],
  lookbackDays = 90
): Promise<Map<string, GongOpportunityActivity>> {
  if (sfdcIds.length === 0) return new Map()

  // Check Redis cache first
  const cached = await redis.get(CACHE_KEY)
  if (cached) {
    const parsed = JSON.parse(cached) as Array<[string, Omit<GongOpportunityActivity, 'uniqueExternalParticipants'> & { uniqueExternalParticipants: string[] }]>
    const map = new Map<string, GongOpportunityActivity>()
    for (const [id, val] of parsed) {
      map.set(id, { ...val, uniqueExternalParticipants: new Set(val.uniqueExternalParticipants) })
    }
    // Only return entries relevant to requested sfdcIds
    for (const key of Array.from(map.keys())) {
      if (!sfdcIds.includes(key)) map.delete(key)
    }
    return map
  }

  const client = makeClient()
  const toDate = new Date()
  const fromDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)

  let calls: GongExtensiveCall[] = []
  try {
    calls = await fetchAllCallsExtensive(client, fromDate, toDate)
  } catch (err) {
    console.error('[Gong] Failed to fetch calls:', err)
    return new Map()
  }

  // Index calls by SFDC opportunity ID
  const callsByOpp = new Map<string, GongExtensiveCall[]>()

  for (const call of calls) {
    for (const party of call.parties ?? []) {
      for (const ctx of party.context ?? []) {
        if (ctx.system !== 'Salesforce' && ctx.system !== 'salesforce') continue
        for (const obj of ctx.objects ?? []) {
          if (obj.objectType !== 'Opportunity') continue
          const oppId = obj.objectId
          if (!callsByOpp.has(oppId)) callsByOpp.set(oppId, [])
          callsByOpp.get(oppId)!.push(call)
        }
      }
    }
  }

  // Build activity summaries
  const index = new Map<string, GongOpportunityActivity>()

  for (const [oppId, oppCalls] of callsByOpp.entries()) {
    // Deduplicate calls by ID (a call can appear multiple times if multiple parties link to same opp)
    const uniqueCalls = Array.from(new Map(oppCalls.map((c) => [c.metaData.id, c])).values())

    // Last call date
    const sorted = [...uniqueCalls].sort(
      (a, b) => new Date(b.metaData.started).getTime() - new Date(a.metaData.started).getTime()
    )
    const lastCallDate = sorted[0]?.metaData.started ?? null

    // Unique external participants (no userId = external/prospect)
    const externalEmails = new Set<string>()
    for (const call of uniqueCalls) {
      for (const party of call.parties ?? []) {
        if (!party.userId && party.emailAddress) {
          externalEmails.add(party.emailAddress.toLowerCase())
        }
      }
    }

    // Risk phrase detection from call highlights
    const { found: hasRiskPhrases, phrases: riskPhrasesFound } = detectRiskPhrases(uniqueCalls)

    index.set(oppId, {
      sfdcOpportunityId: oppId,
      lastCallDate,
      totalCalls: uniqueCalls.length,
      uniqueExternalParticipants: externalEmails,
      hasRiskPhrases,
      riskPhrasesFound,
    })
  }

  // Cache: serialize Sets to arrays
  const serializable = Array.from(index.entries()).map(([id, val]) => [
    id,
    { ...val, uniqueExternalParticipants: Array.from(val.uniqueExternalParticipants) },
  ])
  await redis.set(CACHE_KEY, JSON.stringify(serializable), 'EX', CACHE_TTL_SECONDS)

  // Filter to only requested IDs
  for (const key of Array.from(index.keys())) {
    if (!sfdcIds.includes(key)) index.delete(key)
  }

  return index
}

// Force-invalidate the cache (e.g. after admin triggers a manual alert run)
export async function invalidateGongCache(): Promise<void> {
  await redis.del(CACHE_KEY)
}

// ─── Derived signal helpers (used by stalled evaluator) ───────────────────

export function isSingleThreaded(activity: GongOpportunityActivity): boolean {
  // Only flag if there have been calls at all — no calls ≠ single-threaded
  return activity.totalCalls > 0 && activity.uniqueExternalParticipants.size <= 1
}

export function hasRedFlags(activity: GongOpportunityActivity): boolean {
  return activity.hasRiskPhrases
}

export function daysSinceLastGongCall(activity: GongOpportunityActivity): number | null {
  if (!activity.lastCallDate) return null
  return Math.floor((Date.now() - new Date(activity.lastCallDate).getTime()) / (1000 * 60 * 60 * 24))
}
