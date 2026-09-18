import { Router } from 'express'
import { requireAdmin } from '../middleware/adminAuth'
import { fetchProspectAccounts, getSfdcInstanceUrl, updateProspectAccount, fetchContactFlows } from '../services/salesforce'
import { buildAccountActivityIndex, isGongAccountCacheWarm, warmGongAccountCallCache } from '../services/gong'
import type { GongFlowEnrollment } from '../services/gong'
import { evaluateProspectingHygiene, type ProspectingFlagType } from '../alerts/prospecting'
import { sendDm, resolveSlackUserId } from '../slack/bot'
import { db } from '../db'
import type { KnownBlock } from '@slack/web-api'

const router = Router()
router.use(requireAdmin)

const HYGIENE_CACHE_KEY = 'lastProspectingHygieneResult'
const HYGIENE_CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const HYGIENE_STATUS_KEY = 'prospectingHygieneScanStatus'

// A scan that dies leaves no trace the UI can see. The result cache only ever gets
// written on success, and the page decides the scan is finished by watching for
// `scannedAt` to change — so a thrown error means that value never moves and the
// spinner runs until someone reloads the tab. This row is how a failure becomes
// visible: it's written on every outcome, including the bad ones.
export interface HygieneScanStatus {
  state: 'running' | 'ok' | 'failed'
  startedAt: string
  finishedAt: string | null
  error: string | null
}

async function writeScanStatus(status: HygieneScanStatus): Promise<void> {
  const value = JSON.stringify(status)
  await db.appSetting
    .upsert({
      where: { key: HYGIENE_STATUS_KEY },
      create: { key: HYGIENE_STATUS_KEY, value },
      update: { value },
    })
    // Never let bookkeeping take down the scan it's reporting on.
    .catch((err) => console.error('[Hygiene] Failed to write scan status:', err))
}

async function readScanStatus(): Promise<HygieneScanStatus | null> {
  const row = await db.appSetting.findUnique({ where: { key: HYGIENE_STATUS_KEY } }).catch(() => null)
  if (!row?.value) return null
  try {
    return JSON.parse(row.value) as HygieneScanStatus
  } catch {
    return null
  }
}

// A full scan crawls a few thousand accounts out of Salesforce and is measured in
// minutes, so two clicks land two concurrent crawls that race to write the same
// cache row. Sharing the in-flight promise makes the second click join the first
// scan instead of starting a competing one.
let _hygieneScanInFlight: Promise<void> | null = null

/**
 * Runs a scan, caches the result, and records the outcome either way.
 *
 * Deliberately resolves rather than rejects on failure — every caller is a
 * fire-and-forget background trigger, and the interesting part of a failure is the
 * status row, not an unhandled rejection.
 */
function runAndCacheScan(): Promise<void> {
  if (_hygieneScanInFlight) return _hygieneScanInFlight

  const startedAt = new Date().toISOString()
  _hygieneScanInFlight = (async () => {
    await writeScanStatus({ state: 'running', startedAt, finishedAt: null, error: null })
    try {
      const result = await runProspectingHygieneScan()
      const value = JSON.stringify(result)
      await db.appSetting.upsert({
        where: { key: HYGIENE_CACHE_KEY },
        create: { key: HYGIENE_CACHE_KEY, value },
        update: { value },
      })
      await writeScanStatus({ state: 'ok', startedAt, finishedAt: new Date().toISOString(), error: null })
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      console.error('[Hygiene] Scan failed:', message)
      await writeScanStatus({ state: 'failed', startedAt, finishedAt: new Date().toISOString(), error: message })
    } finally {
      _hygieneScanInFlight = null
    }
  })()

  return _hygieneScanInFlight
}

