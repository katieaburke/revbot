/**
 * Escaping for values interpolated into SOQL string literals.
 *
 * This lived as a private helper in territoryCleanup.ts while three other call sites
 * hand-rolled `.replace(/'/g, "\\'")` inline. The inline version is wrong in a way
 * that only shows up on real data: it never escapes backslashes, so a value ending in
 * one turns the backslash into an escape for the closing quote and Salesforce rejects
 * the whole query with a MALFORMED_QUERY. Order matters here — backslashes first,
 * then quotes, or the backslashes this function itself inserts get doubled.
 */
export function soqlEscape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/** Convenience for the common case: a quoted, escaped SOQL string literal. */
export function soqlLiteral(v: string): string {
  return `'${soqlEscape(v)}'`
}

/** Builds an escaped `IN ('a', 'b')` list body. Returns `''` for an empty input. */
export function soqlInList(values: string[]): string {
  return values.map(soqlLiteral).join(', ')
}
