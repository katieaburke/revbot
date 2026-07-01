import axios, { type AxiosInstance } from 'axios'
import { config } from '../config'
import { redis } from '../redis'

const GONG_BASE = 'https://api.gong.io/v2'
const CACHE_TTL_SECONDS = 60 * 60 // 1 hour — Gong rate limits: 3 req/s, 10k req/day
const CACHE_KEY = 'gong:call_index'
const CACHE_KEY_RAW = 'gong:calls_raw'
const CACHE_KEY_FLOWS = 'gong:flow_contacts'
const FLOW_CACHE_TTL_SECONDS = 30 * 60 // 30 min — flow enrollments change less often

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

// ─── Gong Engage flow types ────────────────────────────────────────────────

interface GongFlow {
  id: string
  name: string
  status?: string  // may include 'ACTIVE', 'INACTIVE', etc.
}

interface GongFlowsResponse {
  flows: GongFlow[]
  records?: { totalRecords?: number; cursor?: string }
}

interface GongFlowContact {
  emailAddress?: string
  status?: string           // 'ACTIVE', 'COMPLETED', 'STOPPED', 'BOUNCED', etc.
  // Gong may use various names for the next step due date
  nextStepDueDate?: string | null
  nextTouchpointDate?: string | null
  dueDate?: string | null
  scheduledDate?: string | null
  // Completion timestamp
  completedAt?: string | null
  completedDate?: string | null
  endedAt?: string | null
}

interface GongFlowContactsResponse {
  contacts: GongFlowContact[]
  records?: { cursor?: string }
}

export interface GongFlowEnrollment {
  flowId: string
  flowName: string
  status: string
  // When the next step is due (null if none / completed)
  nextStepDueDate: string | null
  // When this contact completed the flow (null if still active)
  completedAt: string | null
}

// ─── Derived types used by alert evaluators ────────────────────────────────

export interface GongAccountActivity {
  sfdcAccountId: string
  lastCallDate: string | null
  totalCalls: number
  contactEmailsOnCalls: Set<string>  // external participant emails seen on calls
}

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

// ─── Shared raw call cache helper ──────────────────────────────────────────

// Fetches all Gong calls for the lookback window, caching raw results in Redis.
// Both the opportunity index and account index read from this shared cache.
async function getCachedCalls(lookbackDays = 90): Promise<GongExtensiveCall[]> {
  const cached = await redis.get(CACHE_KEY_RAW)
  if (cached) {
    return JSON.parse(cached) as GongExtensiveCall[]
  }

  const client = makeClient()
  const toDate = new Date()
  const fromDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)

  let calls: GongExtensiveCall[] = []
  try {
    calls = await fetchAllCallsExtensive(client, fromDate, toDate)
  } catch (err) {
    console.error('[Gong] Failed to fetch calls:', err)
    return []
  }

  await redis.set(CACHE_KEY_RAW, JSON.stringify(calls), 'EX', CACHE_TTL_SECONDS)
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

  const calls = await getCachedCalls(lookbackDays)

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
  await redis.del(CACHE_KEY_RAW)
  await redis.del(CACHE_KEY_FLOWS)
}

// ─── Build the flow contact index ──────────────────────────────────────────

