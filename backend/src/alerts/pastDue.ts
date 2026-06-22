import type { SfdcOpportunity } from '../services/salesforce'
import { AlertType } from '../types'

export interface PastDueAlert {
  alertType: AlertType
  opportunityId: string
  opportunityName: string
  ownerSfdcId: string
  ownerEmail: string
  bookingDate: string
  daysOverdue: number
  oppType: string
}

export function evaluatePastDue(opps: SfdcOpportunity[], bufferDays = 0): PastDueAlert[] {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const alerts: PastDueAlert[] = []

  for (const opp of opps) {
    if (opp.IsClosed) continue

    // Use Booking_Date__c — skip if not set
    if (!opp.Booking_Date__c) continue

    const bookingDate = new Date(opp.Booking_Date__c)
    bookingDate.setHours(0, 0, 0, 0)
    if (bookingDate >= today) continue

    const daysOverdue = Math.floor((today.getTime() - bookingDate.getTime()) / (1000 * 60 * 60 * 24))

    // Grace period — skip if still within the buffer window
    if (bufferDays > 0 && daysOverdue <= bufferDays) continue
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
      bookingDate: opp.Booking_Date__c,
      daysOverdue,
      oppType: opp.Type ?? 'Unknown',
    })
  }

  return alerts
}
