import { AlertType } from '../types'
import { stageApiToLabel } from '../utils/stageMapping'

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

  const oppsWithNextStep = opps.filter((o) => o.NextStep?.trim())

  for (const opp of opps) {
    const nextStep = (opp.NextStep ?? '').toLowerCase()
    if (!nextStep) continue

    const stage = stageApiToLabel(opp.StageName ?? '')
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
