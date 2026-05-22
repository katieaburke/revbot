import type { KnownBlock } from '@slack/bolt'
import type { PastDueAlert } from '../alerts/pastDue'
import type { StalledAlert, StalledReason } from '../alerts/stalled'
import type { MeddpiccAlert } from '../alerts/meddpicc'
import { MEDDPICC_LABELS } from '../alerts/meddpicc'
import { AlertType } from '../types'

const SFDC_BASE = process.env.SFDC_INSTANCE_URL ?? 'https://your-instance.lightning.force.com'

function oppLink(oppId: string, oppName: string): string {
  return `<${SFDC_BASE}/lightning/r/Opportunity/${oppId}/view|${oppName}>`
}

function stalledReasonText(reason: StalledReason): string {
  switch (reason.type) {
    case 'deal_age':
      return `Deal has been open for *${reason.days} days* (threshold: ${reason.threshold}d)`
    case 'stage_duration':
      return `In current stage for *${reason.days} days* (threshold: ${reason.threshold}d)`
    case 'gong_inactivity':
      return `No Gong activity in *${reason.days} days* (threshold: ${reason.threshold}d)`
    case 'single_threaded':
      return `⚠️ Single-threaded — only one contact on Gong calls`
    case 'red_flag':
      return `🚩 Gong red flags: ${reason.descriptions.join(', ')}`
  }
}

export function buildPastDueMessage(alert: PastDueAlert, isNudge = false): KnownBlock[] {
  const prefix = isNudge ? '👋 *RevOps follow-up:* ' : ''
  const link = oppLink(alert.opportunityId, alert.opportunityName)

  let actionText: string
  let updateAction: string

  if (alert.alertType === AlertType.PAST_DUE_RENEWAL) {
    actionText = `The renewal ${link} was due on *${alert.closeDate}* — that's *${alert.daysOverdue} days ago.*`
    updateAction = 'Update Renewal'
  } else {
    actionText = `${link} had a close date of *${alert.closeDate}* — that's *${alert.daysOverdue} days ago.*`
    updateAction = 'Update Close Date'
  }

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${prefix}📅 *Past Due Opportunity*\n${actionText}`,
      },
    },
    {
      type: 'actions',
      block_id: `past_due_${alert.opportunityId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: updateAction },
          style: 'primary',
          action_id: 'update_close_date',
          value: JSON.stringify({ oppId: alert.opportunityId, oppName: alert.opportunityName, alertType: alert.alertType }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Snooze 7 days' },
          action_id: 'snooze_notification',
          value: JSON.stringify({ oppId: alert.opportunityId, days: 7, alertType: alert.alertType }),
        },
      ],
    },
  ]
}

export function buildStalledMessage(alert: StalledAlert, isNudge = false): KnownBlock[] {
  const prefix = isNudge ? '👋 *RevOps follow-up:* ' : ''
  const link = oppLink(alert.opportunityId, alert.opportunityName)
  const reasonLines = alert.triggeredBy.map((r) => `• ${stalledReasonText(r)}`).join('\n')

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${prefix}🔴 *Stalled Deal — ${link}*\nCurrently in *${alert.stage}*\n\n${reasonLines}`,
      },
    },
    {
      type: 'actions',
      block_id: `stalled_${alert.opportunityId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Update Stage' },
          style: 'primary',
          action_id: 'update_stage',
          value: JSON.stringify({ oppId: alert.opportunityId, oppName: alert.opportunityName, currentStage: alert.stage }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Log Activity' },
          action_id: 'log_activity',
          value: JSON.stringify({ oppId: alert.opportunityId, oppName: alert.opportunityName }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Snooze 7 days' },
          action_id: 'snooze_notification',
          value: JSON.stringify({ oppId: alert.opportunityId, days: 7, alertType: alert.alertType }),
        },
      ],
    },
  ]
}

export function buildMeddpiccMessage(alert: MeddpiccAlert, isNudge = false): KnownBlock[] {
  const prefix = isNudge ? '👋 *RevOps follow-up:* ' : ''
  const link = oppLink(alert.opportunityId, alert.opportunityName)
  const fieldList = alert.missingFields.map((f) => MEDDPICC_LABELS[f]).join(', ')

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${prefix}📋 *Missing MEDDPICC — ${link}*\nStage: *${alert.stage}*\nMissing: *${fieldList}*`,
      },
    },
    {
      type: 'actions',
      block_id: `meddpicc_${alert.opportunityId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Update Now' },
          style: 'primary',
          action_id: 'update_meddpicc',
          value: JSON.stringify({
            oppId: alert.opportunityId,
            oppName: alert.opportunityName,
            missingFields: alert.missingFields,
            sfdcFieldMap: alert.sfdcFieldMap,
          }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Snooze 7 days' },
          action_id: 'snooze_notification',
          value: JSON.stringify({ oppId: alert.opportunityId, days: 7, alertType: alert.alertType }),
        },
      ],
    },
  ]
}

// Sent to a user who hasn't connected Salesforce yet
export function buildConnectSfdcMessage(connectUrl: string): KnownBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🔗 *Connect your Salesforce account*\nTo update deals directly from Slack, link your Salesforce account. This takes about 10 seconds and only needs to be done once.`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Connect Salesforce' },
          style: 'primary',
          url: connectUrl,
          action_id: 'connect_sfdc',
        },
      ],
    },
  ]
}
