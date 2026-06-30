import type { SfdcAccount } from '../services/salesforce'
import type { GongAccountActivity, GongFlowEnrollment } from '../services/gong'

export type ProspectingFlagType = 'STALE_PROSPECTING' | 'SHOULD_BE_PROSPECTING'

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
  lastRepCommunicationDate: string | null
  targetProspectingDate: string | null
  reEngageDate: string | null
  competitorEndDate: string | null
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

    const hasRecentRepContact = daysSinceLastRepContact !== null && daysSinceLastRepContact <= config.recentActivityDays
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
      lastRepCommunicationDate: acct.Last_Rep_Communication_Date__c ?? null,
      targetProspectingDate: acct.Target_Prospecting_Date__c ?? null,
      reEngageDate: acct.Date_to_Re_engage__c ?? null,
      competitorEndDate: acct.End_of_competitor_engagement__c ?? null,
      daysSinceLastRepContact,
      gongLastCallDate,
      gongTotalCalls: activity?.totalCalls ?? 0,
      daysSinceLastGongCall,
      contactEmails,
      gongFlowStats,
    }

    const status = acct.Prospecting_Status__c

    // Flag 1: In "Prospecting" but no activity in staleThresholdDays
    if (status === 'Prospecting') {
      const hasAnyRecentActivity = hasRecentRepContact || hasRecentGongCall
      if (!hasAnyRecentActivity) {
        flags.push({ ...base, flagType: 'STALE_PROSPECTING' })
      }
    }

    // Flag 2: In "Planned" but has recent activity → should be moved to Prospecting
    if (status === 'Planned') {
      const hasAnyRecentActivity = hasRecentRepContact || hasRecentGongCall
      if (hasAnyRecentActivity) {
        flags.push({ ...base, flagType: 'SHOULD_BE_PROSPECTING' })
      }
    }
  }

  return flags
}
