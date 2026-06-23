import { AlertType } from '../types'

export interface StageMismatchRuleConfig {
  id: string
  name: string
  keywords: string[]
  stages: string[]
  enabled: boolean
}

export interface StageMismatchAlert {
  alertType: AlertType.STAGE_MISMATCH
  opportunityId: string
  opportunityName: string
  ownerSfdcId: string
  ownerEmail: string
  oppType: string
  stage: string
  nextStep: string
  matchedKeywords: string[]
  ruleName: string
}

export function evaluateStageMismatch(
  opps: any[],
  rules: StageMismatchRuleConfig[]
): StageMismatchAlert[] {
  const alerts: StageMismatchAlert[] = []
  const activeRules = rules.filter((r) => r.enabled)

  // Log unique stage names coming from Salesforce to help debug mismatches
  const uniqueStages = Array.from(new Set(opps.map((o) => o.StageName).filter(Boolean)))
  console.log('[StageMismatch] Salesforce stage names:', uniqueStages.sort().join(', '))

  for (const opp of opps) {
    const nextStep = (opp.NextStep ?? '').toLowerCase()
    if (!nextStep) continue

    const stage = opp.StageName ?? ''
    const oppType = opp.Type ?? ''

    for (const rule of activeRules) {
      if (!rule.stages.includes(stage)) continue

      const matchedKeywords = rule.keywords.filter((kw) =>
        nextStep.includes(kw.toLowerCase())
      )
      if (matchedKeywords.length === 0) continue

      alerts.push({
        alertType: AlertType.STAGE_MISMATCH,
        opportunityId: opp.Id,
        opportunityName: opp.Name,
        ownerSfdcId: opp.OwnerId,
        ownerEmail: opp.Owner?.Email ?? '',
        oppType,
        stage,
        nextStep: opp.NextStep ?? '',
        matchedKeywords,
        ruleName: rule.name,
      })
      break // one alert per opp max
    }
  }

  return alerts
}
