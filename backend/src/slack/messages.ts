import type { KnownBlock } from '@slack/web-api'
import type { PastDueAlert } from '../alerts/pastDue'
import type { StalledAlert, StalledReason } from '../alerts/stalled'
import type { MeddpiccAlert } from '../alerts/meddpicc'
import type { NextStepAlert, NextStepIssue } from '../alerts/nextStep'
import type { CloseDateRiskAlert } from '../alerts/closeDate'
import type { StageMismatchAlert } from '../alerts/stageMismatch'
import { MEDDPICC_LABELS } from '../alerts/meddpicc'
import { AlertType } from '../types'
import { getSfdcInstanceUrl } from '../services/salesforce'

// Lazily-resolved — fetched from the RevOps user record so no env var is needed.
// Cached after first load; call invalidateSfdcBaseCache() when a new SFDC connection is made.
let _sfdcBase: string | null = null
async function getSfdcBase(): Promise<string> {
  if (!_sfdcBase) _sfdcBase = await getSfdcInstanceUrl()
  return _sfdcBase
}

// Reusable footer note for alerts where stage changes are involved
const SFDC_STAGE_NOTE: KnownBlock = {
  type: 'context',
  elements: [{
    type: 'mrkdwn',
    text: '⚠️ _Stage changes must be made directly in Salesforce. To close as Lost, use the *Set to Lost* button on the opp (requires loss reason + incumbent vendor). Some stages also have entry criteria, e.g. adding a required contact role._',
  }],
}

// Disclosure for zombie pipeline / stalled alerts — the deal may simply have a longer cycle
const STALLED_DISCLOSURE: KnownBlock = {
  type: 'context',
  elements: [{
    type: 'mrkdwn',
    text: '_This opportunity may be at the right stage and simply have a longer sales cycle — if everything is on track, no action needed. Just snooze this notification to your next step date so we know it\'s being worked._',
  }],
}

export function invalidateSfdcBaseCache(): void {
  _sfdcBase = null
}

function oppLink(base: string, oppId: string, oppName: string): string {
  return `<${base}/lightning/r/Opportunity/${oppId}/view|${oppName}>`
}

function snoozeButton(oppId: string, alertType: string) {
  return {
    type: 'button' as const,
    text: { type: 'plain_text' as const, text: 'Snooze' },
    action_id: 'snooze_options',
    value: JSON.stringify({ oppId, alertType }),
  }
}

function needHelpButton() {
  return {
    type: 'button' as const,
    text: { type: 'plain_text' as const, text: 'Need Help?' },
    action_id: 'need_help',
  }
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
      return `🚩 Gong risk phrases detected: _${reason.phrases.join(', ')}_`
  }
}

export async function buildPastDueMessage(alert: PastDueAlert, isNudge = false): Promise<KnownBlock[]> {
  const base = await getSfdcBase()
  const prefix = isNudge ? '👋 *RevOps nudge:* ' : ''
  const link = oppLink(base, alert.opportunityId, alert.opportunityName)
  const daysText = `${alert.daysOverdue} day${alert.daysOverdue === 1 ? '' : 's'}`

  if (alert.alertType === AlertType.PAST_DUE_RENEWAL) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `${prefix}🔁 *Renewal past its booking date — ${link}*`,
            `Booking date was *${alert.bookingDate}* — *${daysText} ago.*`,
            '',
            `Please close this renewal in Salesforce. If the account has already auto-renewed, close this opportunity at the flat renewal amount and open a separate amendment for any incremental growth you're still working to close.`,
          ].join('\n'),
        },
      },
      {
        type: 'actions',
        block_id: `past_due_${alert.opportunityId}`,
        elements: [
          snoozeButton(alert.opportunityId, alert.alertType),
          needHelpButton(),
        ],
      },
    ]
  }

  // Initial or Amendment — rep can update close date
  const typeLabel = alert.alertType === AlertType.PAST_DUE_AMENDMENT ? 'amendment' : 'opportunity'
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `${prefix}📅 *Past due ${typeLabel} — ${link}*`,
          `Close date was *${alert.bookingDate}* — *${daysText} ago.*`,
          `Please update the close date in Salesforce or mark this deal as closed.`,
        ].join('\n'),
      },
    },
    {
      type: 'actions',
      block_id: `past_due_${alert.opportunityId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Update Close Date' },
          style: 'primary',
          action_id: 'update_close_date',
          value: JSON.stringify({ oppId: alert.opportunityId, oppName: alert.opportunityName, alertType: alert.alertType }),
        },
        snoozeButton(alert.opportunityId, alert.alertType),
        needHelpButton(),
      ],
    },
  ]
}

export async function buildStalledMessage(alert: StalledAlert, isNudge = false): Promise<KnownBlock[]> {
  const base = await getSfdcBase()
  const prefix = isNudge ? '👋 *RevOps follow-up:* ' : ''
  const link = oppLink(base, alert.opportunityId, alert.opportunityName)
  const reasonLines = alert.triggeredBy.map((r) => `• ${stalledReasonText(r)}`).join('\n')

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${prefix}🔴 *Stalled Deal — ${link}*\nCurrently in *${alert.stage}*\n\n${reasonLines}`,
      },
    },
    STALLED_DISCLOSURE,
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
          text: { type: 'plain_text', text: 'Update Close Date' },
          action_id: 'update_close_date',
          value: JSON.stringify({ oppId: alert.opportunityId, oppName: alert.opportunityName, alertType: alert.alertType }),
        },
        snoozeButton(alert.opportunityId, alert.alertType),
        needHelpButton(),
      ],
    },
    SFDC_STAGE_NOTE,
  ]
}

