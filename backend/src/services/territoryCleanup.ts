import axios from 'axios'
import { getServiceConnection } from './salesforce'
import { db } from '../db'

// ─── Territory Cleanup ───────────────────────────────────────────────────────
//
// Queues up stale Prospect accounts and asks the owning AE to validate them.
// Criteria mirror SFDC report 00OW600000ESj29MAD ("Prospect Accounts - Data
// Request" / Prospect_Accounts_USCAN_No_Activity):
//
//   Account_Stage__c            = 'Prospect'
//   RecordType.Name             = 'Enterprise Account Record'
//   Owner.Name                  not like %grave% / %shark%  (Graveyard, Shark Tank)
//   Owner role rollup           contains 'New Business'
//
// The staleness window and location-count range are rep-adjustable (see
// TerritoryFilters). Defaults reproduce the report's original behaviour:
// Last_Rep_Communication_Date__c before Jan 1 of the current year, or blank.
//
// The report scopes by owner role rollup; here we scope by Owner.Email to the
// requesting rep, which implies the rollup filter as long as the rep is a New
// Business AE (enforced separately by isAccountExecutive).

/**
 * Default API name for the free-text feedback field. Overridable via AppSetting.
 *
 * This is the old "ICP/IPP Fit Rationale" field, relabelled in Setup to "Data
 * Feedback" and repurposed rather than creating a new one — so the API name
 * deliberately doesn't match the label.
 */
const DEFAULT_FEEDBACK_FIELD = 'ICP_IPP_Fit_Rationale__c'
const FEEDBACK_FIELD_SETTING_KEY = 'territoryCleanupFeedbackField'

export const DISPOSITIONS = [
  'GOOD_LEAVE_IN_TERRITORY',
  'USE_CASE_LOW_PRIORITY',
  'NO_ICP',
  'DUPLICATE',
  'DECISION_ON_PARENT',
  'DECISION_ON_CHILD',
  'OTHER',
] as const
export type Disposition = (typeof DISPOSITIONS)[number]

export const NO_ICP_SUB_REASONS = ['TOO_SMALL', 'JUNK', 'PARTNER', 'DEFUNCT'] as const
export type NoIcpSubReason = (typeof NO_ICP_SUB_REASONS)[number]

/** Human-readable prefixes written into the feedback field. */
const SUB_REASON_LABEL: Record<NoIcpSubReason, string> = {
  TOO_SMALL: 'Too small',
  JUNK: 'Junk account',
  PARTNER: 'Partner account',
  DEFUNCT: 'Defunct account',
}

export interface TerritoryAccount {
  accountId: string
  accountName: string
  website: string | null
  /**
   * Company_Description__c (label "Company Description") — the curated company
   * brief. This is the only description field we use: the standard Account
   * Description is not maintained here and holds legacy junk on some records
   * (phone/fax dumps), so it is deliberately not read or fallen back to.
   */
  description: string | null
  industry: string | null
  subIndustry: string | null
  numberOfLocations: number | null
  currentLocations: number | null
  ultimateParentLocations: number | null
  /**
   * BATCH_TAM__c — label "ICP/IPP Fit". READ-ONLY for this app: it's shown to reps
   * for context but never written, by decision. Other automation owns it, so don't
   * add it to a disposition's field payload.
   */
  icpIppFit: string | null
  /** ICP_IPP_Fit_Rating__c — the 1-5 / Insufficient scoring field */
  icpIppFitRating: string | null
  icp: string | null
  accountStage: string | null
  prospectingStatus: string | null
  prospectingPauseReason: string | null
  /** Rep_Flagged_Duplicate__c — the rep's own call, not dupcheck's Duplicate_Flag__c. */
  duplicateFlag: boolean
  parentId: string | null
  parentName: string | null
  ultimateParent: string | null
  lastRepCommunicationDate: string | null
  billingCountry: string | null
  /** Operating_Model_s__c — the live field, not the legacy Operating_Model__c. */
  operatingModel: string | null
  productFit: string | null
  /**
   * Product_Fit_Rationale__c — the "why" behind Product Fit. A distinct field from
   * ICP_IPP_Fit_Rationale__c, which is now labelled "Data Feedback" and is what
   * this tool writes rep feedback into.
   */
  productFitRationale: string | null
}

// Role parsing now lives in lib/repRoles (it gates the Whitespace tab too).
// Re-exported so existing importers of this module keep working.
export { isAccountExecutive } from '../lib/repRoles'

