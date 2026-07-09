import axios from 'axios'
import { getServiceConnection } from './salesforce'
import { sendDm, resolveSlackUserId } from '../slack/bot'
import type { KnownBlock } from '@slack/web-api'

// ── Routing config ─────────────────────────────────────────────────────────────
// Update these when territories change — priority order matters (first match wins)

export const LEADERS = {
  allison: { name: 'Allison Townsend', email: 'allison.townsend@uberall.com', region: 'US/Canada' },
  jo:      { name: 'Jo Billington',    email: 'jo.billington@uberall.com',    region: 'Northern Europe' },
  karolina:{ name: 'Karolina Vetter',  email: 'karolina.vetter@uberall.com',  region: 'EMEA' },
  samy:    { name: 'Samy Benmeziane', email: 'samy.benmeziane@uberall.com',   region: 'EMEA' },
} as const

export const ANA = { name: 'Ana Hernández', email: 'ana.hernandez@uberall.com' }

// Rule 2 — these reps always route to Samy with Ana suggested regardless of country
export const SPANISH_SPEAKING_OWNERS = new Set(['Javier Villar', 'Alexis Perez'])

// Rule 5 — Northern Europe named reps → Jo Billington
export const NORTHERN_EUROPE_OWNERS = new Set(['Jon Lapham', 'Barry Faulkner', 'Dusko Tomic'])

// Rule 3 — US-CAN role rep but billing country is LATAM → Samy, suggest Ana
export const LATAM_COUNTRIES = new Set([
  'Mexico', 'Colombia', 'Argentina', 'Chile', 'Peru', 'Ecuador',
  'Bolivia', 'Paraguay', 'Uruguay', 'Venezuela', 'Costa Rica',
  'Guatemala', 'Honduras', 'El Salvador', 'Nicaragua', 'Dominican Republic',
  'Cuba', 'Panama', 'Puerto Rico', 'Brazil',
])

// ── Types ───────────────────────────────────────────────────────────────────────

export interface ReassignAccount {
  id: string
  name: string
  ownerName: string
  ownerEmail: string | null
  ownerRole: string | null
  billingCountry: string | null
  secondaryOwnerName: string | null
  numberOfLocations: number | null
}

export interface RoutedAccount {
  account: ReassignAccount
  leaderKey: keyof typeof LEADERS
  leaderName: string
  leaderEmail: string
  suggestAna: boolean
  routeReason: string
}

export interface UnroutedAccount {
  account: ReassignAccount
  reason: string
}

export interface ReassignmentPreview {
  routedByLeader: Record<string, RoutedAccount[]>
  unrouted: UnroutedAccount[]
  total: number
  fetchedAt: string
}

// ── Types (continued) ──────────────────────────────────────────────────────────

export interface ExistingBusinessRep {
  id: string
  name: string
  email: string
  role: string
}

// ── SOQL ────────────────────────────────────────────────────────────────────────

export async function fetchExistingBusinessReps(): Promise<ExistingBusinessRep[]> {
  const conn = await getServiceConnection()

  const soql = `
    SELECT Id, Name, Email, UserRole.Name
    FROM User
    WHERE IsActive = true
    AND UserRole.Name LIKE '%Existing Business%'
    AND UserRole.Name LIKE '%Rep%'
    ORDER BY Name ASC
  `

  interface RawUser { Id: string; Name: string; Email: string; UserRole?: { Name?: string } | null }
  interface SfdcPage<T> { records: T[]; done: boolean; nextRecordsUrl?: string }

  const records: RawUser[] = []
  let nextPath: string | null = `/services/data/v59.0/query?q=${encodeURIComponent(soql)}`

  while (nextPath) {
    const resp: { data: SfdcPage<RawUser> } = await axios.get<SfdcPage<RawUser>>(
      `${conn.instanceUrl}${nextPath}`,
      { headers: { Authorization: `Bearer ${conn.accessToken!}` }, timeout: 20_000 },
    )
    records.push(...resp.data.records)
    nextPath = resp.data.done ? null : (resp.data.nextRecordsUrl ?? null)
  }

  return records.map((r) => ({
    id: r.Id,
    name: r.Name,
    email: r.Email,
    role: r.UserRole?.Name ?? '',
  }))
}

