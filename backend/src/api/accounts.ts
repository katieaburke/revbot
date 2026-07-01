import { Router } from 'express'
import { requireAdmin } from '../middleware/adminAuth'
import { fetchProspectAccounts, getSfdcInstanceUrl, updateProspectAccount } from '../services/salesforce'
import { buildAccountActivityIndex, buildFlowContactIndex, isGongAccountCacheWarm, warmGongAccountCallCache } from '../services/gong'
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

    const t0 = Date.now()

    // Check Gong account cache upfront — if cold, skip and warm in background
    const gongAccountWarm = await isGongAccountCacheWarm()
    if (!gongAccountWarm) {
      warmGongAccountCallCache().catch((err) => console.warn('[Gong] Account warm failed:', String(err)))
      console.warn('[Gong] Account cache cold — skipping Gong activity this run. Warming in background.')
    }

    const accounts = await fetchProspectAccounts(recordTypeFilter)
    console.log(`[Hygiene] SFDC accounts: ${Date.now() - t0}ms (${accounts.length} accounts)`)

    const accountIds = accounts.map((a) => a.Id)

    // Collect all contact emails across all accounts for flow lookup
    const allContactEmails = Array.from(
      new Set(
        accounts.flatMap((a) => (a.Contacts?.records ?? []).map((c) => c.Email).filter(Boolean) as string[])
      )
    )

    // Only fetch Gong activity if cache is warm — flow index has its own 25s internal timeout + error caching
    const tGong = Date.now()
    const [gongActivity, flowResult] = await Promise.all([
      gongAccountWarm ? buildAccountActivityIndex(accountIds) : Promise.resolve(new Map()),
      buildFlowContactIndex(allContactEmails),
    ])
    console.log(`[Hygiene] Gong: ${Date.now() - tGong}ms (accountWarm=${gongAccountWarm}, flowErr=${flowResult.error ?? 'none'})`)

    const flags = evaluateProspectingHygiene(accounts, gongActivity, { staleThresholdDays, recentActivityDays }, flowResult.index)

    // Load nudge log for all accounts so the UI can show last-sent + cooldown state
    const nudgeSettings = await db.appSetting.findMany({
      where: { key: { startsWith: 'bdrNudge:last:' } },
    })
    const nudgeLog: Record<string, { sentAt: string; bdrEmail: string; flagType: string }> = {}
    for (const s of nudgeSettings) {
      const accountId = s.key.replace('bdrNudge:last:', '')
      try { nudgeLog[accountId] = JSON.parse(s.value) } catch { /* skip malformed */ }
    }

    res.json({
      scannedAt: new Date().toISOString(),
      totalAccounts: accounts.length,
      flags,
      nudgeLog,
      flowError: flowResult.error,  // null = OK, string = error message for debugging
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
    accountId, accountName, flagType, bdrEmail, bdrName, ownerName,
    prospectingStatus, prospectingPauseReason,
    daysSinceLastRepContact, daysSinceLastGongCall, gongTotalCalls,
    lastRepCommunicationDate, gongLastCallDate, targetProspectingDate,
    reEngageDate, competitorEndDate, competitor,
  } = req.body as {
    accountId: string
    accountName: string
    flagType: ProspectingFlagType
    bdrEmail: string
    bdrName: string | null
    ownerName: string | null
    prospectingStatus: string | null
    prospectingPauseReason: string | null
    daysSinceLastRepContact: number | null
    daysSinceLastGongCall: number | null
    gongTotalCalls: number
    lastRepCommunicationDate: string | null
    gongLastCallDate: string | null
    targetProspectingDate: string | null
    reEngageDate: string | null
    competitorEndDate: string | null
    competitor: string | null
  }

  if (!bdrEmail) {
    return res.status(400).json({ error: 'No BDR email provided — account may not have a BDR assigned.' })
  }

  const slackUserId = await resolveSlackUserId(bdrEmail)
  if (!slackUserId) {
    return res.status(404).json({ error: `Could not find Slack user for ${bdrEmail}. Make sure they're in the workspace.` })
  }

  const sfdcInstanceUrl = await getSfdcInstanceUrl()
  const accountUrl = `${sfdcInstanceUrl.replace(/\/$/, '')}/lightning/r/Account/${accountId}/view`
  const bdrFirstName = bdrName?.split(' ')[0] ?? 'there'

  function fmtDate(iso: string | null): string {
    if (!iso) return '—'
    const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T12:00:00') : new Date(iso)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  function daysStr(days: number | null): string {
    if (days === null) return ''
    if (days === 0) return ' (today)'
    if (days === 1) return ' (1 day ago)'
    return ` (${days} days ago)`
  }

  // ── Header & situation summary ──────────────────────────────────────────────
  let headerText: string
  let situationText: string

  if (flagType === 'STALE_PROSPECTING') {
    const staleDays = daysSinceLastRepContact ?? daysSinceLastGongCall
    headerText = `👋 Hey ${bdrFirstName}, *${accountName}* has gone stale in prospecting`
    situationText = staleDays !== null
      ? `This account has been in *Prospecting* status for *${staleDays} days* with no rep communication or Gong call activity.`
      : `This account has been in *Prospecting* status with no recent activity on record.`
  } else if (flagType === 'STALE_TARGET_DATE') {
    headerText = `👋 Hey ${bdrFirstName}, *${accountName}*'s target date needs updating`
    situationText = `This account has recent outreach activity${gongTotalCalls > 0 ? ` (${gongTotalCalls} Gong call${gongTotalCalls !== 1 ? 's' : ''}, last ${fmtDate(gongLastCallDate)})` : ''} but the target prospecting date (*${fmtDate(targetProspectingDate)}*) hasn't been updated.`
  } else {
    headerText = `👋 Hey ${bdrFirstName}, *${accountName}* looks ready to move to Prospecting`
    situationText = `This account is in *Planned* status but has had recent outreach activity${gongTotalCalls > 0 ? ` (${gongTotalCalls} Gong call${gongTotalCalls !== 1 ? 's' : ''}, last ${fmtDate(gongLastCallDate)})` : ''}.`
  }

  // ── What to update ──────────────────────────────────────────────────────────
  const updateLines = flagType === 'STALE_TARGET_DATE'
    ? [
        `• *Target prospecting date* — update to reflect your current timeline`,
        `• *Prospecting Status* — update if the status has changed`,
        `• *Date to re-engage* — set if pausing or deferring`,
        `• *Incumbent vendor* & *contract end date* — fill in if you've identified competitive info`,
      ]
    : [
        `• *Prospecting Status* — move to Prospecting, Paused, or Nurturing as appropriate`,
        `• *Date to re-engage* — set if pausing or deferring`,
        `• *Hold reason* — set if pausing`,
        `• *Incumbent vendor* & *contract end date* — fill in if you've identified competitive info`,
      ]
  const updateText = `Please update the following in Salesforce:\n${updateLines.join('\n')}`

  // ── Current values (what we already know) ──────────────────────────────────
  const currentFields: { type: 'mrkdwn'; text: string }[] = []
  if (lastRepCommunicationDate) currentFields.push({ type: 'mrkdwn', text: `*Last rep contact*\n${fmtDate(lastRepCommunicationDate)}${daysStr(daysSinceLastRepContact)}` })
  if (gongLastCallDate) currentFields.push({ type: 'mrkdwn', text: `*Last Gong call*\n${fmtDate(gongLastCallDate)}${daysStr(daysSinceLastGongCall)}` })
  if (targetProspectingDate) currentFields.push({ type: 'mrkdwn', text: `*Target prospecting date*\n${fmtDate(targetProspectingDate)}` })
  if (reEngageDate) currentFields.push({ type: 'mrkdwn', text: `*Date to re-engage*\n${fmtDate(reEngageDate)}` })
  if (prospectingPauseReason) currentFields.push({ type: 'mrkdwn', text: `*Hold reason*\n${prospectingPauseReason}` })
  if (competitor) currentFields.push({ type: 'mrkdwn', text: `*Incumbent vendor*\n${competitor}` })
  if (competitorEndDate) currentFields.push({ type: 'mrkdwn', text: `*Vendor contract end*\n${fmtDate(competitorEndDate)}` })
  if (ownerName) currentFields.push({ type: 'mrkdwn', text: `*Account owner*\n${ownerName}` })

  const blocks: KnownBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: headerText } },
    { type: 'section', text: { type: 'mrkdwn', text: situationText } },
    { type: 'section', text: { type: 'mrkdwn', text: updateText } },
    ...(currentFields.length > 0
      ? [
          { type: 'divider' as const },
          { type: 'context' as const, elements: [{ type: 'mrkdwn' as const, text: '*Current values on record*' }] },
          { type: 'section' as const, fields: currentFields },
        ]
      : []),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Update Fields →', emoji: true },
          action_id: 'update_status_sfdc',
          value: JSON.stringify({ accountId, accountName, prospectingStatus, prospectingPauseReason, reEngageDate, competitor, competitorEndDate }),
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open in Salesforce', emoji: true },
          url: accountUrl,
          action_id: 'open_sfdc',
        },
      ],
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Sent via RevBot · ${prospectingStatus ?? 'Unknown'} status` }],
    },
  ]

  const plainText = `${flagType === 'STALE_PROSPECTING' ? '⚠️' : '✅'} ${accountName}: ${flagType === 'STALE_PROSPECTING' ? 'stale in prospecting' : 'ready to move to Prospecting'}`
  await sendDm(slackUserId, blocks, plainText)

  await db.appSetting.upsert({
    where: { key: `bdrNudge:last:${accountId}` },
    create: { key: `bdrNudge:last:${accountId}`, value: JSON.stringify({ sentAt: new Date().toISOString(), bdrEmail, flagType }) },
    update: { value: JSON.stringify({ sentAt: new Date().toISOString(), bdrEmail, flagType }) },
  })

  return res.json({ ok: true, sentTo: bdrEmail })
})

// GET /api/accounts/gong-flow-debug
// Bypasses Redis, hits Gong flows API directly, returns raw shape for one account's contacts.
router.get('/gong-flow-debug', async (req, res) => {
  try {
    const { redis } = await import('../redis')
    const { default: axios } = await import('axios')
    const { config } = await import('../config')

    // Optional: clear cache so we get a fresh hit
    await redis.del('gong:flow_contacts')

    const client = axios.create({
      baseURL: 'https://api.gong.io/v2',
      auth: { username: config.GONG_ACCESS_KEY, password: config.GONG_ACCESS_SECRET },
      timeout: 30_000,
    })

    // Step 1: list flows
    let flowsRaw: unknown = null
    let flowsError: string | null = null
    try {
      const r = await client.get('/flows')
      flowsRaw = r.data
    } catch (e: unknown) {
      const err = e as { response?: { status?: number; data?: unknown }; message?: string }
      flowsError = `${err.response?.status ?? ''} ${JSON.stringify(err.response?.data ?? err.message)}`
    }

    // Step 2: if flows came back, fetch contacts for the first flow
    let contactsRaw: unknown = null
    let contactsError: string | null = null
    if (flowsRaw && (flowsRaw as { flows?: { id: string }[] }).flows?.length) {
      const firstFlowId = (flowsRaw as { flows: { id: string }[] }).flows[0].id
      try {
        const r = await client.get(`/flows/${firstFlowId}/contacts`)
        contactsRaw = r.data
      } catch (e: unknown) {
        const err = e as { response?: { status?: number; data?: unknown }; message?: string }
        contactsError = `${err.response?.status ?? ''} ${JSON.stringify(err.response?.data ?? err.message)}`
      }
    }

    res.json({ flowsRaw, flowsError, contactsRaw, contactsError })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// PATCH /api/accounts/:accountId
// Update editable prospecting fields directly from Beacon (writes back to Salesforce).
router.patch('/:accountId', async (req, res) => {
  const { accountId } = req.params
  const { Prospecting_Status__c, Target_Prospecting_Date__c, Prospecting_Pause_Reason__c } = req.body as {
    Prospecting_Status__c?: string | null
    Target_Prospecting_Date__c?: string | null
    Prospecting_Pause_Reason__c?: string | null
  }
  try {
    await updateProspectAccount(accountId, { Prospecting_Status__c, Target_Prospecting_Date__c, Prospecting_Pause_Reason__c })
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ error: String(err) })
  }
})

export default router