export async function buildMeddpiccMessage(alert: MeddpiccAlert, isNudge = false): Promise<KnownBlock[]> {
  const base = await getSfdcBase()
  const prefix = isNudge ? '👋 *RevOps follow-up:* ' : ''
  const link = oppLink(base, alert.opportunityId, alert.opportunityName)
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
        snoozeButton(alert.opportunityId, alert.alertType),
        needHelpButton(),
      ],
    },
  ]
}

export async function buildNextStepMessage(alert: NextStepAlert, isNudge = false): Promise<KnownBlock[]> {
  const base = await getSfdcBase()
  const prefix = isNudge ? '👋 *RevOps nudge:* ' : ''
  const link = oppLink(base, alert.opportunityId, alert.opportunityName)

  const issueLines = alert.issues.map((i: NextStepIssue) => {
    if (i === 'missing_text') return `• Next step description is blank`
    if (i === 'missing_date') return `• Next step date is not set`
    if (i === 'past_date') return `• Next step date (*${alert.nextStepDate}*) is in the past`
    return `• Unknown issue`
  }).join('\n')

  const renewalNote = (alert.oppType ?? '').toLowerCase().includes('renewal') && alert.bookingDate
    ? `\nBooking date: *${alert.bookingDate}*`
    : ''

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `${prefix}📌 *Missing or overdue next step — ${link}*`,
          renewalNote,
          '',
          issueLines,
          '',
          `Please update your next step in Salesforce so the team knows what's happening on this deal.`,
        ].filter((l) => l !== undefined).join('\n'),
      },
    },
    {
      type: 'actions',
      block_id: `next_step_${alert.opportunityId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Update Next Step' },
          style: 'primary',
          action_id: 'update_next_step',
          value: JSON.stringify({ oppId: alert.opportunityId, oppName: alert.opportunityName }),
        },
        snoozeButton(alert.opportunityId, alert.alertType),
        needHelpButton(),
      ],
    },
  ]
}

export async function buildCloseDateRiskMessage(alert: CloseDateRiskAlert, isNudge = false): Promise<KnownBlock[]> {
  const base = await getSfdcBase()
  const prefix = isNudge ? '👋 *RevOps nudge:* ' : ''
  const link = oppLink(base, alert.opportunityId, alert.opportunityName)
  const daysText = alert.daysUntilClose === 0
    ? 'today'
    : alert.daysUntilClose === 1
    ? 'tomorrow'
    : `in *${alert.daysUntilClose} days*`

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `${prefix}⚠️ *Close date risk — ${link}*`,
          `Close date is ${daysText} (*${alert.closeDate}*) but the deal is still in *${alert.stage}*.`,
          ``,
          `Is this deal on track? Please update the stage or push the close date so the forecast stays accurate.`,
        ].join('\n'),
      },
    },
    {
      type: 'actions',
      block_id: `close_date_risk_${alert.opportunityId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Update Close Date' },
          style: 'primary',
          action_id: 'update_close_date',
          value: JSON.stringify({ oppId: alert.opportunityId, oppName: alert.opportunityName, alertType: AlertType.CLOSE_DATE_RISK }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Update Stage' },
          action_id: 'update_stage',
          value: JSON.stringify({ oppId: alert.opportunityId, oppName: alert.opportunityName, currentStage: alert.stage }),
        },
        snoozeButton(alert.opportunityId, alert.alertType),
        needHelpButton(),
      ],
    },
  ]
}