async function runProspectingHygieneScan(): Promise<object> {
  const settings = await db.appSetting.findMany({
    where: { key: { in: ['accountRecordTypeFilter', 'prospectingStaleThresholdDays', 'prospectingRecentActivityDays'] } },
  })
  const settingMap = Object.fromEntries(settings.map((s) => [s.key, JSON.parse(s.value)]))
  const recordTypeFilter = (settingMap.accountRecordTypeFilter as string) ?? 'Enterprise_Account_Record'
  const staleThresholdDays = Number(settingMap.prospectingStaleThresholdDays ?? 14)
  const recentActivityDays = Number(settingMap.prospectingRecentActivityDays ?? 14)

  const gongAccountWarm = await isGongAccountCacheWarm()
  if (!gongAccountWarm) {
    warmGongAccountCallCache().catch((err) => console.warn('[Gong] Account warm failed:', String(err)))
  }

  // Per-stage timings. "The scan was slow" is unactionable; "contact flows took 94s"
  // points straight at the query to fix.
  const t0 = Date.now()
  const lap = (label: string, since: number) => console.log(`[Hygiene] ${label}: ${Date.now() - since}ms`)

  const tAccounts = Date.now()
  const accounts = await fetchProspectAccounts(recordTypeFilter)
  lap(`fetched ${accounts.length} accounts`, tAccounts)
  const accountIds = accounts.map((a) => a.Id)

  const tParallel = Date.now()
  const [gongActivity, contactFlows] = await Promise.all([
    gongAccountWarm ? buildAccountActivityIndex(accountIds) : Promise.resolve(new Map()),
    fetchContactFlows(accountIds),
  ])
  lap(`gong activity + ${contactFlows.length} contact flows`, tParallel)

  const flowIndex = new Map<string, GongFlowEnrollment[]>()
  for (const cf of contactFlows) {
    if (!flowIndex.has(cf.email)) flowIndex.set(cf.email, [])
    flowIndex.get(cf.email)!.push({
      flowId: cf.flowName,
      flowName: cf.flowName,
      status: cf.flowStatus,
      nextStepDueDate: cf.nextStepDueDate,
      completedAt: null,
    })
  }

  const flags = evaluateProspectingHygiene(accounts, gongActivity, { staleThresholdDays, recentActivityDays }, flowIndex)

  const nudgeSettings = await db.appSetting.findMany({ where: { key: { startsWith: 'bdrNudge:last:' } } })
  const nudgeLog: Record<string, { sentAt: string; bdrEmail: string; flagType: string }> = {}
  for (const s of nudgeSettings) {
    const accountId = s.key.replace('bdrNudge:last:', '')
    try { nudgeLog[accountId] = JSON.parse(s.value) } catch { /* skip */ }
  }

  lap('total scan', t0)

  return {
    scannedAt: new Date().toISOString(),
    totalAccounts: accounts.length,
    flags,
    nudgeLog,
    flowError: null,
    config: { recordTypeFilter, staleThresholdDays, recentActivityDays },
  }
}

// GET /api/accounts/prospecting-hygiene
// Serves cached scan result immediately; triggers background refresh if stale.
router.get('/prospecting-hygiene', async (_req, res) => {
  try {
    // Serve cached result instantly if available
    const [cached, scanStatus] = await Promise.all([
      db.appSetting.findUnique({ where: { key: HYGIENE_CACHE_KEY } }),
      readScanStatus(),
    ])
    if (cached?.value) {
      const parsed = JSON.parse(cached.value) as { scannedAt?: string } & object
      const ageMs = parsed.scannedAt ? Date.now() - new Date(parsed.scannedAt).getTime() : Infinity
      // Return cached data immediately — always fast. `scanStatus` rides along so a
      // polling client can tell "still working" apart from "died ten minutes ago",
      // which are identical from the cache's point of view.
      res.json({ ...parsed, scanStatus })
      // Kick off background refresh if cache is stale (>10 min)
      if (ageMs > HYGIENE_CACHE_TTL_MS) void runAndCacheScan()
      return
    }

    // No cache yet — run synchronously for first-ever load and save result
    await runAndCacheScan()
    const fresh = await db.appSetting.findUnique({ where: { key: HYGIENE_CACHE_KEY } })
    const status = await readScanStatus()
    if (!fresh?.value) {
      // The first-ever scan failed, so there's nothing to show. Say so plainly
      // instead of returning an empty shell the page would render as "0 flags".
      res.status(502).json({ error: status?.error ?? 'Prospecting hygiene scan failed', scanStatus: status })
      return
    }
    res.json({ ...(JSON.parse(fresh.value) as object), scanStatus: status })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// POST /api/accounts/prospecting-hygiene/refresh
// Triggers a background refresh of the cache; returns immediately.
router.post('/prospecting-hygiene/refresh', async (_req, res) => {
  res.status(202).json({ status: 'refreshing' })
  void runAndCacheScan()
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
