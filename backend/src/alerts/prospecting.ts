import type { SfdcAccount } from '../services/salesforce'
import type { GongAccountActivity, GongFlowEnrollment } from '../services/gong'

export type ProspectingFlagType = 'STALE_PROSPECTING' | 'SHOULD_BE_PROSPECTING' | 'STALE_TARGET_DATE'

export interface ProspectingFlag {
  flagType: ProspectingFlagType
  accountId: string
  accountName: string
  recordTypeName: string | null
  ownerEmail: string
  ownerName: string | null
  bdrEmail: string | null
  bdrName: string | null
  prospectingStatus: string | null
  prospectingPauseReason: string | null
  lastRepCommunicationDate: string | null
  targetProspectingDate: string | null
  reEngageDate: string | null
  competitorEndDate: string | null
  competitor: string | null
  daysSinceLastRepContact: number | null
  gongLastCallDate: string | null
  gongTotalCalls: number
  daysSinceLastGongCall: number | null
  contactEmails: string[]
  // null = Gong Engage Flows API unavailable on this plan
  gongFlowStats: {
    activeWithOverdue: number      // contacts in an active flow with an overdue step
    activeOnTrack: number          // contacts in an active flow, no overdue step
    completedSinceTarget: number   // contacts who completed a flow on/after targetProspectingDate
  } | null
}

interface ProspectingConfig {
  staleThresholdDays: number    // default 14 — how many days without contact = stale
  recentActivityDays: number    // default 14 — activity within this many days = "should promote"
}

