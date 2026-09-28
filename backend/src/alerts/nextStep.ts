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

    // Renewals are windowed to the next 90 days — a renewal booking a year out has
    // nothing useful to say about next steps yet.
    //
    // A renewal with NO booking date is deliberately NOT skipped. It used to be, and
    // that was a silent coverage hole: evaluatePastDue also bails on a missing
    // Booking_Date__c (pastDue.ts), so between the two evaluators a dateless open
    // renewal was the one kind of opportunity nothing ever looked at. That is exactly
    // backwards — no booking date on an open renewal is a data problem in its own
    // right, not a reason to stop checking. It falls through to the issue checks
    // below, where the missing next-step text/date it almost certainly also has will
    // surface it to the owner.
    if (isRenewal && opp.Booking_Date__c) {
      const bookingDate = new Date(opp.Booking_Date__c)
      bookingDate.setHours(0, 0, 0, 0)
      const daysUntilBooking = Math.floor((bookingDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
      // Past due is genuinely handled elsewhere — evaluatePastDue emits
      // PAST_DUE_RENEWAL for these, so flagging them here would double-nudge.
      if (daysUntilBooking > 90 || daysUntilBooking < 0) continue
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
        // Grace period — skip past_date if still within the buffer window.
        //
        // `buffer` is coerced rather than trusted: a NaN buffer makes this
        // comparison false for every opportunity, which would switch the past-due
        // issue off across the board without erroring anywhere — and past_date is
        // the only issue a buffer can suppress, so the other two would keep
        // reporting and hide the fact that anything was wrong. The caller
        // validates too; this is the line whose failure is invisible, so it also
        // defends itself. `daysOverdue` is always >= 1 inside this branch, so a
        // buffer of 0 correctly flags everything overdue.
        const buffer = Number.isFinite(bufferDays) && bufferDays > 0 ? bufferDays : 0
        if (daysOverdue > buffer) issues.push('past_date')
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