async function getFeedbackField(): Promise<string> {
  try {
    const setting = await db.appSetting.findUnique({ where: { key: FEEDBACK_FIELD_SETTING_KEY } })
    if (setting?.value) {
      const parsed = JSON.parse(setting.value)
      if (typeof parsed === 'string' && parsed.trim()) return parsed.trim()
    }
  } catch {
    /* fall through to default */
  }
  return DEFAULT_FEEDBACK_FIELD
}

/** Escape a value for safe interpolation into a SOQL string literal. */
function soqlEscape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

const ACCOUNT_FIELDS = [
  'Id',
  'Name',
  'Website',
  'Company_Description__c',
  'Industry',
  'Sub_Industry__c',
  'Number_of_locations__c',
  'Current_Locations__c',
  'Ultimate_Parent_Number_of_Locations__c',
  'BATCH_TAM__c',
  'ICP_IPP_Fit_Rating__c',
  'ICP__c',
  'Account_Stage__c',
  'Prospecting_Status__c',
  'Prospecting_Pause_Reason__c',
  'Rep_Flagged_Duplicate__c',
  'ParentId',
  'Parent.Name',
  'Ultimate_Parent_Account__c',
  'Last_Rep_Communication_Date__c',
  'BillingCountry',
  'Operating_Model_s__c',
  'Product_Fit__c',
  'Product_Fit_Rationale__c',
].join(', ')

interface RawAccount {
  Id: string
  Name: string
  Website: string | null
  Company_Description__c: string | null
  Industry: string | null
  Sub_Industry__c: string | null
  Number_of_locations__c: number | null
  Current_Locations__c: number | null
  Ultimate_Parent_Number_of_Locations__c: number | null
  BATCH_TAM__c: string | null
  ICP_IPP_Fit_Rating__c: string | null
  ICP__c: string | null
  Account_Stage__c: string | null
  Prospecting_Status__c: string | null
  Prospecting_Pause_Reason__c: string | null
  Rep_Flagged_Duplicate__c: boolean | null
  ParentId: string | null
  Parent: { Name: string } | null
  Ultimate_Parent_Account__c: string | null
  Last_Rep_Communication_Date__c: string | null
  BillingCountry: string | null
  Operating_Model_s__c: string | null
  Product_Fit__c: string | null
  Product_Fit_Rationale__c: string | null
}

interface SfdcPage {
  records: RawAccount[]
  done: boolean
  nextRecordsUrl?: string
}

export interface TerritoryFilters {
  /** ISO date (YYYY-MM-DD). Accounts last contacted before this date match. */
  lastCommBefore?: string | null
  /** Also include accounts never contacted at all. Defaults to true. */
  includeBlankLastComm?: boolean
  minLocations?: number | null
  maxLocations?: number | null
}

/**
 * A year ago today, as `YYYY-MM-DD`. This used to be Jan 1 of the current year,
 * which reproduced the original `< THIS_YEAR` report but made the queue shrink as
 * the year went on — by December it only caught accounts untouched for 11 months.
 * A rolling 365 days keeps the definition of "stale" steady.
 *
 * UTC arithmetic, matching the frontend's copy of this default, so the two agree
 * regardless of the rep's timezone.
 */
export const DEFAULT_LAST_COMM_DAYS = 365

function defaultLastCommBefore(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - DEFAULT_LAST_COMM_DAYS)
  return d.toISOString().slice(0, 10)
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Build the filter fragment of the queue query.
 *
 * Everything interpolated here is validated first: dates must match ISO_DATE and
 * bounds must be finite integers. SOQL date literals are unquoted, so a raw
 * string here would be an injection vector — hence the strict regex rather than
 * soqlEscape, which only helps inside quoted literals.
 */
function buildFilterClauses(filters: TerritoryFilters): string[] {
  const { lastCommBefore, includeBlankLastComm, minLocations, maxLocations } =
    resolveTerritoryFilters(filters)
  const clauses: string[] = []

  clauses.push(
    includeBlankLastComm
      ? `(Last_Rep_Communication_Date__c < ${lastCommBefore} OR Last_Rep_Communication_Date__c = null)`
      : `Last_Rep_Communication_Date__c < ${lastCommBefore}`
  )

  // Note: SFDC treats null as failing any numeric comparison, so setting a bound
  // excludes accounts with no location count. That's surfaced in the UI.
  if (minLocations !== null) clauses.push(`Number_of_locations__c >= ${minLocations}`)
  if (maxLocations !== null) clauses.push(`Number_of_locations__c <= ${maxLocations}`)

  return clauses
}