export async function fetchReassignAccounts(): Promise<ReassignAccount[]> {
  const conn = await getServiceConnection()

  const soql = `
    SELECT Id, Name,
           Owner.Name, Owner.Email, Owner.UserRole.Name,
           BillingCountry,
           KAP_CS_Owner__r.Name,
           Number_of_locations__c,
           Account_Stage__c, GEO_Studio_Customer_Only__c, Type
    FROM Account
    WHERE Account_Stage__c = 'Customer'
    AND RecordType.DeveloperName = 'Enterprise_Account_Record'
    AND Type = 'Direct Enterprise'
    AND (NOT Name LIKE '%TEST%')
    AND GEO_Studio_Customer_Only__c = false
    AND (
      Owner.UserRole.Name LIKE '%New Business%'
      OR Owner.Name LIKE '%#%'
      OR KAP_CS_Owner__r.Name LIKE '%#%'
    )
    ORDER BY Owner.Name ASC, Name ASC
  `

  interface RawAccount {
    Id: string
    Name: string
    Owner?: { Name?: string; Email?: string; UserRole?: { Name?: string } | null } | null
    BillingCountry?: string | null
    KAP_CS_Owner__r?: { Name?: string } | null
    Number_of_locations__c?: number | null
  }

  interface SfdcPage<T> { records: T[]; done: boolean; nextRecordsUrl?: string }

  const records: RawAccount[] = []
  let nextPath: string | null = `/services/data/v59.0/query?q=${encodeURIComponent(soql)}`

  while (nextPath) {
    const resp: { data: SfdcPage<RawAccount> } = await axios.get<SfdcPage<RawAccount>>(
      `${conn.instanceUrl}${nextPath}`,
      { headers: { Authorization: `Bearer ${conn.accessToken!}` }, timeout: 20_000 },
    )
    const page: SfdcPage<RawAccount> = resp.data
    records.push(...page.records)
    nextPath = page.done ? null : (page.nextRecordsUrl ?? null)
  }

  return records.map((r) => ({
    id: r.Id,
    name: r.Name,
    ownerName: r.Owner?.Name ?? '',
    ownerEmail: r.Owner?.Email ?? null,
    ownerRole: r.Owner?.UserRole?.Name ?? null,
    billingCountry: r.BillingCountry ?? null,
    secondaryOwnerName: r.KAP_CS_Owner__r?.Name ?? null,
    numberOfLocations: r.Number_of_locations__c ?? null,
  }))
}

// ── Routing overrides (persisted in appSettings) ────────────────────────────────

export interface RoutingOverrides {
  spanishSpeakingOwners?: string[]
  northernEuropeOwners?: string[]
}

// ── Routing logic ───────────────────────────────────────────────────────────────

