// Salesforce API stage name → display label mapping for Uberall's org
// API names are what Salesforce returns in SOQL; labels are what's shown in the UI
// and what's stored in rule configuration.

export const STAGE_API_TO_LABEL: Record<string, string> = {
  '1 – Conversation': 'Qualification',
  '3 – Interest':     'Discovery',
  '4 – Demo':         'Custom Demo',
  '5 – Proposal':     'Presentation/Proposal',
  '6 – Negotiation':  'Decision/Negotiation',
  '7 – Commitment':   'Legal/Procurement',
  // Fallbacks without number prefix
  'Conversation': 'Qualification',
  'Interest':     'Discovery',
  'Demo':         'Custom Demo',
  'Proposal':     'Presentation/Proposal',
  'Negotiation':  'Decision/Negotiation',
  'Commitment':   'Legal/Procurement',
}

/** Convert a Salesforce API stage name to the display label used in rules */
export function stageApiToLabel(apiName: string): string {
  return STAGE_API_TO_LABEL[apiName] ?? apiName
}
