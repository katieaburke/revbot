/**
 * Rep role parsing.
 *
 * Salesforce UserRole rollup names encode region + business line + function, e.g.
 *   CCO/Direct/US-CAN/New Business/Sales/Enterprise/Rep
 *   CCO/Direct/US-CAN/New Business/BDR/Enterprise/Rep
 *   CCO/DirectCX/US-CAN/Existing Business/CX/AM/Enterprise/Rep
 *   CCO/Partner/Existing Business/Partner AM/Rep
 *
 * These predicates decide which rep portal tabs a user sees. They live in one
 * module on purpose — the rules are duplicated nowhere else, and the server owns
 * the decision so a client can't reveal a tab by flipping a flag.
 */

/**
 * New Business AEs only — excludes BDRs, who work the same accounts but don't
 * own territory decisions.
 */
export function isAccountExecutive(repRole: string | null | undefined): boolean {
  if (!repRole) return false
  const r = repRole.toLowerCase()
  if (r.includes('/bdr/') || r.includes('/bdr')) return false
  return r.includes('new business') && r.includes('/sales')
}

/**
 * Reps who own existing customers (AM / CSM / Partner AM). Whitespace is about
 * expanding accounts that already have product, so New Business roles are
 * excluded — their whitespace query returns nothing by definition, since it
 * filters out accounts owned by new business roles.
 */
export function isExistingBusiness(repRole: string | null | undefined): boolean {
  if (!repRole) return false
  return repRole.toLowerCase().includes('existing business')
}