export function routeAccount(
  account: ReassignAccount,
  overrides?: RoutingOverrides,
): { leaderKey: keyof typeof LEADERS; suggestAna: boolean; reason: string } | null {
  const ownerName = account.ownerName
  const ownerRole = account.ownerRole ?? ''
  const country = account.billingCountry ?? ''

  const spanishSet = overrides?.spanishSpeakingOwners
    ? new Set(overrides.spanishSpeakingOwners)
    : SPANISH_SPEAKING_OWNERS

  const northernEuropeSet = overrides?.northernEuropeOwners
    ? new Set(overrides.northernEuropeOwners)
    : NORTHERN_EUROPE_OWNERS

  // Rule 1: Named Spanish-speaking reps → Samy, suggest Ana
  if (spanishSet.has(ownerName)) {
    return { leaderKey: 'samy', suggestAna: true, reason: `Owner: ${ownerName} (Spanish-speaking)` }
  }

  // Rule 2: US-CAN role + LATAM billing country → Samy, suggest Ana
  if (ownerRole.includes('US-CAN') && ownerRole.includes('New Business') && LATAM_COUNTRIES.has(country)) {
    return { leaderKey: 'samy', suggestAna: true, reason: `US-CAN rep, LATAM billing country (${country})` }
  }

  // Rule 3: US-CAN New Business role → Allison
  if (ownerRole.includes('US-CAN') && ownerRole.includes('New Business')) {
    return { leaderKey: 'allison', suggestAna: false, reason: 'US-CAN New Business rep' }
  }

  // Rule 4: Northern Europe named reps → Jo
  if (northernEuropeSet.has(ownerName)) {
    return { leaderKey: 'jo', suggestAna: false, reason: `Northern Europe rep (${ownerName})` }
  }

  // Rule 5: Enrico Pisoni → Karolina
  if (ownerName === 'Enrico Pisoni') {
    return { leaderKey: 'karolina', suggestAna: false, reason: 'Owner: Enrico Pisoni' }
  }

  // Rule 6: EMEA New Business role → Samy
  if (ownerRole.includes('EMEA') && ownerRole.includes('New Business')) {
    return { leaderKey: 'samy', suggestAna: false, reason: 'EMEA New Business rep' }
  }

  // Rule 7: Inactive owner (# in name) — route by billing country
  const ownerInactive = ownerName.includes('#')
  const secondaryInactive = (account.secondaryOwnerName ?? '').includes('#')
  if (ownerInactive || secondaryInactive) {
    const isUSCAN = ['United States', 'Canada'].includes(country)
    return {
      leaderKey: isUSCAN ? 'allison' : 'samy',
      suggestAna: false,
      reason: `Inactive ${ownerInactive ? 'owner' : 'secondary owner'}, routed by billing country (${country || 'unknown'})`,
    }
  }

  return null
}

export function buildPreview(accounts: ReassignAccount[], overrides?: RoutingOverrides): ReassignmentPreview {
  const routedByLeader: Record<string, RoutedAccount[]> = {}
  const unrouted: UnroutedAccount[] = []

  for (const account of accounts) {
    const route = routeAccount(account, overrides)
    if (!route) {
      unrouted.push({ account, reason: 'No matching routing rule' })
      continue
    }
    const leader = LEADERS[route.leaderKey]
    if (!routedByLeader[route.leaderKey]) routedByLeader[route.leaderKey] = []
    routedByLeader[route.leaderKey].push({
      account,
      leaderKey: route.leaderKey,
      leaderName: leader.name,
      leaderEmail: leader.email,
      suggestAna: route.suggestAna,
      routeReason: route.reason,
    })
  }

  return { routedByLeader, unrouted, total: accounts.length, fetchedAt: new Date().toISOString() }
}

// ── Slack messages ──────────────────────────────────────────────────────────────

const SFDC_BASE = 'https://uberall.lightning.force.com'

function accountLine(a: ReassignAccount): string {
  const country = a.billingCountry ?? 'Unknown country'
  const owner = a.ownerName.startsWith('#') ? `${a.ownerName} _(inactive)_` : a.ownerName
  const locs = a.numberOfLocations != null ? ` · 📍 ${a.numberOfLocations} locs` : ''
  return `• <${SFDC_BASE}/${a.id}|${a.name}>${locs} — ${country} — ${owner}`
}

