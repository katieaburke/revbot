// Salesforce API stage name → display label mapping for Uberall's org
// API names are what Salesforce returns in SOQL; labels are what's shown in the UI
// and what's stored in rule configuration.

const WORD_TO_LABEL: Record<string, string> = {
  'Conversation': 'Qualification',
  'Interest':     'Discovery',
  'Demo':         'Custom Demo',
  'Proposal':     'Presentation/Proposal',
  'Negotiation':  'Decision/Negotiation',
  'Commitment':   'Legal/Procurement',
}

/**
 * Convert a Salesforce API stage name to the display label used in rules.
 * Handles stage names with number prefixes like "1 – Conversation", "1 - Conversation", etc.
 * by stripping the leading number and any dash variant before looking up the label.
 */
export function stageApiToLabel(apiName: string): string {
  // Strip leading "N – " / "N - " / "N — " prefix (any dash variant)
  const stripped = apiName.replace(/^\d+\s*[–—\-]+\s*/, '').trim()
  return WORD_TO_LABEL[stripped] ?? WORD_TO_LABEL[apiName] ?? apiName
}