export async function buildStageMismatchMessage(alert: StageMismatchAlert, isNudge = false): Promise<KnownBlock[]> {
  const base = await getSfdcBase()
  const prefix = isNudge ? '👋 *RevOps nudge:* ' : ''
  const link = oppLink(base, alert.opportunityId, alert.opportunityName)
  const kwText = alert.matchedKeywords.map((k) => `"${k}"`).join(', ')

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `${prefix}🔀 *Potential stage mismatch — ${link}*`,
          `Deal is in *${alert.stage}* but next step mentions ${kwText}.`,
          ``,
          `Is the stage up to date? Please advance the stage in Salesforce if the deal has progressed.`,
        ].join('\n'),
      },
    },
    {
      type: 'actions',
      block_id: `stage_mismatch_${alert.opportunityId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open in Salesforce' },
          style: 'primary',
          url: `${base}/lightning/r/Opportunity/${alert.opportunityId}/view`,
          action_id: 'open_sfdc_stage_mismatch',
        },
        snoozeButton(alert.opportunityId, AlertType.STAGE_MISMATCH),
        needHelpButton(),
      ],
    },
    SFDC_STAGE_NOTE,
  ]
}

// Combined message for multiple alert types on one opp (used by the admin draft/send flow)
export async function buildCombinedMessage(
  oppId: string,
  oppName: string,
  alerts: { alertType: string; details: Record<string, unknown> }[]
): Promise<KnownBlock[]> {
  const base = await getSfdcBase()
  const link = oppLink(base, oppId, oppName)
  const blocks: KnownBlock[] = []
  const summarySections: string[] = []

  for (const a of alerts) {
    if (a.alertType === AlertType.MEDDPICC_MISSING) {
      const missing = (a.details.missingFields as string[] | undefined) ?? []
      const labels = missing.map((f) => MEDDPICC_LABELS[f as keyof typeof MEDDPICC_LABELS] ?? f)
      summarySections.push(`📋 *Missing MEDDPICC/BANT:* ${labels.join(', ')}`)
    } else if (a.alertType === AlertType.STALLED) {
      const reasons = (a.details.triggeredBy as Array<{ type: string; days?: number; threshold?: number; phrases?: string[] }> | undefined) ?? []
      for (const r of reasons) summarySections.push(`🔴 ${stalledReasonText(r as StalledReason)}`)
      summarySections.push(`_This opportunity may be at the right stage and simply have a longer sales cycle — if everything is on track, just snooze this to your next step date._`)
    } else if (a.alertType === AlertType.PAST_DUE_RENEWAL) {
      const days = a.details.daysOverdue as number
      const date = a.details.bookingDate as string
      summarySections.push(`🔁 *Renewal past due:* Booking date was *${date}* — ${days} day${days === 1 ? '' : 's'} ago`)
      summarySections.push(`_If this account has already auto-renewed, close at the flat renewal amount and open a separate amendment for any growth you're still working._`)
    } else if (
      a.alertType === AlertType.PAST_DUE_INITIAL ||
      a.alertType === AlertType.PAST_DUE_AMENDMENT
    ) {
      const days = a.details.daysOverdue as number
      const date = a.details.bookingDate as string
      const typeLabel = a.alertType === AlertType.PAST_DUE_AMENDMENT ? 'Amendment' : 'Opportunity'
      summarySections.push(`📅 *${typeLabel} past due:* Close date was *${date}* — ${days} day${days === 1 ? '' : 's'} ago`)
    } else if (a.alertType === AlertType.CLOSE_DATE_RISK) {
      const daysUntilClose = a.details.daysUntilClose as number
      const closeDate = a.details.closeDate as string
      const stage = a.details.stage as string
      const daysText = daysUntilClose === 0 ? 'today' : daysUntilClose === 1 ? 'tomorrow' : `in ${daysUntilClose} days`
      summarySections.push(`⚠️ *Close date risk:* Close date is ${daysText} (*${closeDate}*) but deal is still in *${stage}*`)
    } else if (a.alertType === AlertType.NEXT_STEP_MISSING) {
      const issues = (a.details.issues as string[] | undefined) ?? []
      for (const issue of issues) {
        if (issue === 'missing_text') summarySections.push(`📌 *Next step description is blank* — please add what's happening on this deal`)
        if (issue === 'missing_date') summarySections.push(`📌 *Next step date is not set* — please add a target date`)
        if (issue === 'past_date') {
          const date = a.details.nextStepDate as string | null
          summarySections.push(`⏰ *Next step date is in the past* (${date ?? 'unknown'}) — please update it`)
        }
      }
    } else if (a.alertType === AlertType.STAGE_MISMATCH) {
      const keywords = (a.details.matchedKeywords as string[] | undefined) ?? []
      summarySections.push(
        `🔀 *Potential stage mismatch* — next step mentions "${keywords.join('", "')}" but stage is *${a.details.stage}*`
      )
    }
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `👋 *Action needed on ${link}*\n\n${summarySections.join('\n')}`,
    },
  })

  // Add primary action button based on the highest-priority alert
  for (const a of alerts) {
    if (a.alertType === AlertType.PAST_DUE_INITIAL || a.alertType === AlertType.PAST_DUE_AMENDMENT) {
      blocks.push({
        type: 'actions',
        block_id: `past_due_action_${oppId}`,
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'Update Close Date' },
          style: 'primary',
          action_id: 'update_close_date',
          value: JSON.stringify({ oppId, oppName, alertType: a.alertType }),
        }],
      } as KnownBlock)
      break
    }
    if (a.alertType === AlertType.PAST_DUE_RENEWAL) {
      // No action buttons — closing a renewal must be done in Salesforce
      break
    }
    if (a.alertType === AlertType.STALLED) {
      blocks.push({
        type: 'actions',
        block_id: `stalled_action_${oppId}`,
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Update Stage' },
            style: 'primary',
            action_id: 'update_stage',
            value: JSON.stringify({ oppId, oppName, currentStage: (a.details.stage as string) ?? '' }),
          },
        ],
      } as KnownBlock)
      break
    }
    if (a.alertType === AlertType.MEDDPICC_MISSING) {
      blocks.push({
        type: 'actions',
        block_id: `meddpicc_action_${oppId}`,
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'Update MEDDPICC/BANT' },
          style: 'primary',
          action_id: 'update_meddpicc',
          value: JSON.stringify({
            oppId,
            oppName,
            missingFields: (a.details.missingFields as string[]) ?? [],
            sfdcFieldMap: (a.details.sfdcFieldMap as Record<string, string>) ?? {},
          }),
        }],
      } as KnownBlock)
      break
    }
    if (a.alertType === AlertType.NEXT_STEP_MISSING) {
      blocks.push({
        type: 'actions',
        block_id: `next_step_action_${oppId}`,
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'Update Next Step' },
          style: 'primary',
          action_id: 'update_next_step',
          value: JSON.stringify({ oppId, oppName }),
        }],
      } as KnownBlock)
      break
    }
    if (a.alertType === AlertType.CLOSE_DATE_RISK) {
      blocks.push({
        type: 'actions',
        block_id: `close_date_risk_action_${oppId}`,
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Update Close Date' },
            style: 'primary',
            action_id: 'update_close_date',
            value: JSON.stringify({ oppId, oppName, alertType: AlertType.CLOSE_DATE_RISK }),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Update Stage' },
            action_id: 'update_stage',
            value: JSON.stringify({ oppId, oppName, currentStage: (a.details.stage as string) ?? '' }),
          },
        ],
      } as KnownBlock)
      break
    }
    if (a.alertType === AlertType.STAGE_MISMATCH) {
      const sfdcBase = await getSfdcBase()
      blocks.push({
        type: 'actions',
        block_id: `stage_mismatch_action_${oppId}`,
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open in Salesforce' },
            style: 'primary',
            url: `${sfdcBase}/lightning/r/Opportunity/${oppId}/view`,
            action_id: 'open_sfdc_stage_mismatch',
          },
        ],
      } as KnownBlock)
      break
    }
  }

  // Stage-change note for stalled / stage mismatch alerts
  const needsStageNote = alerts.some((a) => a.alertType === AlertType.STALLED || a.alertType === AlertType.STAGE_MISMATCH)
  if (needsStageNote) blocks.push(SFDC_STAGE_NOTE)

  // Footer: open in SFDC + snooze + help
  blocks.push({
    type: 'actions',
    block_id: `footer_${oppId}`,
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Open in Salesforce' },
        url: `${base}/lightning/r/Opportunity/${oppId}/view`,
        action_id: 'open_sfdc',
      },
      snoozeButton(oppId, alerts[0]?.alertType ?? ''),
      needHelpButton(),
    ],
  })

  return blocks
}