function buildLeaderBlocks(
  leaderName: string,
  accounts: RoutedAccount[],
  appUrl: string,
  reps?: ExistingBusinessRep[],
): KnownBlock[] {
  const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const anaGroup  = accounts.filter((a) => a.suggestAna)
  const teamGroup = accounts.filter((a) => !a.suggestAna)
  const firstName = leaderName.split(' ')[0]

  // Build dropdown options once (max 100 Slack allows)
  const repOptions = reps && reps.length > 0
    ? reps.slice(0, 100).map((r) => ({
        text: { type: 'plain_text' as const, text: r.name },
        value: `${r.id}|${r.name}`,
      }))
    : null

  const blocks: KnownBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: `📋 Customers to reassign — ${date}`, emoji: true } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Hi ${firstName}! *${accounts.length} customer account${accounts.length !== 1 ? 's' : ''}* are owned by New Business reps and need to be moved to your team.${repOptions ? ' Use the dropdown on each row to assign.' : ''}`,
      },
    },
    { type: 'divider' },
  ]

  // Max accounts per group — keep total blocks under Slack's 50-block limit
  const MAX = repOptions ? 15 : 20

  function addGroup(group: RoutedAccount[], heading: string) {
    if (group.length === 0) return
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${heading}*` } })
    const shown = group.slice(0, MAX)

    if (repOptions) {
      // One section block per account with a dropdown accessory
      for (const r of shown) {
        blocks.push({
          type: 'section',
          block_id: `acct_${r.account.id}`,
          text: { type: 'mrkdwn', text: accountLine(r.account) },
          accessory: {
            type: 'static_select',
            action_id: 'assign_account_owner',
            placeholder: { type: 'plain_text', text: 'Assign to…', emoji: false },
            options: repOptions,
          },
        } as KnownBlock)
      }
    } else {
      const lines = shown.map((r) => accountLine(r.account))
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } })
    }

    if (group.length > MAX) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `_…and ${group.length - MAX} more — see Beacon for the full list_` },
      })
    }
  }

  if (anaGroup.length > 0 && teamGroup.length > 0) {
    addGroup(anaGroup, `🇪🇸 Suggest assigning to Ana Hernández (${anaGroup.length})`)
    addGroup(teamGroup, `🌍 Assign to your team (${teamGroup.length})`)
  } else if (anaGroup.length > 0) {
    addGroup(anaGroup, `🇪🇸 Suggest assigning to Ana Hernández`)
  } else {
    addGroup(teamGroup, `Accounts to assign to your team`)
  }

  blocks.push({ type: 'divider' })
  blocks.push({
    type: 'actions',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: 'View in Beacon', emoji: true },
      url: `${appUrl}/playbook/territory/newlogos`,
      style: 'primary',
    }],
  })

  return blocks
}

export async function sendReassignmentMessages(
  preview: ReassignmentPreview,
  appUrl: string,
): Promise<{ sent: string[]; failed: string[] }> {
  const sent: string[] = []
  const failed: string[] = []

  // Fetch Existing Business reps once for the dropdown options
  let reps: ExistingBusinessRep[] = []
  try {
    reps = await fetchExistingBusinessReps()
    console.log(`[Reassignment] Fetched ${reps.length} Existing Business reps for dropdowns`)
  } catch (err) {
    console.warn('[Reassignment] Could not fetch EB reps — dropdowns will be omitted:', err)
  }

  for (const [leaderKey, accounts] of Object.entries(preview.routedByLeader)) {
    if (accounts.length === 0) continue
    const leader = LEADERS[leaderKey as keyof typeof LEADERS]
    try {
      const slackId = await resolveSlackUserId(leader.email)
      if (!slackId) {
        console.warn(`[Reassignment] No Slack ID for ${leader.email}`)
        failed.push(leader.name)
        continue
      }
      const blocks = buildLeaderBlocks(leader.name, accounts, appUrl, reps.length > 0 ? reps : undefined)
      await sendDm(slackId, blocks, `📋 ${accounts.length} customers to reassign — ${leader.name}`)
      console.log(`[Reassignment] Sent to ${leader.name}: ${accounts.length} accounts`)
      sent.push(leader.name)
    } catch (err) {
      console.error(`[Reassignment] Failed to send to ${leader.name}:`, err)
      failed.push(leader.name)
    }
  }

  return { sent, failed }
}

export async function runReassignmentJob(appUrl: string): Promise<void> {
  console.log('[Reassignment] Starting daily reassignment run...')
  const accounts = await fetchReassignAccounts()
  console.log(`[Reassignment] Fetched ${accounts.length} accounts`)
  const preview = buildPreview(accounts)
  console.log(`[Reassignment] Routed: ${preview.total - preview.unrouted.length}, unrouted: ${preview.unrouted.length}`)
  const { sent, failed } = await sendReassignmentMessages(preview, appUrl)
  console.log(`[Reassignment] Sent to: ${sent.join(', ')}${failed.length ? ` | Failed: ${failed.join(', ')}` : ''}`)
}
