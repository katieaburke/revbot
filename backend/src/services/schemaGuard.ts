import { getServiceConnection } from './salesforce'

/**
 * Catches Salesforce schema drift before it reaches a user.
 *
 * The failure this exists for has already happened twice. Someone deletes a field in
 * Salesforce Setup — ICP_IPP_Fit_Rating__c and ICP__c, in the case we know about — and
 * nothing here notices, because the field is only named in a SELECT string. Salesforce
 * rejects a SELECT containing an unknown column outright: not the column, the entire
 * query. So every rep lost their whole Territory Cleanup queue over two fields the UI
 * never even rendered, and the error surfaced as a bare "Request failed with status
 * code 400".
 *
 * The check is deliberately a warning and not a hard failure. Refusing to boot on drift
 * would turn a degraded feature into a total outage, which is worse — and the deleted
 * field may well belong to a feature nobody is using today.
 */

interface CachedDescribe {
  fields: Set<string>
  expiresAt: number
}

// Describe calls are slow and the schema changes on human timescales, so an hour of
// staleness costs nothing. In-process only: this is advisory, and a per-instance cache
// avoids making Redis a dependency of a diagnostic.
const DESCRIBE_TTL_MS = 60 * 60 * 1000
const _describeCache = new Map<string, CachedDescribe>()

export function invalidateSchemaCache(): void {
  _describeCache.clear()
}

/** Field API names that exist on an sObject, lowercased for case-insensitive lookup. */
async function getObjectFields(sobject: string): Promise<Set<string>> {
  const cached = _describeCache.get(sobject)
  if (cached && cached.expiresAt > Date.now()) return cached.fields

  const conn = await getServiceConnection()
  // jsforce rather than a raw REST call: describe is not latency-critical and jsforce
  // refreshes the token transparently.
  const meta = await conn.sobject(sobject).describe()
  const fields = new Set(meta.fields.map((f) => f.name.toLowerCase()))
  _describeCache.set(sobject, { fields, expiresAt: Date.now() + DESCRIBE_TTL_MS })
  return fields
}

/**
 * Returns the subset of `fields` that no longer exist on `sobject`.
 *
 * Relationship paths (`Parent.Name`, `Owner.Email`) are checked only as far as the
 * lookup field itself, since validating the far side would mean describing every
 * related object. `Parent.Name` therefore checks that `ParentId` resolves — enough to
 * catch a deleted custom lookup, which is the realistic drift case.
 */
export async function findMissingFields(sobject: string, fields: string[]): Promise<string[]> {
  const existing = await getObjectFields(sobject)
  const missing: string[] = []

  for (const raw of fields) {
    const field = raw.trim()
    if (!field) continue

    if (field.includes('.')) {
      const [relationship] = field.split('.')
      const rel = relationship.toLowerCase()
      // A custom relationship `Foo__r` is backed by the field `Foo__c`; a standard one
      // like `Parent` is backed by `ParentId`.
      const backing = rel.endsWith('__r') ? `${rel.slice(0, -3)}__c` : `${rel}id`
      if (!existing.has(rel) && !existing.has(backing)) missing.push(field)
      continue
    }

    if (!existing.has(field.toLowerCase())) missing.push(field)
  }

  return missing
}

/**
 * A field list some feature depends on, registered so it can be checked without that
 * feature having to be run.
 */
export interface SchemaExpectation {
  /** What breaks if these go missing — this is what someone reads in the log. */
  feature: string
  sobject: string
  fields: string[]
}

const _expectations: SchemaExpectation[] = []

export function registerSchemaExpectation(expectation: SchemaExpectation): void {
  _expectations.push(expectation)
}

export interface SchemaDriftReport {
  feature: string
  sobject: string
  missing: string[]
}

/**
 * Checks every registered expectation. Returns only the entries with drift, so an
 * empty array means healthy.
 */
export async function checkSchemaDrift(): Promise<SchemaDriftReport[]> {
  const reports: SchemaDriftReport[] = []
  for (const exp of _expectations) {
    try {
      const missing = await findMissingFields(exp.sobject, exp.fields)
      if (missing.length) reports.push({ feature: exp.feature, sobject: exp.sobject, missing })
    } catch (err) {
      // Not being able to reach Salesforce is a different problem, already reported
      // elsewhere. Don't let a diagnostic turn it into a second, confusing one.
      console.warn(`[SchemaGuard] Could not check ${exp.sobject} for ${exp.feature}:`, (err as Error).message)
    }
  }
  return reports
}

/**
 * Fire-and-forget check for startup. Logs and never throws.
 *
 * Runs detached so a slow describe cannot delay the HTTP server coming online — the
 * same reason the Redis startup tasks in index.ts are deferred.
 */
export function reportSchemaDriftInBackground(): void {
  void (async () => {
    // Salesforce has to be connected first. On a cold boot it usually isn't yet, and a
    // failure here would be noise rather than signal.
    const reports = await checkSchemaDrift().catch(() => [])
    if (!reports.length) return
    for (const r of reports) {
      console.error(
        `[SchemaGuard] ${r.feature} references ${r.missing.length} field(s) that no longer exist on ` +
          `${r.sobject}: ${r.missing.join(', ')}. Any SOQL naming these will fail entirely, not partially.`,
      )
    }
  })()
}
