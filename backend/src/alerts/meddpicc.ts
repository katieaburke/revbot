import type { SfdcOpportunity } from '../services/salesforce'
import { AlertType } from '@prisma/client'

export type MeddpiccField =
  | 'metrics'
  | 'economicBuyer'
  | 'decisionCriteria'
  | 'decisionProcess'
  | 'identifyPain'
  | 'champion'
  | 'competition'

export const MEDDPICC_LABELS: Record<MeddpiccField, string> = {
  metrics: 'Metrics',
  economicBuyer: 'Economic Buyer',
  decisionCriteria: 'Decision Criteria',
  decisionProcess: 'Decision Process',
  identifyPain: 'Identify Pain',
  champion: 'Champion',
  competition: 'Competition',
}

export interface MeddpiccAlert {
  alertType: AlertType.MEDDPICC_MISSING
  opportunityId: string
  opportunityName: string
  ownerSfdcId: string
  ownerEmail: string
  stage: string
  missingFields: MeddpiccField[]
  // Map from field name to SFDC API field name (for write-back)
  sfdcFieldMap: Record<MeddpiccField, string>
}

interface StageRequirement {
  stageName: string
  requireMetrics: boolean
  requireEconomicBuyer: boolean
  requireDecisionCriteria: boolean
  requireDecisionProcess: boolean
  requireIdentifyPain: boolean
  requireChampion: boolean
  requireCompetition: boolean
  sfdcFieldMetrics: string
  sfdcFieldEconomicBuyer: string
  sfdcFieldDecisionCriteria: string
  sfdcFieldDecisionProcess: string
  sfdcFieldIdentifyPain: string
  sfdcFieldChampion: string
  sfdcFieldCompetition: string
}

function getOppFieldValue(opp: SfdcOpportunity, sfdcField: string): string | undefined {
  return (opp as Record<string, unknown>)[sfdcField] as string | undefined
}

function isMissing(value: string | undefined): boolean {
  return !value || value.trim() === ''
}

export function evaluateMeddpicc(
  opps: SfdcOpportunity[],
  requirements: StageRequirement[]
): MeddpiccAlert[] {
  const reqByStage = new Map(requirements.map((r) => [r.stageName, r]))
  const alerts: MeddpiccAlert[] = []

  for (const opp of opps) {
    if (opp.IsClosed) continue

    const req = reqByStage.get(opp.StageName)
    if (!req) continue

    const sfdcFieldMap: Record<MeddpiccField, string> = {
      metrics: req.sfdcFieldMetrics,
      economicBuyer: req.sfdcFieldEconomicBuyer,
      decisionCriteria: req.sfdcFieldDecisionCriteria,
      decisionProcess: req.sfdcFieldDecisionProcess,
      identifyPain: req.sfdcFieldIdentifyPain,
      champion: req.sfdcFieldChampion,
      competition: req.sfdcFieldCompetition,
    }

    const missing: MeddpiccField[] = []

    const checks: [boolean, MeddpiccField][] = [
      [req.requireMetrics, 'metrics'],
      [req.requireEconomicBuyer, 'economicBuyer'],
      [req.requireDecisionCriteria, 'decisionCriteria'],
      [req.requireDecisionProcess, 'decisionProcess'],
      [req.requireIdentifyPain, 'identifyPain'],
      [req.requireChampion, 'champion'],
      [req.requireCompetition, 'competition'],
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