export interface ResolvedTerritoryFilters {
  lastCommBefore: string
  includeBlankLastComm: boolean
  minLocations: number | null
  maxLocations: number | null
}

/**
 * Normalise raw filter input into exactly what the query will use. Shared with
 * the API layer so the response can report the *effective* filters — otherwise a
 * defaulted or rejected value would be echoed back as the rep's own input.
 */
export function resolveTerritoryFilters(filters: TerritoryFilters): ResolvedTerritoryFilters {
  const raw = filters.lastCommBefore?.trim()
  const int = (v: number | null | undefined): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : null

  // A max below the min would silently return nothing; swap rather than surprise.
  let min = int(filters.minLocations)
  let max = int(filters.maxLocations)
  if (min !== null && max !== null && max < min) [min, max] = [max, min]

  return {
    lastCommBefore: raw && ISO_DATE.test(raw) ? raw : defaultLastCommBefore(),
    includeBlankLastComm: filters.includeBlankLastComm !== false,
    minLocations: min,
    maxLocations: max,
  }
}

/**
 * Fetch the rep's un-validated territory accounts. Pages through all results —
 * a single rep's slice is typically a few hundred accounts, but we don't want a
 * silent truncation at SFDC's 2000-record page limit.
 */
export async function fetchTerritoryAccounts(
  repEmail: string,
  filters: TerritoryFilters = {},
): Promise<TerritoryAccount[]> {
  const conn = await getServiceConnection()

  const soql = `
    SELECT ${ACCOUNT_FIELDS}
    FROM Account
    WHERE Account_Stage__c = 'Prospect'
      AND RecordType.Name = 'Enterprise Account Record'
      AND (NOT Owner.Name LIKE '%grave%')
      AND (NOT Owner.Name LIKE '%shark%')
      AND Owner.Email = '${soqlEscape(repEmail)}'
      ${buildFilterClauses(filters).map((c) => `AND ${c}`).join('\n      ')}
    ORDER BY Name ASC
  `.trim()

  const records: RawAccount[] = []
  let nextPath: string | null = `/services/data/v59.0/query?q=${encodeURIComponent(soql)}`

  while (nextPath) {
    const page: SfdcPage = await axios
      .get<SfdcPage>(`${conn.instanceUrl}${nextPath}`, {
        headers: { Authorization: `Bearer ${conn.accessToken!}` },
        timeout: 20_000,
      })
      .then((r) => r.data)
    records.push(...page.records)
    nextPath = page.done ? null : (page.nextRecordsUrl ?? null)
  }

  return records.map((r) => ({
    accountId: r.Id,
    accountName: r.Name,
    website: r.Website,
    description: r.Company_Description__c,
    industry: r.Industry,
    subIndustry: r.Sub_Industry__c,
    numberOfLocations: r.Number_of_locations__c,
    currentLocations: r.Current_Locations__c,
    ultimateParentLocations: r.Ultimate_Parent_Number_of_Locations__c,
    icpIppFit: r.BATCH_TAM__c,
    icpIppFitRating: r.ICP_IPP_Fit_Rating__c,
    icp: r.ICP__c,
    accountStage: r.Account_Stage__c,
    prospectingStatus: r.Prospecting_Status__c,
    prospectingPauseReason: r.Prospecting_Pause_Reason__c,
    duplicateFlag: r.Rep_Flagged_Duplicate__c === true,
    parentId: r.ParentId,
    parentName: r.Parent?.Name ?? null,
    ultimateParent: r.Ultimate_Parent_Account__c,
    lastRepCommunicationDate: r.Last_Rep_Communication_Date__c,
    billingCountry: r.BillingCountry,
    operatingModel: r.Operating_Model_s__c,
    productFit: r.Product_Fit__c,
    productFitRationale: r.Product_Fit_Rationale__c,
  }))
}

// ─── Picklist options ────────────────────────────────────────────────────────
// Served to the rep portal so the dropdowns can't drift from Salesforce.
//
// Cached in-process for 5 minutes. It was an hour on the theory that picklists
// change very rarely, but that made adding a value in Setup look broken in the
// portal for up to an hour. A describe is cheap; being confusing is not.

export interface PicklistOption {
  value: string
  label: string
}