// Returns a map of contact email (lowercase) → active flow enrollments.
// Returns null if the Gong Engage Flows API is unavailable (plan/permission issue).
// Results are cached in Redis for 30 minutes.
export async function buildFlowContactIndex(
  emailAddresses: string[]
): Promise<{ index: Map<string, GongFlowEnrollment[]> | null; error: string | null }> {
  if (emailAddresses.length === 0) return { index: new Map(), error: null }

  const normalizedEmails = emailAddresses.map((e) => e.toLowerCase())

  // Check Redis cache
  const cached = await redis.get(CACHE_KEY_FLOWS)
  if (cached) {
    const parsed = JSON.parse(cached) as Array<[string, GongFlowEnrollment[]]>
    const fullMap = new Map<string, GongFlowEnrollment[]>(parsed)
    const result = new Map<string, GongFlowEnrollment[]>()
    for (const email of normalizedEmails) {
      const enrollments = fullMap.get(email)
      if (enrollments?.length) result.set(email, enrollments)
    }
    return { index: result, error: null }
  }

  const client = makeClient()

  try {
    // Fetch all flows (paginated)
    const allFlows: GongFlow[] = []
    let flowCursor: string | undefined
    do {
      const res = await client.get<GongFlowsResponse>('/flows', {
        params: flowCursor ? { cursor: flowCursor } : {},
      })
      allFlows.push(...(res.data.flows ?? []))
      flowCursor = res.data.records?.cursor
    } while (flowCursor)

    // Build email → active enrollments index
    const emailToFlows = new Map<string, GongFlowEnrollment[]>()

    for (const flow of allFlows) {
      try {
        let contactCursor: string | undefined
        do {
          const res = await client.get<GongFlowContactsResponse>(`/flows/${flow.id}/contacts`, {
            params: contactCursor ? { cursor: contactCursor } : {},
          })
          for (const contact of res.data.contacts ?? []) {
            if (!contact.emailAddress) continue
            const status = contact.status ?? 'UNKNOWN'
            const statusUp = status.toUpperCase()

            // Include active enrollments and completed ones (for "completed since target date" metric)
            const isActive = ['ACTIVE', 'IN_PROGRESS', 'ENROLLED'].includes(statusUp)
            const isCompleted = statusUp === 'COMPLETED'
            if (!isActive && !isCompleted) continue

            // Resolve next step due date — Gong may use different field names
            const nextStepDueDate =
              contact.nextStepDueDate ?? contact.nextTouchpointDate ?? contact.dueDate ?? contact.scheduledDate ?? null

            // Resolve completion timestamp
            const completedAt =
              contact.completedAt ?? contact.completedDate ?? contact.endedAt ?? null

            const email = contact.emailAddress.toLowerCase()
            if (!emailToFlows.has(email)) emailToFlows.set(email, [])
            emailToFlows.get(email)!.push({
              flowId: flow.id,
              flowName: flow.name,
              status,
              nextStepDueDate,
              completedAt,
            })
          }
          contactCursor = res.data.records?.cursor
        } while (contactCursor)
      } catch (err) {
        // Skip individual flows we can't read (permission/not-found)
        console.warn(`[Gong] Skipping flow ${flow.id} (${flow.name}):`, String(err))
      }
    }

    // Cache the full index
    await redis.set(
      CACHE_KEY_FLOWS,
      JSON.stringify(Array.from(emailToFlows.entries())),
      'EX',
      FLOW_CACHE_TTL_SECONDS
    )

    // Return filtered result for requested emails
    const result = new Map<string, GongFlowEnrollment[]>()
    for (const email of normalizedEmails) {
      const enrollments = emailToFlows.get(email)
      if (enrollments?.length) result.set(email, enrollments)
    }
    return { index: result, error: null }
  } catch (err) {
    // Extract the most useful part of the error for surfacing in the UI
    const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string }
    const status = axiosErr.response?.status
    const body = axiosErr.response?.data
    const detail = body ? JSON.stringify(body) : axiosErr.message ?? String(err)
    const errorMsg = status ? `Gong Flows API ${status}: ${detail}` : `Gong Flows API error: ${detail}`
    console.error('[Gong] Flows API unavailable:', errorMsg)
    return { index: null, error: errorMsg }
  }
}

// ─── Build the account activity index ──────────────────────────────────────

// Returns a map of SFDC Account ID → activity summary
// Uses the shared raw call cache to avoid redundant Gong API calls.
export async function buildAccountActivityIndex(
  accountIds: string[],
  lookbackDays = 90
): Promise<Map<string, GongAccountActivity>> {
  if (accountIds.length === 0) return new Map()

  const calls = await getCachedCalls(lookbackDays)

  // Index calls by SFDC account ID (objectType === 'Account')
  const callsByAccount = new Map<string, GongExtensiveCall[]>()

  for (const call of calls) {
    for (const party of call.parties ?? []) {
      for (const ctx of party.context ?? []) {
        if (ctx.system !== 'Salesforce' && ctx.system !== 'salesforce') continue
        for (const obj of ctx.objects ?? []) {
          if (obj.objectType !== 'Account') continue
          const accountId = obj.objectId
          if (!callsByAccount.has(accountId)) callsByAccount.set(accountId, [])
          callsByAccount.get(accountId)!.push(call)
        }
      }
    }
  }

  // Build activity summaries
  const index = new Map<string, GongAccountActivity>()

  for (const [accountId, accountCalls] of callsByAccount.entries()) {
    // Deduplicate calls by ID
    const uniqueCalls = Array.from(new Map(accountCalls.map((c) => [c.metaData.id, c])).values())

    // Last call date
    const sorted = [...uniqueCalls].sort(
      (a, b) => new Date(b.metaData.started).getTime() - new Date(a.metaData.started).getTime()
    )
    const lastCallDate = sorted[0]?.metaData.started ?? null

    // External participant emails
    const externalEmails = new Set<string>()
    for (const call of uniqueCalls) {
      for (const party of call.parties ?? []) {
        if (!party.userId && party.emailAddress) {
          externalEmails.add(party.emailAddress.toLowerCase())
        }
      }
    }

    index.set(accountId, {
      sfdcAccountId: accountId,
      lastCallDate,
      totalCalls: uniqueCalls.length,
      contactEmailsOnCalls: externalEmails,
    })
  }

  // Filter to only requested account IDs
  for (const key of Array.from(index.keys())) {
    if (!accountIds.includes(key)) index.delete(key)
  }

  return index
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
