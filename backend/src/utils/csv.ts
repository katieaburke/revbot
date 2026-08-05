/**
 * Minimal RFC 4180 CSV writer. Exists so exports open cleanly in Excel and Google
 * Sheets without a dependency.
 */

/**
 * Quotes a single field.
 *
 * Beyond the usual comma/quote/newline rules, this guards two things that
 * specifically matter for Salesforce data:
 *
 * - Leading `=`, `+`, `-` or `@` are prefixed with a tab. Excel and Sheets treat
 *   those as formulas, so a feedback note starting "=see parent account" would
 *   otherwise render as a broken formula (and is the CSV-injection vector).
 * - CRLF is normalised to LF inside quoted fields so a multi-line rep note
 *   doesn't produce stray blank lines.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''

  let s = value instanceof Date ? value.toISOString() : String(value)
  s = s.replace(/\r\n?/g, '\n')

  if (/^[=+\-@]/.test(s)) s = `\t${s}`

  // Quote whenever a bare value would be ambiguous — including a leading tab,
  // which Excel otherwise eats.
  if (/[",\n\t]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/**
 * Builds a CSV document from a header row and body rows.
 *
 * Prefixed with a UTF-8 BOM: without it Excel on Windows mis-decodes non-ASCII
 * account names (a real problem for an EMEA-heavy territory).
 */
export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(',')]
  for (const row of rows) lines.push(row.map(csvCell).join(','))
  return `﻿${lines.join('\r\n')}\r\n`
}