export interface AccountPicklists {
  industry: string[]
  icpIppFitRating: string[]
  operatingModel: string[]
  /**
   * Value + label, because these diverge on this field: the option shown as
   * "No Fit" is stored as `No Need`. Records hold the value, so the UI needs the
   * mapping to avoid displaying a term nobody uses in Salesforce any more.
   */
  productFit: PicklistOption[]
}

const PICKLIST_TTL_MS = 5 * 60 * 1000
let _picklistCache: { at: number; data: AccountPicklists } | null = null

export async function getAccountPicklists(): Promise<AccountPicklists> {
  if (_picklistCache && Date.now() - _picklistCache.at < PICKLIST_TTL_MS) {
    return _picklistCache.data
  }

  const conn = await getServiceConnection()
  const meta = await conn.sobject('Account').describe()

  const valuesFor = (apiName: string): string[] => {
    const field = meta.fields.find((f) => f.name === apiName)
    return (field?.picklistValues ?? [])
      .filter((v) => v.active)
      .map((v) => v.value)
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
  }

  const optionsFor = (apiName: string): PicklistOption[] => {
    const field = meta.fields.find((f) => f.name === apiName)
    return (field?.picklistValues ?? [])
      .filter((v) => v.active && typeof v.value === 'string' && v.value.length > 0)
      .map((v) => ({ value: v.value as string, label: v.label || (v.value as string) }))
  }

  const data: AccountPicklists = {
    industry: valuesFor('Industry'),
    icpIppFitRating: valuesFor('ICP_IPP_Fit_Rating__c'),
    operatingModel: valuesFor('Operating_Model_s__c'),
    productFit: optionsFor('Product_Fit__c'),
  }
  _picklistCache = { at: Date.now(), data }
  return data
}

export interface DispositionInput {
  disposition: Disposition
  subReason?: NoIcpSubReason | null
  feedback?: string | null
  /** Corrections the rep made inline. Only written when present. */
  industry?: string | null
  subIndustry?: string | null
  parentId?: string | null
  numberOfLocations?: number | null
  /**
   * Rep's validated Operating_Model_s__c. Collected on both "keep it" verdicts.
   * (ICP_IPP_Fit_Rating__c used to be collected here too; the disposition now
   * implies the priority, so there's no rating to pick.)
   */
  operatingModel?: string | null
  /**
   * Rep's edit to Product_Fit_Rationale__c. `undefined`/null leaves the field
   * untouched; a string (including empty, which clears it) is written.
   */
  productFitRationale?: string | null
  /**
   * Rep nominated the account for next month's BDR focus list. Only offered on
   * GOOD_LEAVE_IN_TERRITORY — nominating an account you've just disqualified
   * makes no sense.
   */
  nominateForBdrFocus?: boolean
}

/**
 * Prospecting statuses a BDR nomination is allowed to overwrite: blank, or on
 * hold. `Prospecting`, `Nurturing` and `Success` describe work already underway,
 * and rewinding them to `Planned` would lose that.
 */
const NOMINATABLE_PROSPECTING_STATUSES = new Set(['', 'Hold'])

/**
 * The 2nd of next month as `YYYY-MM-DD`, the date the BDR focus list works from.
 *
 * Built from UTC parts and formatted by hand rather than via `toISOString()` on a
 * local-time Date, which would shift the day either side of midnight. Month 12
 * overflows into January of the next year on its own, which is what we want.
 */
export function nextMonthSecond(now: Date = new Date()): string {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() + 1 // 0-indexed -> next month, still 0-indexed
  const target = new Date(Date.UTC(y, m, 2))
  const mm = String(target.getUTCMonth() + 1).padStart(2, '0')
  return `${target.getUTCFullYear()}-${mm}-02`
}

/**
 * Product Fit implied by each disposition.
 *
 * These are API values, which is what the REST API writes — not Setup labels. The
 * two mostly match on this picklist, but not always: the option displayed as
 * "No Fit" is still stored as `No Need`. `Strong Fit` was `Structural Need` until
 * the picklist was renamed, and existing records were migrated at that time.
 *
 * Dispositions absent from this map leave Product Fit alone — DUPLICATE and the
 * DECISION_ON_* pair say something about the record or the hierarchy, not about
 * whether the product fits.
 */
export const PRODUCT_FIT_STRONG = 'Strong Fit'
export const PRODUCT_FIT_PARTIAL = 'Partial Fit'
export const PRODUCT_FIT_NONE = 'No Need'

