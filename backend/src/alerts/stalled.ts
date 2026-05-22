import type { SfdcOpportunity } from '../services/salesforce'
import type { GongActivity, GongWarning } from '../services/gong'
import { isSingleThreaded, hasRedFlags, daysSinceLastGongActivity } from '../services/gong'
import { AlertType } from '@prisma/client'

export interface StalledAlert {
  alertType: AlertType.STALLED
  opportunityId: string
  opportunityName: string
  ownerSfdcId: string
  ownerEmail: string
  dealAgeDays: number
  stageDurationDays: number | null
  stage: string
  triggeredBy: StalledReason[]
  ruleId: string
}

export type StalledReason =
  | { type: 'deal_age'; days: number; threshold: number }
  | { type: 'stage_duration'; days: number; threshold: number }
  | { type: 'gong_inactivity'; days: number; threshold: number }
  | { type: 'single_threaded' }
  | { type: 'red_flag'; descriptions: string[] }

interface StallRule {
  id: string
  dealAgeThresholdDays: number | null
  stageDurationThresholdDays: number | null
  gongInactivityDays: number | null
  flagSingleThreaded: boolean
  flagGongRedFlags: boolean
  filterStages: string[]
  filterOppTypes: string[]
  filterSegments: string[]
}

function dealAgeDays(opp: SfdcOpportunity): number {
  return Math.floor((Date.now() - new Date(opp.CreatedDate).getTime()) / (1000 * 60 * 60 * 24))
}

function stageDurationDays(opp: SfdcOpportunity): number | null {
  if (!opp.StageEntryDate__c) return null
  return Math.floor(
    (Date.now() - new Date(opp.StageEntryDate__c).getTime()) / (1000 * 60 * 60 * 24)
  )
}

function matchesFilters(opp: SfdcOpportunity, rule: StallRule): boolean {
  if (rule.filterStages.length > 0 && !rule.filterStages.includes(opp.StageName)) return false
  if (rule.filterOppTypes.length > 0 && !rule.filterOppTypes.includes(opp.Type ?? '')) return false
  if (
    rule.filterSegments.length > 0 &&
    !rule.filterSegments.includes(opp.Account?.Segment__c ?? '')
  )
    return false
  return true
}

export function evaluateStalled(
  opps: SfdcOpportunity[],
  rules: StallRule[],
  gongActivity: Map<string, GongActivity>,
  gongWarnings: Map<string, GongWarning[]>
): StalledAlert[] {
  const alerts: StalledAlert[] = []

  for (const opp of opps) {
    if (opp.IsClosed) continue

    for (const rule of rules) {
      if (!matchesFilters(opp, rule)) continue

      const reasons: StalledReason[] = []
      const age = dealAgeDays(opp)
      const stageDays = stageDurationDays(opp)
      const activity = gongActivity.get(opp.Id)
      const warnings = gongWarnings.get(opp.Id) ?? []

      if (rule.dealAgeThresholdDays && age >= rule.dealAgeThresholdDays) {
        reasons.push({ type: 'deal_age', days: age, threshold: rule.dealAgeThresholdDays })
      }

      if (rule.stageDurationThresholdDays && stageDays !== null && stageDays >= rule.stageDurationThresholdDays) {
        reasons.push({ type: 'stage_duration', days: stageDays, threshold: rule.stageDurationThresholdDays })
      }

      if (rule.gongInactivityDays && activity) {
        const inactive = daysSinceLastGongActivity(activity)
        if (inactive !== null && inactive >= rule.gongInactivityDays) {
          reasons.push({ type: 'gong_inactivity', days: inactive, threshold: rule.gongInactivityDays })
        }
      }

      if (rule.flagSingleThreaded && activity && isSingleThreaded(activity)) {
        reasons.push({ type: 'single_threaded' })
      }

      if (rule.flagGongRedFlags && hasRedFlags(warnings)) {
        reasons.push({
          type: 'red_flag',
          descriptions: warnings.filter((w) => w.severity === 'high').map((w) => w.description),
        })
      }

      if (reasons.length > 0) {
        alerts.push({
          alertType: AlertType.STALLED,
          opportunityId: opp.Id,
          opportunityName: opp.Name,
          ownerSfdcId: opp.OwnerId,
          ownerEmail: opp.Owner.Email,
          dealAgeDays: age,
          stageDurationDays: stageDays,
          stage: opp.StageName,
          triggeredBy: reasons,
          ruleId: rule.id,
        })
        break // one alert per opp (first matching rule wins)
      }
    }
  }

  return alerts
}
