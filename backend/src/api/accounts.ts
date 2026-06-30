import { Router } from 'express'
import { requireAdmin } from '../middleware/adminAuth'
import { fetchProspectAccounts, getSfdcInstanceUrl } from '../services/salesforce'
import { buildAccountActivityIndex, buildFlowContactIndex } from '../services/gong'
import { evaluateProspectingHygiene, type ProspectingFlagType } from '../alerts/prospecting'
import { sendDm, resolveSlackUserId } from '../slack/bot'
import { db } from '../db'
import type { KnownBlock } from '@slack/web-api'

const router = Router()
router.use(requireAdmin)

// GET /api/accounts/prospecting-hygiene
// Returns all prospect accounts with their flags
router.get('/prospecting-hygiene', async (_req, res) => {
  try {
    const settings = await db.appSetting.findMany({
      where: { key: { in: ['accountRecordTypeFilter', 'prospectingStaleThresholdDays', 'prospectingRecentActivityDays'] } },
    })
    const settingMap = Object.fromEntries(settings.map((s) => [s.key, JSON.parse(s.value)]))
    const recordTypeFilter = (settingMap.accountRecordTypeFilter as string) ?? 'Enterprise_Account_Record'
    const staleThresholdDays = Number(settingMap.prospectingStaleThresholdDays ?? 14)
    const recentActivityDays = Number(settingMap.prospectingRecentActivityDays ?? 14)

    const accounts = await fetchProspectAccounts(recordTypeFilter)
    const accountIds = accounts.map((a) => a.Id)

    // Collect all contact emails across all accounts for flow lookup
    const allContactEmails = Array.from(
      new Set(
        accounts.flatMap((a) => (a.Contacts?.records ?? []).map((c) => c.Email).filter(Boolean) as string[])
      )
    )

    const [gongActivity, flowIndex] = await Promise.all([
      buildAccountActivityIndex(accountIds),
      buildFlowContactIndex(allContactEmails),
    ])

    const flags = evaluateProspectingHygiene(accounts, gongActivity, { staleThresholdDays, recentActivityDays }, flowIndex)

    res.json({
      scannedAt: new Date().toISOString(),
      totalAccounts: accounts.length,
      flags,
      config: { recordTypeFilter, staleThresholdDays, recentActivityDays },
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// POST /api/accounts/notify-bdr
// Sends a Slack DM to the BDR assigned to a flagged prospect account.
// Does NOT create a Notification record — this is a one-off hygiene nudge.
router.post('/notify-bdr', async (req, res) => {
  const {
    accountId,
    accountName,
    flagType,
    bdrEmail,
    bdrName,
    ownerName,
    prospectingStatus,
    daysSinceLastRepContact,
    daysSinceLastGongCall,
    gongTotalCalls,
    lastRepCommunicationDate,
    gongLastCallDate,
    targetProspectingDate,
  } = req.body as {
    accountId: string
    accountName: string
    flagType: ProspectingFlagType
    bdrEmail: string
    bdrName: string | null
    ownerName: string | null
    prospectingStatus: string | null
    daysSinceLastRepContact: number | null
    daysSinceLastGongCall: number | null
    gongTotalCalls: number
    lastRepCommunicationDate: string | null
    gongLastCallDate: string | null
    targetProspectingDate: string | null
  }

  if (!bdrEmail) {
    return res.status(400).json({ error: 'No BDR email provided — account may not have a BDR assigned.' })
  }

  // Resolve Slack user ID for the BDR
  const slackUserId = await resolveSlackUserId(bdrEmail)
  if (!slackUserId) {
    return res.status(404).json({ error: `Could not find Slack user for ${bdrEmail}. Make sure they're in the workspace.` })
  }

  const sfdcInstanceUrl = await getSfdcInstanceUrl()
  const accountUrl = `${sfdcInstanceUrl.replace(/\/$/, '')}/lightning/r/Account/${accountId}/view`

  const bdrFirstName = bdrName?.split(' ')[0] ?? 'there'

  function fmtDate(iso: string | null): string {
    if (!iso) return '—'
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  function daysStr(days: number | null): string {
    if (days === null) return ''
    if (days === 0) return ' (today)'
    if (days === 1) return ' (1 day ago)'
    return ` (${days} days ago)`
  }

  let headerText: string
  let bodyText: string

  if (flagType === 'STALE_PROSPECTING') {
    const staleDays = daysSinceLastRepContact ?? daysSinceLastGongCall
    headerText = `👋 Hey ${bdrFirstName}, *${accountName}* has gone stale in prospecting`
    bodyText = staleDays !== null
      ? `This account has been in *Prospecting* status for *${staleDays} days* without any rep communication or Gong call activity. Could you resume outreach or update the status?`
      : `This account has been in *Prospecting* status with no recent rep communication or Gong calls. Could you resume outreach or update the status?`
  } else {
    headerText = `👋 Hey ${bdrFirstName}, *${accountName}* looks ready to move to Prospecting`
    bodyText = `This account is in *Planned* status but has had recent activity${gongTotalCalls > 0 ? ` (${gongTotalCalls} Gong call${gongTotalCalls !== 1 ? 's' : ''}, last ${fmtDate(gongLastCallDate)})` : ''}. Should the status be updated to Prospecting?`
  }

  const fields: { type: 'mrkdwn'; text: string }[] = []

  if (lastRepCommunicationDate) {
    fields.push({ type: 'mrkdwn', text: `*Last rep contact*\n${fmtDate(lastRepCommunicationDate)}${daysStr(daysSinceLastRepContact)}` })
  }
  if (gongLastCallDate) {
    fields.push({ type: 'mrkdwn', text: `*Last Gong call*\n${fmtDate(gongLastCallDate)}${daysStr(daysSinceLastGongCall)}` })
  }
  if (targetProspectingDate) {
    fields.push({ type: 'mrkdwn', text: `*Target prospecting date*\n${fmtDate(targetProspectingDate)}` })
  }
  if (ownerName) {
    fields.push({ type: 'mrkdwn', text: `*Account owner*\n${ownerName}` })
  }

  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: headerText },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: bodyText },
    },
    ...(fields.length > 0
      ? [{ type: 'section' as const, fields }]
      : []),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View in Salesforce →', emoji: true },
          url: accountUrl,
          action_id: 'view_account_sfdc',
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Sent via RevBot · ${prospectingStatus ?? 'Unknown'} status`,
        },
      ],
    },
  ]

  const plainText = `${flagType === 'STALE_PROSPECTING' ? '⚠️' : '✅'} ${accountName}: ${flagType === 'STALE_PROSPECTING' ? 'stale in prospecting' : 'ready to move to Prospecting'}`

  await sendDm(slackUserId, blocks, plainText)

  // Log the send to AppSetting for audit trail (lightweight — no Notification record needed)
  await db.appSetting.upsert({
    where: { key: `bdrNudge:last:${accountId}` },
    create: { key: `bdrNudge:last:${accountId}`, value: JSON.stringify({ sentAt: new Date().toISOString(), bdrEmail, flagType }) },
    update: { value: JSON.stringify({ sentAt: new Date().toISOString(), bdrEmail, flagType }) },
  })

  return res.json({ ok: true, sentTo: bdrEmail })
})

export default router
