import axios from 'axios'
import { getServiceConnection } from './salesforce'
import { db } from '../db'

// ─── Territory Cleanup ───────────────────────────────────────────────────────
//
// Queues up Prospect accounts that no rep has touched this year and asks the
// owning AE to validate them. Criteria mirror SFDC report 00OW600000ESj29MAD
// ("Prospect Accounts - Data Request" / Prospect_Accounts_USCAN_No_Activity):
//
//   Account_Stage__c            = 'Prospect'
//   RecordType.Name             = 'Enterprise Account Record'
//   Owner.Name                  not like %grave% / %shark%  (Graveyard, Shark Tank)
//   Last_Rep_Communication_Date__c  not this year (or blank)
//   Owner role rollup           contains 'New Business'
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
  industry: string | null
  subIndustry: string | null
  numberOfLocations: number | null
  currentLocations: number | null
  ultimateParentLocations: number | null
  /** BATCH_TAM__c — label "ICP/IPP Fit" */
  icpIppFit: string | null
  /** ICP_IPP_Fit_Rating__c — the 1-5 / Insufficient scoring field */
  icpIppFitRating: string | null
  icp: string | null
  accountStage: string | null
  prospectingStatus: string | null
  prospectingPauseReason: string | null
  duplicateFlag: boolean
  parentId: string | null
  parentName: string | null
  ultimateParent: string | null
  lastRepCommunicationDate: string | null
  billingCountry: string | null
}

/**
 * Only New Business AEs get the Territory Cleanup tab. Role names look like:
 *   CCO/Direct/US-CAN/New Business/Sales/Enterprise/Rep   <- AE, included
 *   CCO/Direct/EMEA/New Business/Sales/A/Enterprise/Rep   <- AE, included
 *   CCO/Direct/US-CAN/New Business/BDR/Enterprise/Rep     <- BDR, excluded
 */
export function isAccountExecutive(repRole: string | null | undefined): boolean {
  if (!repRole) return false
  const r = repRole.toLowerCase()
  if (r.includes('/bdr/') || r.includes('/bdr')) return false
  return r.includes('new business') && r.includes('/sales')
}

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
  'Duplicate_Flag__c',
  'ParentId',
  'Parent.Name',
  'Ultimate_Parent_Account__c',
  'Last_Rep_Communication_Date__c',
  'BillingCountry',
].join(', ')

interface RawAccount {
  Id: string
  Name: string
  Website: string | null
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
  Duplicate_Flag__c: boolean | null
  ParentId: string | null
  Parent: { Name: string } | null
  Ultimate_Parent_Account__c: string | null
  Last_Rep_Communication_Date__c: string | null
  BillingCountry: string | null
}

interface SfdcPage {
  records: RawAccount[]
  done: boolean
  nextRecordsUrl?: string
}

/**
 * Fetch the rep's un-validated territory accounts. Pages through all results —
 * a single rep's slice is typically a few hundred accounts, but we don't want a
 * silent truncation at SFDC's 2000-record page limit.
 */
export async function fetchTerritoryAccounts(repEmail: string): Promise<TerritoryAccount[]> {
  const conn = await getServiceConnection()

  const soql = `
    SELECT ${ACCOUNT_FIELDS}
    FROM Account
    WHERE Account_Stage__c = 'Prospect'
      AND RecordType.Name = 'Enterprise Account Record'
      AND (NOT Owner.Name LIKE '%grave%')
      AND (NOT Owner.Name LIKE '%shark%')
      AND (Last_Rep_Communication_Date__c < THIS_YEAR OR Last_Rep_Communication_Date__c = null)
      AND Owner.Email = '${soqlEscape(repEmail)}'
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
    duplicateFlag: r.Duplicate_Flag__c === true,
    parentId: r.ParentId,
    parentName: r.Parent?.Name ?? null,
    ultimateParent: r.Ultimate_Parent_Account__c,
    lastRepCommunicationDate: r.Last_Rep_Communication_Date__c,
    billingCountry: r.BillingCountry,
  }))
}

// ─── Picklist options ────────────────────────────────────────────────────────
// Served to the rep portal so the dropdowns can't drift from Salesforce.
// Cached in-process for an hour — these change very rarely.

export interface AccountPicklists {
  industry: string[]
  icpIppFitRating: string[]
}

const PICKLIST_TTL_MS = 60 * 60 * 1000
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

  const data: AccountPicklists = {
    industry: valuesFor('Industry'),
    icpIppFitRating: valuesFor('ICP_IPP_Fit_Rating__c'),
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
  /** Rep's 1-5 / Insufficient pick for USE_CASE_LOW_PRIORITY. */
  icpIppFitRating?: string | null
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
      // Stays in territory as-is. Only the corrections above plus feedback.
      break

    case 'USE_CASE_LOW_PRIORITY':
      // Rep sets the 1-5 fit rating; BATCH_TAM__c ("ICP/IPP Fit") is set to ICP.
      if (input.icpIppFitRating) fields.ICP_IPP_Fit_Rating__c = input.icpIppFitRating
      fields.BATCH_TAM__c = 'ICP'
      break

    case 'NO_ICP':
      fields.Account_Stage__c = 'Disqualified'
      fields.BATCH_TAM__c = 'NO ICP'
      fields.Prospecting_Pause_Reason__c = 'Not ICP'
      break

    case 'DUPLICATE':
      fields.Duplicate_Flag__c = true
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

  // Feedback field carries the rep's free text, prefixed with the NO_ICP
  // sub-reason when there is one (those four reasons have no picklist home).
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

/** Write the disposition to SFDC and record the validation locally. */
export async function applyDisposition(
  accountId: string,
  accountName: string,
  rep: { id: string; email: string },
  input: DispositionInput,
): Promise<ApplyResult> {
  const feedbackField = await getFeedbackField()
  const fields = buildDispositionFields(input, feedbackField)

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
