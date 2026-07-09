import type { SfdcOpportunity } from '../services/salesforce'
import type { GongOpportunityActivity } from '../services/gong'
import { isSingleThreaded, hasRedFlags, daysSinceLastGongCall } from '../services/gong'
import { AlertType } from '../types'
import { stageApiToLabel } from '../utils/stageMapping'

export interface StalledAlert {
  alertType: AlertType.STALLED
  opportunityId: string
  opportunityName: string
  ownerSfdcId: string
  ownerEmail: string
  dealAgeDays: number | null
  stageDurationDays: number | null
  stage: string
  triggeredBy: StalledReason[]
  ruleId: string
  nextStep: string | null
  nextStepDate: string | null
}

export type StalledReason =
  | { type: 'deal_age'; days: number; threshold: number }
  | { type: 'stage_duration'; days: number; threshold: number }
  | { type: 'gong_inactivity'; days: number; threshold: number }
  | { type: 'single_threaded' }
  | { type: 'red_flag'; phrases: string[] }

// StallThresholdByStage — per-stage rule with optional opp type override
interface StallThreshold {
  id: string
  stageName: string
  opportunityType: string
  enabled: boolean
  stageDurationThresholdDays: number | null
  dealAgeThresholdDays: number | null
}

// Legacy StallRule — complex rule with Gong checks and filters
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

function findThreshold(
  thresholds: StallThreshold[],
  stageName: string,
  opportunityType: string | null
): StallThreshold | undefined {
  // First try exact stage + type match
  if (opportunityType) {
    const exact = thresholds.find(
      (t) => t.stageName === stageName && t.opportunityType === opportunityType && t.enabled
    )
    if (exact) return exact
  }
  // Fall back to stage + "All"
  return thresholds.find((t) => t.stageName === stageName && t.opportunityType === 'All' && t.enabled)
}

function matchesFilters(opp: SfdcOpportunity, rule: StallRule): boolean {
  if (rule.filterStages.length > 0 && !rule.filterStages.includes(stageApiToLabel(opp.StageName))) return false
  if (rule.filterOppTypes.length > 0 && !rule.filterOppTypes.includes(opp.Type ?? '')) return false
  return true
}

export function evaluateStalled(
  opps: SfdcOpportunity[],
  stallRules: StallRule[],
  gongActivity: Map<string, GongOpportunityActivity>,
  stallThresholds: StallThreshold[] = []
): StalledAlert[] {
  const alerts: StalledAlert[] = []

  for (const opp of opps) {
    if (opp.IsClosed) continue

    const reasons: StalledReason[] = []
    const oppAgeDays = opp.Opportunity_Age__c ?? null
    const stageDays = opp.Stage_Duration_current__c != null
      ? opp.Stage_Duration_current__c
      : opp.Stage_Change_Date__c
        ? Math.floor((Date.now() - new Date(opp.Stage_Change_Date__c).getTime()) / (1000 * 60 * 60 * 24))
        : null
    const activity = gongActivity.get(opp.Id)

    // ── Per-stage thresholds (StallThresholdByStage) ─────────────────────────
    const threshold = findThreshold(stallThresholds, stageApiToLabel(opp.StageName), opp.Type ?? null)
    if (threshold) {
      if (threshold.dealAgeThresholdDays && oppAgeDays !== null && oppAgeDays >= threshold.dealAgeThresholdDays) {
        reasons.push({ type: 'deal_age', days: oppAgeDays, threshold: threshold.dealAgeThresholdDays })
      }
      if (threshold.stageDurationThresholdDays && stageDays !== null && stageDays >= threshold.stageDurationThresholdDays) {
        reasons.push({ type: 'stage_duration', days: stageDays, threshold: threshold.stageDurationThresholdDays })
      }
    }

    // ── Legacy StallRules (with Gong checks) ─────────────────────────────────
    for (const rule of stallRules) {
      if (!matchesFilters(opp, rule)) continue

      const ruleReasons: StalledReason[] = []

      if (rule.dealAgeThresholdDays && oppAgeDays !== null && oppAgeDays >= rule.dealAgeThresholdDays) {
        // avoid duplicate if already caught by threshold
        if (!reasons.some((r) => r.type === 'deal_age')) {
          ruleReasons.push({ type: 'deal_age', days: oppAgeDays, threshold: rule.dealAgeThresholdDays })
        }
      }

      if (rule.stageDurationThresholdDays && stageDays !== null && stageDays >= rule.stageDurationThresholdDays) {
        if (!reasons.some((r) => r.type === 'stage_duration')) {
          ruleReasons.push({ type: 'stage_duration', days: stageDays, threshold: rule.stageDurationThresholdDays })
        }
      }

      if (rule.gongInactivityDays && activity) {
        const inactive = daysSinceLastGongCall(activity)
        if (inactive !== null && inactive >= rule.gongInactivityDays) {
          ruleReasons.push({ type: 'gong_inactivity', days: inactive, threshold: rule.gongInactivityDays })
        }
      }

      if (rule.flagSingleThreaded && activity && isSingleThreaded(activity)) {
        ruleReasons.push({ type: 'single_threaded' })
      }

      if (rule.flagGongRedFlags && activity && hasRedFlags(activity)) {
        ruleReasons.push({ type: 'red_flag', phrases: activity.riskPhrasesFound })
      }

      reasons.push(...ruleReasons)
      if (ruleReasons.length > 0) break // first matching legacy rule wins per opp
    }

    if (reasons.length > 0) {
      alerts.push({
        alertType: AlertType.STALLED,
        opportunityId: opp.Id,
        opportunityName: opp.Name,
        ownerSfdcId: opp.OwnerId,
        ownerEmail: opp.Owner.Email,
        dealAgeDays: oppAgeDays,
        stageDurationDays: stageDays,
        stage: opp.StageName,
        triggeredBy: reasons,
        ruleId: threshold?.id ?? stallRules.find((r) => matchesFilters(opp, r))?.id ?? '',
        nextStep: opp.NextStep ?? null,
        nextStepDate: opp.Next_Step_Date__c ?? null,
      })
    }
  }

  return alerts
}
