import type { SfdcOpportunity } from '../services/salesforce'
import { AlertType } from '../types'

export interface CloseDateRiskRule {
  stageName: string
  opportunityType: string
  daysThreshold: number
}

export interface CloseDateRiskAlert {
  alertType: AlertType
  opportunityId: string
  opportunityName: string
  ownerSfdcId: string
  ownerEmail: string
  oppType: string
  stage: string
  closeDate: string
  daysUntilClose: number
  daysThreshold: number
}

export function evaluateCloseDateRisk(
  opps: SfdcOpportunity[],
  rules: CloseDateRiskRule[]
): CloseDateRiskAlert[] {
  if (!rules.length) return []

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const alerts: CloseDateRiskAlert[] = []

  for (const opp of opps) {
    if (opp.IsClosed) continue
    if (!opp.CloseDate) continue

    const closeDate = new Date(opp.CloseDate)
    closeDate.setHours(0, 0, 0, 0)

    // Only flag future close dates (past-due handled by pastDue evaluator)
    if (closeDate < today) continue

    const daysUntilClose = Math.floor((closeDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
    const oppType = opp.Type ?? 'All'

    // Find the most specific matching rule: exact opp type > "All"
    const exactRule = rules.find(
      (r) => r.stageName === opp.StageName && r.opportunityType === oppType
    )
    const fallbackRule = rules.find(
      (r) => r.stageName === opp.StageName && r.opportunityType === 'All'
    )
    const rule = exactRule ?? fallbackRule
    if (!rule) continue

    if (daysUntilClose <= rule.daysThreshold) {
      alerts.push({
        alertType: AlertType.CLOSE_DATE_RISK,
        opportunityId: opp.Id,
        opportunityName: opp.Name,
        ownerSfdcId: opp.OwnerId,
        ownerEmail: opp.Owner?.Email ?? '',
        oppType,
        stage: opp.StageName,
        closeDate: opp.CloseDate,
        daysUntilClose,
        daysThreshold: rule.daysThreshold,
      })
    }
  }

  return alerts
}