export const PRODUCT_FIT_BY_DISPOSITION: Partial<Record<Disposition, string>> = {
  GOOD_LEAVE_IN_TERRITORY: PRODUCT_FIT_STRONG,
  USE_CASE_LOW_PRIORITY: PRODUCT_FIT_PARTIAL,
  NO_ICP: PRODUCT_FIT_NONE,
}

/**
 * Where a "No fit" account goes, by reason.
 *
 * Reassigning the owner is what removes it from the rep's territory: the queue
 * filters on `Owner.Email`, and separately excludes these two owners by name, so a
 * routed account drops off every rep's list rather than just moving between them.
 *
 * Shark Tank re-works accounts later; Grave Yard is the end of the line. TOO_SMALL
 * deliberately keeps the Enterprise record type — the account is real and may grow
 * into ICP, it's just mis-sized today, and the rep corrects the count on the way
 * through. PARTNER is the only reason that changes record type.
 */
const SHARK_TANK = 'Shark Tank'
const GRAVE_YARD = 'Grave Yard'
const PARTNER_RECORD_TYPE = 'Partner Account Record'

const NO_ICP_ROUTING: Record<
  NoIcpSubReason,
  { ownerName: string; recordTypeName?: string }
> = {
  TOO_SMALL: { ownerName: SHARK_TANK },
  JUNK: { ownerName: GRAVE_YARD },
  PARTNER: { ownerName: SHARK_TANK, recordTypeName: PARTNER_RECORD_TYPE },
  DEFUNCT: { ownerName: GRAVE_YARD },
}

export interface NoIcpRouting {
  ownerId: string
  /** Only set when the reason changes record type, i.e. PARTNER. */
  recordTypeId?: string
}

/**
 * Ids are resolved by name at runtime rather than hardcoded, so this keeps working
 * against a sandbox and breaks loudly instead of silently writing a dead id if
 * someone renames or deactivates one of these. Cached for an hour — they change
 * about never.
 */
const ROUTING_TTL_MS = 60 * 60 * 1000
let routingCache: { at: number; ownerIds: Map<string, string>; recordTypeIds: Map<string, string> } | null =
  null

async function getRoutingIds() {
  if (routingCache && Date.now() - routingCache.at < ROUTING_TTL_MS) return routingCache

  const conn = await getServiceConnection()
  const names = [SHARK_TANK, GRAVE_YARD].map((n) => `'${soqlEscape(n)}'`).join(', ')

  const users = await conn.query<{ Id: string; Name: string }>(
    `SELECT Id, Name FROM User WHERE Name IN (${names}) AND IsActive = true`,
  )
  const recordTypes = await conn.query<{ Id: string; Name: string }>(
    `SELECT Id, Name FROM RecordType WHERE SobjectType = 'Account' AND IsActive = true`,
  )

  routingCache = {
    at: Date.now(),
    ownerIds: new Map(users.records.map((u) => [u.Name, u.Id])),
    recordTypeIds: new Map(recordTypes.records.map((r) => [r.Name, r.Id])),
  }
  return routingCache
}

/** Throws rather than returning a partial route — see the caller for why. */
export async function resolveNoIcpRouting(subReason: NoIcpSubReason): Promise<NoIcpRouting> {
  const { ownerName, recordTypeName } = NO_ICP_ROUTING[subReason]
  const ids = await getRoutingIds()

  const ownerId = ids.ownerIds.get(ownerName)
  if (!ownerId) {
    throw new Error(`Could not find an active Salesforce user named "${ownerName}"`)
  }

  if (!recordTypeName) return { ownerId }

  const recordTypeId = ids.recordTypeIds.get(recordTypeName)
  if (!recordTypeId) {
    throw new Error(`Could not find an active Account record type named "${recordTypeName}"`)
  }
  return { ownerId, recordTypeId }
}

/**
 * Current SFDC values that affect what we write, read just before the update:
 * "set Product Fit unless it's already right", and "only promote prospecting
 * status to Planned from blank or Hold".
 */
export interface DispositionContext {
  productFit?: string | null
  prospectingStatus?: string | null
  /** Resolved owner / record type for a NO_ICP reason. Absent for every other. */
  routing?: NoIcpRouting
}

