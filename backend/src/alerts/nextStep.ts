import type { SfdcOpportunity } from '../services/salesforce'
import { AlertType } from '../types'

export type NextStepIssue = 'missing_text' | 'missing_date' | 'past_date'

export interface NextStepAlert {
  alertType: AlertType
  opportunityId: string
  opportunityName: string
  ownerSfdcId: string
  ownerEmail: string
  oppType: string
  issues: NextStepIssue[]
  nextStepDate: string | null
  nextStepText: string | null
  bookingDate: string | null
}

export function evaluateNextStep(opps: SfdcOpportunity[], bufferDays = 0): NextStepAlert[] {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const alerts: NextStepAlert[] = []

  for (const opp of opps) {
    if (opp.IsClosed) continue

    const type = (opp.Type ?? '').toLowerCase()
    const isRenewal = type.includes('renewal')

    // Renewals: only check if booking date is within next 90 days
    if (isRenewal) {
      if (!opp.Booking_Date__c) continue
      const bookingDate = new Date(opp.Booking_Date__c)
      bookingDate.setHours(0, 0, 0, 0)
      const daysUntilBooking = Math.floor((bookingDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
      if (daysUntilBooking > 90 || daysUntilBooking < 0) continue // already past due (handled elsewhere) or too far out
    }
    // Non-renewals: check always (initial, amendment, etc.)

    const issues: NextStepIssue[] = []

    const nextStepText = opp.NextStep ?? null
    const nextStepDate = opp.Next_Step_Date__c ?? null

    if (!nextStepText?.trim()) issues.push('missing_text')

    if (!nextStepDate) {
      issues.push('missing_date')
    } else {
      const stepDate = new Date(nextStepDate)
      stepDate.setHours(0, 0, 0, 0)
      if (stepDate < today) {
        const daysOverdue = Math.floor((today.getTime() - stepDate.getTime()) / (1000 * 60 * 60 * 24))
        // Grace period — skip past_date if still within the buffer window
        if (bufferDays === 0 || daysOverdue > bufferDays) issues.push('past_date')
      }
    }

    if (issues.length === 0) continue

    alerts.push({
      alertType: AlertType.NEXT_STEP_MISSING,
      opportunityId: opp.Id,
      opportunityName: opp.Name,
      ownerSfdcId: opp.OwnerId,
      ownerEmail: opp.Owner.Email,
      oppType: opp.Type ?? 'Unknown',
      issues,
      nextStepDate,
      nextStepText,
      bookingDate: opp.Booking_Date__c ?? null,
    })
  }

  return alerts
}
