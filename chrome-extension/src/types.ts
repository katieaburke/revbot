export interface ExtensionSettings {
  apiUrl: string        // e.g. https://beacon.yourcompany.com
  apiKey: string        // extension API key from admin settings
  slackEmail: string    // user's Slack/work email for RevOps nudge auth
  isRevOps: boolean
}

export type AlertType =
  | 'PAST_DUE_INITIAL'
  | 'PAST_DUE_AMENDMENT'
  | 'PAST_DUE_RENEWAL'
  | 'STALLED'
  | 'MEDDPICC_MISSING'

export type NotificationStatus = 'SENT' | 'SNOOZED' | 'RESOLVED' | 'DISMISSED'

export interface DealHealthResponse {
  opportunityId: string
  opportunityName: string
  activeAlerts: ActiveAlert[]
  // null means Gong has no calls linked to this opp
  gongLastCallDate: string | null
  gongTotalCalls: number
  gongSingleThreaded: boolean
}

export interface ActiveAlert {
  id: string
  alertType: AlertType
  alertDetails: Record<string, unknown>
  status: NotificationStatus
  sentAt: string
  snoozedUntil?: string
  owner: {
    slackName: string
    slackEmail: string
    slackUserId: string
  }
}

export const ALERT_LABELS: Record<AlertType, string> = {
  PAST_DUE_INITIAL: 'Past Due',
  PAST_DUE_AMENDMENT: 'Past Due (Amendment)',
  PAST_DUE_RENEWAL: 'Past Due (Renewal)',
  STALLED: 'Stalled',
  MEDDPICC_MISSING: 'Missing MEDDPICC',
}

export const ALERT_COLORS: Record<AlertType, string> = {
  PAST_DUE_INITIAL: '#ef4444',
  PAST_DUE_AMENDMENT: '#ef4444',
  PAST_DUE_RENEWAL: '#f97316',
  STALLED: '#eab308',
  MEDDPICC_MISSING: '#8b5cf6',
}