// Manager heads-up message — informational, sent to the owner's manager
export async function buildManagerAlertMessage(
  oppId: string,
  oppName: string,
  ownerName: string,
  alerts: { alertType: string; details: Record<string, unknown> }[]
): Promise<KnownBlock[]> {
  const base = await getSfdcBase()
  const link = oppLink(base, oppId, oppName)
  const summarySections: string[] = []

  for (const a of alerts) {
    if (a.alertType === AlertType.MEDDPICC_MISSING) {
      const missing = (a.details.missingFields as string[] | undefined) ?? []
      const labels = missing.map((f) => MEDDPICC_LABELS[f as keyof typeof MEDDPICC_LABELS] ?? f)
      summarySections.push(`📋 *Missing MEDDPICC/BANT:* ${labels.join(', ')}`)
    } else if (a.alertType === AlertType.STALLED) {
      const reasons = (a.details.triggeredBy as Array<{ type: string; days?: number; threshold?: number; phrases?: string[] }> | undefined) ?? []
      for (const r of reasons) summarySections.push(`🔴 ${stalledReasonText(r as StalledReason)}`)
      summarySections.push(`_Note: this deal may simply have a longer cycle — flagging for visibility._`)
    } else if (a.alertType === AlertType.PAST_DUE_RENEWAL) {
      const days = a.details.daysOverdue as number
      const date = a.details.bookingDate as string
      summarySections.push(`🔁 *Renewal past due:* Booking date was *${date}* — ${days} day${days === 1 ? '' : 's'} ago`)
    } else if (a.alertType === AlertType.PAST_DUE_INITIAL || a.alertType === AlertType.PAST_DUE_AMENDMENT) {
      const days = a.details.daysOverdue as number
      const date = a.details.bookingDate as string
      const typeLabel = a.alertType === AlertType.PAST_DUE_AMENDMENT ? 'Amendment' : 'Opportunity'
      summarySections.push(`📅 *${typeLabel} past due:* Close date was *${date}* — ${days} day${days === 1 ? '' : 's'} ago`)
    } else if (a.alertType === AlertType.CLOSE_DATE_RISK) {
      const daysUntilClose = a.details.daysUntilClose as number
      const closeDate = a.details.closeDate as string
      const stage = a.details.stage as string
      const daysText = daysUntilClose === 0 ? 'today' : daysUntilClose === 1 ? 'tomorrow' : `in ${daysUntilClose} days`
      summarySections.push(`⚠️ *Close date risk:* Close date is ${daysText} (*${closeDate}*) but deal is still in *${stage}*`)
    } else if (a.alertType === AlertType.NEXT_STEP_MISSING) {
      const issues = (a.details.issues as string[] | undefined) ?? []
      for (const issue of issues) {
        if (issue === 'missing_text') summarySections.push(`📌 *Missing next step description*`)
        if (issue === 'missing_date') summarySections.push(`📌 *Missing next step date*`)
        if (issue === 'past_date') summarySections.push(`⏰ *Next step date is in the past* (${a.details.nextStepDate ?? 'unknown'})`)
      }
    } else if (a.alertType === AlertType.STAGE_MISMATCH) {
      const keywords = (a.details.matchedKeywords as string[] | undefined) ?? []
      summarySections.push(`🔀 *Potential stage mismatch* — next step mentions "${keywords.join('", "')}"`)
    }
  }

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🔔 *FYI — ${link}* needs attention\n${ownerName}'s deal has been flagged:\n\n${summarySections.join('\n')}`,
      },
    },
    {
      type: 'actions',
      block_id: `manager_alert_${oppId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open in Salesforce' },
          style: 'primary',
          url: `${base}/lightning/r/Opportunity/${oppId}/view`,
          action_id: 'open_sfdc_manager',
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
