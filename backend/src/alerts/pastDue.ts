import type { SfdcOpportunity } from '../services/salesforce'
import { AlertType } from '@prisma/client'

export interface PastDueAlert {
  alertType: AlertType
  opportunityId: string
  opportunityName: string
  ownerSfdcId: string
  ownerEmail: string
  closeDate: string
  daysOverdue: number
  oppType: string
}

export function evaluatePastDue(opps: SfdcOpportunity[]): PastDueAlert[] {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const alerts: PastDueAlert[] = []

  for (const opp of opps) {
    if (opp.IsClosed) continue

    const closeDate = new Date(opp.CloseDate)
    closeDate.setHours(0, 0, 0, 0)
    if (closeDate >= today) continue

    const daysOverdue = Math.floor((today.getTime() - closeDate.getTime()) / (1000 * 60 * 60 * 24))
    const type = (opp.Type ?? '').toLowerCase()

    let alertType: AlertType
    if (type.includes('renewal')) {
      alertType = AlertType.PAST_DUE_RENEWAL
    } else if (type.includes('amendment') || type.includes('expansion')) {
      alertType = AlertType.PAST_DUE_AMENDMENT
    } else {
      alertType = AlertType.PAST_DUE_INITIAL
    }

    alerts.push({
      alertType,
      opportunityId: opp.Id,
      opportunityName: opp.Name,
      ownerSfdcId: opp.OwnerId,
      ownerEmail: opp.Owner.Email,
      closeDate: opp.CloseDate,
      daysOverdue,
      oppType: opp.Type ?? 'Unknown',
    })
  }

  return alerts
}
