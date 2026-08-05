import { toCsv } from '../utils/csv'

const SFDC_BASE = 'https://uberall.lightning.force.com'

/** The subset of a TerritoryValidation row the export needs. */
export interface ValidationRow {
  accountId: string
  accountName: string
  repEmail: string
  disposition: string
  subReason: string | null
  feedback: string | null
  createdAt: Date
  sfdcWrittenAt: Date | null
  sfdcError: string | null
  sfdcFields: unknown
}

export const VALIDATION_CSV_HEADERS = [
  'Account ID',
  'Account Name',
  'Salesforce URL',
  'Rep Email',
  'Disposition',
  'Sub Reason',
  'Rep Note',
  'Status',
  'Submitted At',
  'SFDC Written At',
  'SFDC Error',
  // The individual writes, so a human can redo them by hand if needed.
  'Owner ID',
  'Record Type ID',
  'Account Stage',
  'Product Fit',
  'Product Fit Rationale',
  'Operating Model',
  'Prospecting Status',
  'Prospecting Pause Reason',
  'Target Prospecting Date',
  'Number of Locations',
  'Industry',
  'Parent ID',
  'Rep Flagged Duplicate',
  'BATCH TAM',
  // Everything, verbatim — a safety net if a field is added and the columns lag.
  'Full Payload (JSON)',
]

export const NOT_WRITTEN = 'NOT WRITTEN — needs fixing'

/**
 * Flattens validations into spreadsheet rows. `sfdcFields` holds whatever
 * `buildDispositionFields` produced, so the named columns are best-effort — the
 * JSON column is the guarantee that nothing is lost.
 */
export function buildValidationRows(rows: ValidationRow[]): unknown[][] {
  return rows.map((r) => {
    const f = (r.sfdcFields ?? {}) as Record<string, unknown>
    return [
      r.accountId,
      r.accountName,
      `${SFDC_BASE}/lightning/r/Account/${r.accountId}/view`,
      r.repEmail,
      r.disposition,
      r.subReason,
      r.feedback,
      r.sfdcWrittenAt ? 'Written to Salesforce' : NOT_WRITTEN,
      r.createdAt,
      r.sfdcWrittenAt,
      r.sfdcError,
      f.OwnerId,
      f.RecordTypeId,
      f.Account_Stage__c,
      f.Product_Fit__c,
      f.Product_Fit_Rationale__c,
      f.Operating_Model_s__c,
      f.Prospecting_Status__c,
      f.Prospecting_Pause_Reason__c,
      f.Target_Prospecting_Date__c,
      f.Number_of_locations__c,
      f.Industry,
      f.ParentId,
      f.Rep_Flagged_Duplicate__c,
      f.BATCH_TAM__c,
      JSON.stringify(f),
    ]
  })
}

export function buildValidationCsv(rows: ValidationRow[]): string {
  return toCsv(VALIDATION_CSV_HEADERS, buildValidationRows(rows))
}