/**
 * Translate a rep's answer into the exact set of SFDC Account fields to write.
 * Kept pure and separate from the HTTP layer so it's straightforward to test
 * and to eyeball against the agreed mapping.
 *
 * Deliberately does NOT touch Close_Reason__c.
 */
export function buildDispositionFields(
  input: DispositionInput,
  feedbackField: string,
  current: DispositionContext = {},
  now: Date = new Date(),
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}

  // Inline corrections apply to any disposition the rep made them on.
  if (input.industry) fields.Industry = input.industry
  if (input.subIndustry) fields.Sub_Industry__c = input.subIndustry
  if (input.parentId) fields.ParentId = input.parentId
  if (typeof input.numberOfLocations === 'number' && Number.isFinite(input.numberOfLocations)) {
    fields.Number_of_locations__c = input.numberOfLocations
  }

  switch (input.disposition) {
    case 'GOOD_LEAVE_IN_TERRITORY':
      // Stays in territory, but the rep validates the operating model on the way
      // through — it's blank on ~60% of prospects.
      if (input.operatingModel) fields.Operating_Model_s__c = input.operatingModel

      if (input.nominateForBdrFocus) {
        // The date is the nomination: it's what the focus list is built from, so
        // it's set whatever the current status.
        fields.Target_Prospecting_Date__c = nextMonthSecond(now)

        // The status only moves up from "nobody's on this" or "parked". An account
        // already being prospected or nurtured is further along than Planned.
        // `undefined` means we couldn't read it, and guessing risks demoting a live
        // account, so we leave the status alone and let the date carry the signal.
        if (
          current.prospectingStatus !== undefined &&
          NOMINATABLE_PROSPECTING_STATUSES.has(current.prospectingStatus ?? '')
        ) {
          fields.Prospecting_Status__c = 'Planned'
          // A pause reason surviving the un-pause would leave the account looking
          // both planned and on hold, and the hygiene alerts read this field.
          if (current.prospectingStatus === 'Hold') {
            fields.Prospecting_Pause_Reason__c = null
          }
        }
      }
      break

    case 'USE_CASE_LOW_PRIORITY':
      // The verdict itself carries the priority (Product Fit -> Partial Fit below),
      // so there's no rating to pick. The rep validates the operating model and says
      // why it's only a partial fit.
      if (input.operatingModel) fields.Operating_Model_s__c = input.operatingModel
      break

    case 'NO_ICP':
      fields.Account_Stage__c = 'Disqualified'
      fields.Prospecting_Pause_Reason__c = 'Not ICP'
      // Hand the account off. The reason decides where — see NO_ICP_ROUTING.
      if (current.routing) {
        fields.OwnerId = current.routing.ownerId
        if (current.routing.recordTypeId) {
          fields.RecordTypeId = current.routing.recordTypeId
        }
      }
      break

    case 'DUPLICATE':
      // Rep-asserted, not the dupcheck package's Potential Duplicate Flag
      // (Duplicate_Flag__c) — that one belongs to other automation.
      fields.Rep_Flagged_Duplicate__c = true
      break

    case 'DECISION_ON_PARENT':
      fields.Prospecting_Status__c = 'Hold'
      fields.Prospecting_Pause_Reason__c = 'Decision on parent'
      break

    case 'DECISION_ON_CHILD':
      fields.Prospecting_Status__c = 'Hold'
      fields.Prospecting_Pause_Reason__c = 'Decision on child'
      break

    case 'OTHER':
      // Feedback text only.
      break
  }

  // Product Fit follows the rep's verdict: good account -> Strong Fit, use case
  // but weak ICP -> Partial Fit, no ICP -> No Fit. Skipped when it already says
  // that, so a re-save doesn't touch the record or bump LastModified.
  const targetProductFit = PRODUCT_FIT_BY_DISPOSITION[input.disposition]
  if (targetProductFit && current.productFit !== targetProductFit) {
    fields.Product_Fit__c = targetProductFit
  }

  // The "why" behind Product Fit, in its own field rather than the feedback one.
  // Only sent when the rep actually edited it, so an untouched rationale is left
  // alone instead of being rewritten with itself.
  if (typeof input.productFitRationale === 'string') {
    fields.Product_Fit_Rationale__c = input.productFitRationale.trim() || null
  }

  // Feedback field carries the rep's free text, prefixed with the NO_ICP
  // sub-reason when there is one (those four reasons have no picklist home).
  //
  // This deliberately OVERWRITES rather than appends. The field is being
  // repurposed as "Data Feedback" and the rep's answer is meant to be the current
  // state of it, not another entry in a log — whatever a prior automation left
  // there is exactly what we want gone. Decided deliberately; don't "fix" it.
  const parts: string[] = []
  if (input.disposition === 'NO_ICP' && input.subReason) {
    parts.push(`[${SUB_REASON_LABEL[input.subReason]}]`)
  }
  if (input.feedback?.trim()) parts.push(input.feedback.trim())
  if (parts.length) fields[feedbackField] = parts.join(' ')

  return fields
}