export function evaluateProspectingHygiene(
  accounts: SfdcAccount[],
  gongActivity: Map<string, GongAccountActivity>,
  config: ProspectingConfig = { staleThresholdDays: 14, recentActivityDays: 14 },
  flowIndex: Map<string, GongFlowEnrollment[]> | null = null
): ProspectingFlag[] {
  const flags: ProspectingFlag[] = []
  const now = Date.now()

  for (const acct of accounts) {
    const activity = gongActivity.get(acct.Id)
    const contacts = acct.Contacts?.records ?? []
    const contactEmails = contacts.map(c => c.Email).filter(Boolean) as string[]

    const lastRepDate = acct.Last_Rep_Communication_Date__c
      ? new Date(acct.Last_Rep_Communication_Date__c)
      : null
    const daysSinceLastRepContact = lastRepDate
      ? Math.floor((now - lastRepDate.getTime()) / (1000 * 60 * 60 * 24))
      : null

    const gongLastCallDate = activity?.lastCallDate ?? null
    const daysSinceLastGongCall = gongLastCallDate
      ? Math.floor((now - new Date(gongLastCallDate).getTime()) / (1000 * 60 * 60 * 24))
      : null

    // NOTE: hasRecentRepContact is intentionally excluded from activity checks — Last_Rep_Communication_Date__c
    // is updated by call block dials even when the account isn't in an active flow, making it an unreliable
    // signal for intentional prospecting activity. Only Gong call data drives the flags.
    const hasRecentGongCall = daysSinceLastGongCall !== null && daysSinceLastGongCall <= config.recentActivityDays

    // Compute per-account Gong flow stats for this account's contact emails
    let gongFlowStats: ProspectingFlag['gongFlowStats'] = null
    if (flowIndex !== null) {
      const targetDate = acct.Target_Prospecting_Date__c
        ? new Date(acct.Target_Prospecting_Date__c)
        : null
      const nowDate = new Date(now)

      let activeWithOverdue = 0
      let activeOnTrack = 0
      let completedSinceTarget = 0

      // Track per-contact to avoid double-counting if a contact is in multiple flows
      const activeAccountedFor = new Set<string>()
      const completedAccountedFor = new Set<string>()

      for (const email of contactEmails) {
        const enrollments = flowIndex.get(email.toLowerCase()) ?? []
        for (const enrollment of enrollments) {
          const statusUp = enrollment.status.toUpperCase()
          const isActive = ['ACTIVE', 'IN_PROGRESS', 'ENROLLED'].includes(statusUp)
          const isCompleted = statusUp === 'COMPLETED'

          if (isActive && !activeAccountedFor.has(email)) {
            activeAccountedFor.add(email)
            const dueDate = enrollment.nextStepDueDate ? new Date(enrollment.nextStepDueDate) : null
            if (dueDate && dueDate < nowDate) {
              activeWithOverdue++
            } else {
              activeOnTrack++
            }
          }

          if (isCompleted && !completedAccountedFor.has(email)) {
            const completedAt = enrollment.completedAt ? new Date(enrollment.completedAt) : null
            // Count if completed on or after the target prospecting date (or if no target date, count all)
            if (completedAt && (!targetDate || completedAt >= targetDate)) {
              completedAccountedFor.add(email)
              completedSinceTarget++
            }
          }
        }
      }

      gongFlowStats = { activeWithOverdue, activeOnTrack, completedSinceTarget }
    }

    const base = {
      accountId: acct.Id,
      accountName: acct.Name,
      recordTypeName: acct.RecordType?.Name ?? null,
      ownerEmail: acct.Owner.Email,
      ownerName: acct.Owner.Name,
      bdrEmail: acct.BDR_Assigned__r?.Email ?? null,
      bdrName: acct.BDR_Assigned__r?.Name ?? null,
      prospectingStatus: acct.Prospecting_Status__c,
      prospectingPauseReason: acct.Prospecting_Pause_Reason__c ?? null,
      lastRepCommunicationDate: acct.Last_Rep_Communication_Date__c ?? null,
      targetProspectingDate: acct.Target_Prospecting_Date__c ?? null,
      reEngageDate: acct.Date_to_Re_engage__c ?? null,
      competitorEndDate: acct.End_of_competitor_engagement__c ?? null,
      competitor: acct.Competitor__c ?? null,
      daysSinceLastRepContact,
      gongLastCallDate,
      gongTotalCalls: activity?.totalCalls ?? 0,
      daysSinceLastGongCall,
      contactEmails,
      gongFlowStats,
    }

    const status = acct.Prospecting_Status__c

    // Flag 1: In "Prospecting" but no Gong call activity in staleThresholdDays
    if (status === 'Prospecting') {
      if (!hasRecentGongCall) {
        flags.push({ ...base, flagType: 'STALE_PROSPECTING' })
      }
    }

    // Flag 2: In "Planned" but has recent Gong call activity → should be moved to Prospecting
    // Exclude if: re-engage date is in the future (already rescheduled),
    //             OR target prospecting date is in the future (already planned ahead)
    if (status === 'Planned') {
      const reEngageDate = acct.Date_to_Re_engage__c ? new Date(acct.Date_to_Re_engage__c).getTime() : null
      const targetDate = acct.Target_Prospecting_Date__c ? new Date(acct.Target_Prospecting_Date__c).getTime() : null
      const reEngageIsFuture = reEngageDate !== null && reEngageDate > now
      const targetDateIsFuture = targetDate !== null && targetDate > now
      if (hasRecentGongCall && !reEngageIsFuture && !targetDateIsFuture) {
        flags.push({ ...base, flagType: 'SHOULD_BE_PROSPECTING' })
      }
    }

    // Flag 3: Has recent Gong call activity but target prospecting date is before the 1st of last month
    // i.e. they're actively working the account but haven't updated the target date in 30+ days
    {
      const nowDate = new Date(now)
      const firstOfPrevMonth = new Date(nowDate.getFullYear(), nowDate.getMonth() - 1, 1)
      const targetDateMs = acct.Target_Prospecting_Date__c
        ? new Date(acct.Target_Prospecting_Date__c).getTime()
        : null
      const targetIsStale = targetDateMs !== null && targetDateMs < firstOfPrevMonth.getTime()

      // Only flag active statuses — skip Paused/Nurturing/Success
      const isActiveStatus = status === 'Prospecting' || status === 'Planned'

      // Don't double-flag an account already caught by Flag 1 (stale prospecting = no recent Gong call)
      const alreadyStale = status === 'Prospecting' && !hasRecentGongCall

      if (hasRecentGongCall && targetIsStale && isActiveStatus && !alreadyStale) {
        flags.push({ ...base, flagType: 'STALE_TARGET_DATE' })
      }
    }
  }

  return flags
}
