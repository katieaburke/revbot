import type { SfdcOpportunity } from '../services/salesforce'
import { AlertType } from '../types'

export type MeddpiccField =
  | 'metrics'
  | 'economicBuyer'
  | 'decisionCriteria'
  | 'decisionProcess'
  | 'paperProcess'
  | 'identifyPain'
  | 'champion'
  | 'competition'
  | 'budget'
  | 'authority'
  | 'need'
  | 'timing'

export const MEDDPICC_LABELS: Record<MeddpiccField, string> = {
  metrics: 'Metrics',
  economicBuyer: 'Economic Buyer',
  decisionCriteria: 'Decision Criteria',
  decisionProcess: 'Decision Process',
  paperProcess: 'Paper Process',
  identifyPain: 'Identify/Implicate Pain',
  champion: 'Champion',
  competition: 'Competition',
  budget: 'Budget',
  authority: 'Authority',
  need: 'Need',
  timing: 'Timing',
}

export interface MeddpiccAlert {
  alertType: AlertType.MEDDPICC_MISSING
  opportunityId: string
  opportunityName: string
  ownerSfdcId: string
  ownerEmail: string
  stage: string
  missingFields: MeddpiccField[]
  sfdcFieldMap: Record<MeddpiccField, string>
}

interface StageRequirement {
  stageName: string
  opportunityType: string
  requireMetrics: boolean
  requireEconomicBuyer: boolean
  requireDecisionCriteria: boolean
  requireDecisionProcess: boolean
  requirePaperProcess: boolean
  requireIdentifyPain: boolean
  requireChampion: boolean
  requireCompetition: boolean
  requireBudget: boolean
  requireAuthority: boolean
  requireNeed: boolean
  requireTiming: boolean
  sfdcFieldMetrics: string
  sfdcFieldEconomicBuyer: string
  sfdcFieldDecisionCriteria: string
  sfdcFieldDecisionProcess: string
  sfdcFieldPaperProcess: string
  sfdcFieldIdentifyPain: string
  sfdcFieldChampion: string
  sfdcFieldCompetition: string
  sfdcFieldBudget: string
  sfdcFieldAuthority: string
  sfdcFieldNeed: string
  sfdcFieldTiming: string
}

function getOppFieldValue(opp: SfdcOpportunity, sfdcField: string): string | undefined {
  return (opp as unknown as Record<string, unknown>)[sfdcField] as string | undefined
}

function isMissing(value: string | undefined): boolean {
  return !value || value.trim() === ''
}

function findRequirement(
  requirements: StageRequirement[],
  stageName: string,
  opportunityType: string | null
): StageRequirement | undefined {
  // First try exact stage + type match
  if (opportunityType) {
    const exact = requirements.find(
      (r) => r.stageName === stageName && r.opportunityType === opportunityType
    )
    if (exact) return exact
  }
  // Fall back to stage + "All"
  return requirements.find((r) => r.stageName === stageName && r.opportunityType === 'All')
}

export function evaluateMeddpicc(
  opps: SfdcOpportunity[],
  requirements: StageRequirement[]
): MeddpiccAlert[] {
  const alerts: MeddpiccAlert[] = []

  for (const opp of opps) {
    if (opp.IsClosed) continue

    const req = findRequirement(requirements, opp.StageName, opp.Type ?? null)
    if (!req) continue

    const sfdcFieldMap: Record<MeddpiccField, string> = {
      metrics: req.sfdcFieldMetrics,
      economicBuyer: req.sfdcFieldEconomicBuyer,
      decisionCriteria: req.sfdcFieldDecisionCriteria,
      decisionProcess: req.sfdcFieldDecisionProcess,
      paperProcess: req.sfdcFieldPaperProcess,
      identifyPain: req.sfdcFieldIdentifyPain,
      champion: req.sfdcFieldChampion,
      competition: req.sfdcFieldCompetition,
      budget: req.sfdcFieldBudget,
      authority: req.sfdcFieldAuthority,
      need: req.sfdcFieldNeed,
      timing: req.sfdcFieldTiming,
    }

    const missing: MeddpiccField[] = []

    const checks: [boolean, MeddpiccField][] = [
      [req.requireMetrics, 'metrics'],
      [req.requireEconomicBuyer, 'economicBuyer'],
      [req.requireDecisionCriteria, 'decisionCriteria'],
      [req.requireDecisionProcess, 'decisionProcess'],
      [req.requirePaperProcess, 'paperProcess'],
      [req.requireIdentifyPain, 'identifyPain'],
      [req.requireChampion, 'champion'],
      [req.requireCompetition, 'competition'],
      [req.requireBudget, 'budget'],
      [req.requireAuthority, 'authority'],
      [req.requireNeed, 'need'],
      [req.requireTiming, 'timing'],
    ]

    for (const [required, field] of checks) {
      if (required && isMissing(getOppFieldValue(opp, sfdcFieldMap[field]))) {
        missing.push(field)
      }
    }

    if (missing.length > 0) {
      alerts.push({
        alertType: AlertType.MEDDPICC_MISSING,
        opportunityId: opp.Id,
        opportunityName: opp.Name,
        ownerSfdcId: opp.OwnerId,
        ownerEmail: opp.Owner.Email,
        stage: opp.StageName,
        missingFields: missing,
        sfdcFieldMap,
      })
    }
  }

  return alerts
}