export interface ApplyResult {
  ok: boolean
  fields: Record<string, unknown>
  error?: string
}

/**
 * Read the handful of current values that change what we write. Only the three
 * dispositions that imply a Product Fit need it, so the rest skip the round trip.
 *
 * A failed read is not fatal: we fall back to an empty context, which means
 * Product Fit gets written unconditionally. Writing the value we already intended
 * is the safe direction — and if Salesforce is unreachable the update that
 * follows will fail loudly anyway. Prospecting status is the exception: there an
 * unknown value makes us skip the write rather than risk demoting a live account.
 */
async function fetchDispositionContext(
  accountId: string,
  disposition: Disposition,
): Promise<DispositionContext> {
  if (!PRODUCT_FIT_BY_DISPOSITION[disposition]) return {}
  try {
    const conn = await getServiceConnection()
    const result = await conn.query<{
      Product_Fit__c: string | null
      Prospecting_Status__c: string | null
    }>(
      `SELECT Product_Fit__c, Prospecting_Status__c FROM Account WHERE Id = '${soqlEscape(accountId)}' LIMIT 1`,
    )
    const record = result.records[0]
    // No record is a genuine unknown, not a set of blanks — return nothing so the
    // callers that distinguish the two can. The update will fail on its own merits.
    if (!record) return {}
    return {
      productFit: record.Product_Fit__c ?? null,
      prospectingStatus: record.Prospecting_Status__c ?? null,
    }
  } catch (err) {
    console.warn(
      `[TerritoryCleanup] could not read current Account state for ${accountId}:`,
      (err as Error).message,
    )
    return {}
  }
}

export async function applyDisposition(
  accountId: string,
  accountName: string,
  rep: { id: string; email: string },
  input: DispositionInput,
): Promise<ApplyResult> {
  const feedbackField = await getFeedbackField()
  const current = await fetchDispositionContext(accountId, input.disposition)

  // Resolving the handoff target has to succeed before anything is written.
  // Disqualifying the account but leaving it sitting in the rep's territory is a
  // worse state than not saving at all, and it's one nobody would notice — so bail
  // out and let the rep retry instead.
  if (input.disposition === 'NO_ICP' && input.subReason) {
    try {
      current.routing = await resolveNoIcpRouting(input.subReason)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[TerritoryCleanup] routing lookup failed for ${accountId}:`, message)
      return { ok: false, fields: {}, error: message }
    }
  }

  const fields = buildDispositionFields(input, feedbackField, current)

  let sfdcWrittenAt: Date | null = null
  let sfdcError: string | null = null

  if (Object.keys(fields).length > 0) {
    try {
      const conn = await getServiceConnection()
      await conn.sobject('Account').update({ Id: accountId, ...fields } as never)
      sfdcWrittenAt = new Date()
    } catch (err) {
      sfdcError = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      console.error(`[TerritoryCleanup] SFDC write failed for ${accountId}:`, sfdcError)
    }
  } else {
    // Nothing to write (e.g. GOOD_LEAVE_IN_TERRITORY with no corrections and no
    // feedback). Still record the validation so it leaves the rep's queue.
    sfdcWrittenAt = new Date()
  }

  await db.territoryValidation.upsert({
    where: { accountId_repId: { accountId, repId: rep.id } },
    create: {
      accountId,
      accountName,
      repId: rep.id,
      repEmail: rep.email,
      disposition: input.disposition,
      subReason: input.subReason ?? null,
      feedback: input.feedback?.trim() || null,
      sfdcWrittenAt,
      sfdcFields: fields as never,
      sfdcError,
    },
    update: {
      disposition: input.disposition,
      subReason: input.subReason ?? null,
      feedback: input.feedback?.trim() || null,
      sfdcWrittenAt,
      sfdcFields: fields as never,
      sfdcError,
    },
  })

  return { ok: sfdcError === null, fields, error: sfdcError ?? undefined }
}
