import { Router } from 'express'
import axios from 'axios'
import { db } from '../db'
import { verifyManagerToken, generateManagerToken } from '../lib/managerToken'
import { generateRepToken } from '../lib/repToken'
import { requireAdmin } from '../middleware/adminAuth'
import { getServiceConnection, fetchOpenOpportunities } from '../services/salesforce'
import { sendDm } from '../slack/bot'
import { config } from '../config'
import { stageApiToLabel } from '../utils/stageMapping'
import type { KnownBlock } from '@slack/web-api'

const router = Router()

const SFDC_BASE = 'https://uberall.lightning.force.com'

// Fetch live opp metadata from SFDC for a list of opp IDs
async function fetchOppMeta(oppIds: string[]): Promise<Map<string, {
  amount: number | null; closeDate: string | null; stage: string | null
  nextStep: string | null; nextStepDate: string | null
}>> {
  const map = new Map()
  if (!oppIds.length) return map
  try {
    const conn = await getServiceConnection()
    const ids = oppIds.map((id) => `'${id}'`).join(',')
    const soql = `SELECT Id, Amount, CloseDate, StageName, NextStep, Next_Step_Date__c FROM Opportunity WHERE Id IN (${ids})`
    const url = `${conn.instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`
    const resp = await axios.get<{ records: { Id: string; Amount: number | null; CloseDate: string | null; StageName: string; NextStep: string | null; Next_Step_Date__c: string | null }[] }>(
      url, { headers: { Authorization: `Bearer ${conn.accessToken!}` }, timeout: 15_000 }
    )
    for (const r of resp.data.records) {
      map.set(r.Id, {
        amount: r.Amount ?? null,
        closeDate: r.CloseDate ?? null,
        stage: stageApiToLabel(r.StageName),
        nextStep: r.NextStep ?? null,
        nextStepDate: r.Next_Step_Date__c ?? null,
      })
    }
  } catch (err) {
    console.warn('[ManagerPortal] Could not fetch live opp meta from SFDC:', err)
  }
  return map
}

// GET /api/manager/me?token=xxx
router.get('/me', async (req, res) => {
  const { token } = req.query as { token?: string }
  if (!token) return res.status(400).json({ error: 'Missing token' })

  // Verify token first — this is the only step that should return 401
  let slackUserId: string
  try {
    ;({ slackUserId } = verifyManagerToken(token))
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired link — ask RevOps for a fresh one' })
  }

  try {
    const managerUser = await db.user.findUnique({ where: { slackUserId } })
    if (!managerUser) return res.status(404).json({ error: 'Manager not found — make sure you have received a RevBot message' })

    const managerEmail = managerUser.slackEmail
    if (!managerEmail) return res.status(400).json({ error: 'Manager has no email on record' })

    // Derive direct reports from open opportunity Owner.Manager relationship
    // (uses cached SFDC opp data — same source RevBot alert job uses)
    const opps = await fetchOpenOpportunities()
    const repMap = new Map<string, { name: string; email: string }>()
    for (const opp of opps) {
      const mgr = opp.Owner?.Manager
      if (!mgr?.Email) continue
      if (mgr.Email.toLowerCase() !== managerEmail.toLowerCase()) continue
      const ownerEmail = opp.Owner?.Email
      const ownerName = opp.Owner?.Name
      if (ownerEmail && !repMap.has(ownerEmail.toLowerCase())) {
        repMap.set(ownerEmail.toLowerCase(), { name: ownerName ?? ownerEmail, email: ownerEmail })
      }
    }
    const directReports = [...repMap.values()]

    // Build rep summaries — include all direct reports even if not in our DB yet
    const reps = []
    const allOppIds: string[] = []
    type RawNotif = { id: string; opportunityId: string; opportunityName: string; alertType: string; alertDetails: unknown; status: string; sentAt: Date | null; snoozedUntil: Date | null }
    const repNotifMap = new Map<string, { repUser: typeof managerUser | null; sfdcName: string; notifs: RawNotif[]; totalNotified: number; oppNotifCounts: Map<string, number> }>()

    for (const rep of directReports) {
      const repUser = await db.user.findFirst({ where: { slackEmail: { equals: rep.email, mode: 'insensitive' } } })

      let notifs: RawNotif[] = []
      let totalNotified = 0
      let oppNotifCounts = new Map<string, number>()
      if (repUser) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = await (db as any).notification.findMany({
          where: { ownerId: repUser.id, status: { in: ['SENT', 'SNOOZED'] } },
          orderBy: { sentAt: 'desc' },
          select: { id: true, opportunityId: true, opportunityName: true, alertType: true, alertDetails: true, status: true, sentAt: true, snoozedUntil: true },
        }) as RawNotif[]

        // Unique opps with an open (non-resolved) flag
        const notifiedOpps = await db.notification.findMany({
          where: { ownerId: repUser.id, status: { in: ['SENT', 'SNOOZED'] } },
          select: { opportunityId: true },
          distinct: ['opportunityId'],
        })
        totalNotified = notifiedOpps.length

        // All-time notification count per opp (for "flagged N times" display)
        const oppCounts = await db.notification.groupBy({
          by: ['opportunityId'],
          where: { ownerId: repUser.id },
          _count: { id: true },
        })
        oppNotifCounts = new Map(oppCounts.map((r) => [r.opportunityId, r._count.id]))

        // Deduplicate active ones: one per opportunityId+alertType, newest first
        const seen = new Set<string>()
        notifs = raw.filter((n) => {
          const key = `${n.opportunityId}|${n.alertType}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        for (const n of notifs) allOppIds.push(n.opportunityId)
      }

      repNotifMap.set(rep.email.toLowerCase(), { repUser, sfdcName: rep.name, notifs, totalNotified, oppNotifCounts })
    }

    // Load dry run pending flags once, then slice per rep
    type DryRunEntry = { opportunityId: string; opportunityName: string; alertType: string; ownerEmail: string; details: Record<string, unknown> }
    let dryRunWouldSend: DryRunEntry[] = []
    try {
      const setting = await db.appSetting.findUnique({ where: { key: 'lastDryRunFullResults' } })
      if (setting?.value) {
        const parsed = JSON.parse(setting.value) as { wouldSend: DryRunEntry[] }
        dryRunWouldSend = parsed.wouldSend ?? []
      }
    } catch { /* non-fatal */ }

    // Batch fetch live opp meta
    const oppMeta = await fetchOppMeta([...new Set(allOppIds)])

    for (const rep of directReports) {
      const entry = repNotifMap.get(rep.email.toLowerCase())
      if (!entry) continue
      const { repUser, sfdcName, notifs, totalNotified, oppNotifCounts } = entry

      const notifications = notifs.map((n) => {
        const meta = oppMeta.get(n.opportunityId)
        const details = (n.alertDetails as Record<string, unknown>) ?? {}
        return {
          ...n,
          alertDetails: { ...details, ...(meta ?? {}) },
          totalFlagsForOpp: oppNotifCounts.get(n.opportunityId) ?? 1,
          sfdcUrl: `${SFDC_BASE}/lightning/r/Opportunity/${n.opportunityId}/view`,
          sentAt: n.sentAt?.toISOString() ?? null,
          snoozedUntil: n.snoozedUntil?.toISOString() ?? null,
        }
      })

      const openCount = notifications.filter((n) => n.status === 'SENT').length
      const snoozedCount = notifications.filter((n) => n.status === 'SNOOZED').length
      const portalToken = repUser?.slackUserId ? generateRepToken(repUser.slackUserId) : null
      const portalUrl = portalToken ? `${config.FRONTEND_URL ?? config.APP_URL}/my-flags?token=${portalToken}` : null

      // Pending: dry-run flags queued for this rep that aren't already active
      const activeKeys = new Set(notifications.filter((n) => n.status === 'SENT').map((n) => `${n.opportunityId}|${n.alertType}`))
      const pending = dryRunWouldSend
        .filter((f) => f.ownerEmail?.toLowerCase() === rep.email.toLowerCase() && !activeKeys.has(`${f.opportunityId}|${f.alertType}`))
        .slice(0, 10)

      reps.push({
        name: repUser?.slackName ?? sfdcName ?? rep.email,
        email: rep.email,
        slackUserId: repUser?.slackUserId ?? null,
        portalUrl,
        openCount,
        snoozedCount,
        totalNotified,
        pending,
        notifications,
      })
    }

    // Sort by openCount desc
    reps.sort((a, b) => b.openCount - a.openCount)

    // Fetch manager's role from SFDC
    let roleName: string | null = null
    try {
      const conn = await getServiceConnection()
      const roleQuery = `SELECT UserRole.Name FROM User WHERE Email = '${managerEmail}' LIMIT 1`
      const roleUrl = `${conn.instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(roleQuery)}`
      const roleResp = await axios.get<{ records: { UserRole: { Name: string } | null }[] }>(
        roleUrl,
        { headers: { Authorization: `Bearer ${conn.accessToken!}` }, timeout: 10_000 }
      )
      roleName = roleResp.data.records[0]?.UserRole?.Name ?? null
    } catch {
      // non-fatal — roleName stays null
    }

    res.json({
      manager: {
        name: managerUser.slackName ?? managerUser.slackEmail ?? 'Manager',
        email: managerUser.slackEmail,
        roleName,
      },
      reps,
    })
  } catch (err) {
    console.error('[ManagerPortal] /me error:', err)
    res.status(500).json({ error: 'Something went wrong loading your team data. Please try again.' })
  }
})

// POST /api/manager/snooze-for-rep
// Body: { token, notificationId, repSlackUserId, days?, snoozeUntil? }
router.post('/snooze-for-rep', async (req, res) => {
  const { token, notificationId, repSlackUserId, days, snoozeUntil } = req.body as {
    token?: string; notificationId?: string; repSlackUserId?: string; days?: number; snoozeUntil?: string
  }
  if (!token || !notificationId || !repSlackUserId || (!days && !snoozeUntil)) {
    return res.status(400).json({ error: 'Missing fields' })
  }

  try {
    verifyManagerToken(token)

    // Find the rep user
    const repUser = await db.user.findUnique({ where: { slackUserId: repSlackUserId } })
    if (!repUser) return res.status(404).json({ error: 'Rep not found' })

    // Verify notification belongs to that rep
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notif = await (db as any).notification.findFirst({
      where: { id: notificationId, ownerId: repUser.id, status: { in: ['SENT', 'SNOOZED'] } },
    })
    if (!notif) return res.status(404).json({ error: 'Notification not found' })

    const snoozedUntil = snoozeUntil
      ? new Date(snoozeUntil)
      : new Date(Date.now() + (days ?? 7) * 24 * 60 * 60 * 1000)

    await db.notification.update({
      where: { id: notificationId },
      data: { status: 'SNOOZED', snoozedUntil },
    })

    res.json({ ok: true, snoozedUntil: snoozedUntil.toISOString() })
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired link' })
  }
})

// POST /api/manager/send-portal-link
// Body: { token, repSlackUserId }
router.post('/send-portal-link', async (req, res) => {
  const { token, repSlackUserId } = req.body as { token?: string; repSlackUserId?: string }
  if (!token || !repSlackUserId) return res.status(400).json({ error: 'Missing fields' })

  try {
    verifyManagerToken(token)

    const repUser = await db.user.findUnique({ where: { slackUserId: repSlackUserId } })
    if (!repUser) return res.status(404).json({ error: 'Rep not found' })

    const portalToken = generateRepToken(repSlackUserId)
    const portalUrl = `${config.FRONTEND_URL ?? config.APP_URL}/my-flags?token=${portalToken}`

    const blocks: KnownBlock[] = [
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Your manager shared your RevBot flag dashboard with you',
          },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*<${portalUrl}|View your RevBot flags>*\nSee your open pipeline flags and snooze or action them.`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Open dashboard', emoji: true },
          url: portalUrl,
          action_id: 'open_rep_portal',
        },
      },
    ]

    await sendDm(repSlackUserId, blocks, 'Your manager shared your RevBot flag dashboard with you')

    res.json({ ok: true })
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired link' })
  }
})

// GET /api/manager/whitespace?token=xxx
router.get('/whitespace', async (req, res) => {
  const { token } = req.query as { token?: string }
  if (!token) return res.status(400).json({ error: 'Missing token' })

  let slackUserId: string
  try {
    ;({ slackUserId } = verifyManagerToken(token))
  } catch {
    return res.status(401).json({ error: 'Invalid or expired link' })
  }

  try {
    const managerUser = await db.user.findUnique({ where: { slackUserId } })
    if (!managerUser) return res.status(404).json({ error: 'Manager not found' })

    const managerEmail = managerUser.slackEmail
    if (!managerEmail) return res.status(400).json({ error: 'Manager has no email on record' })

    // Check role — only Existing Business managers get access
    let roleName: string | null = null
    try {
      const conn = await getServiceConnection()
      const roleQuery = `SELECT UserRole.Name FROM User WHERE Email = '${managerEmail}' LIMIT 1`
      const roleUrl = `${conn.instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(roleQuery)}`
      const roleResp = await axios.get<{ records: { UserRole: { Name: string } | null }[] }>(
        roleUrl,
        { headers: { Authorization: `Bearer ${conn.accessToken!}` }, timeout: 10_000 }
      )
      roleName = roleResp.data.records[0]?.UserRole?.Name ?? null
    } catch {
      // non-fatal
    }

    if (!roleName?.toLowerCase().includes('existing business')) {
      return res.json({ hasAccess: false, reps: [] })
    }

    const conn = await getServiceConnection()

    const soql = `
      SELECT
        Id,
        Name,
        Product_Coverage_Name__c,
        Account__c,
        Account__r.Name,
        Account__r.Owner.Email,
        Account__r.Owner.Name,
        Account__r.Next_Contract_End_Date__c,
        Current_Locations_Covered__c,
        Total_Locations_Fit__c,
        ARR_Potential__c,
        Priority__c,
        Price_per_location__c
      FROM Product_Coverage__c
      WHERE Current_Status__c = 'Has'
        AND (Total_Locations_Fit__c = null OR Total_Locations_Fit__c = 0)
        AND Account__r.RecordType.Name = 'Enterprise Account Record'
        AND Price_per_location__c > 0
        AND (NOT Account__r.Owner.UserRole.Name LIKE '%partner%')
        AND (NOT Account__r.Owner.UserRole.Name LIKE '%new business%')
        AND (NOT Product_Coverage_Name__c LIKE '%pull api%')
        AND (NOT Product_Coverage_Name__c LIKE '%services%')
        AND (NOT Product_Coverage_Name__c LIKE '%minimum commit%')
        AND (NOT Product_Coverage_Name__c LIKE '%package%')
        AND (NOT Product_Coverage_Name__c LIKE '%standalone%')
        AND (NOT Product_Coverage_Name__c LIKE '%fee%')
        AND (NOT Product_Coverage_Name__c LIKE '%bundle%')
        AND (NOT Product_Coverage_Name__c LIKE '%additional%')
        AND Account__r.Owner.Manager.Email = '${managerEmail}'
    `.trim()

    const url = `${conn.instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`
    const resp = await axios.get<{
      records: {
        Id: string
        Name: string
        Product_Coverage_Name__c: string | null
        Account__c: string
        Account__r: {
          Name: string
          Owner: { Email: string | null; Name: string | null }
          Next_Contract_End_Date__c: string | null
        } | null
        Current_Locations_Covered__c: number | null
        Total_Locations_Fit__c: number | null
        ARR_Potential__c: number | null
        Priority__c: string | null
        Price_per_location__c: number | null
      }[]
    }>(url, {
      headers: { Authorization: `Bearer ${conn.accessToken!}` },
      timeout: 20_000,
    })

    // Group by rep → account → lines
    type WsLine = { id: string; productCoverageName: string | null; currentLocationsCovered: number | null; currentArr: number; priority: string | null }
    type WsAccount = { accountId: string; accountName: string; contractEndDate: string | null; totalCurrentArr: number; lines: WsLine[] }
    type WsRep = { ownerEmail: string; ownerName: string; totalLines: number; totalCurrentArr: number; accounts: WsAccount[] }

    const repMap = new Map<string, WsRep & { accountMap: Map<string, WsAccount> }>()

    for (const r of resp.data.records) {
      const accountId = r.Account__c
      const accountName = r.Account__r?.Name ?? accountId
      const ownerEmail = r.Account__r?.Owner?.Email ?? ''
      const ownerName = r.Account__r?.Owner?.Name ?? ownerEmail
      const contractEndDate = r.Account__r?.Next_Contract_End_Date__c ?? null
      const pricePerLocation = r.Price_per_location__c ?? 0
      const currentLocationsCovered = r.Current_Locations_Covered__c ?? 0
      const currentArr = currentLocationsCovered * pricePerLocation * 12

      const repKey = ownerEmail.toLowerCase()

      if (!repMap.has(repKey)) {
        repMap.set(repKey, {
          ownerEmail,
          ownerName,
          totalLines: 0,
          totalCurrentArr: 0,
          accounts: [],
          accountMap: new Map(),
        })
      }

      const rep = repMap.get(repKey)!
      rep.totalLines += 1
      rep.totalCurrentArr += currentArr

      if (!rep.accountMap.has(accountId)) {
        const acct: WsAccount = { accountId, accountName, contractEndDate, totalCurrentArr: 0, lines: [] }
        rep.accountMap.set(accountId, acct)
        rep.accounts.push(acct)
      }

      const acct = rep.accountMap.get(accountId)!
      acct.totalCurrentArr += currentArr
      acct.lines.push({
        id: r.Id,
        productCoverageName: r.Product_Coverage_Name__c ?? r.Name,
        currentLocationsCovered: r.Current_Locations_Covered__c,
        currentArr,
        priority: r.Priority__c,
      })
    }

    const reps: WsRep[] = Array.from(repMap.values())
      .map((rep) => {
        rep.accounts.sort((a, b) => b.totalCurrentArr - a.totalCurrentArr)
        const { accountMap: _am, ...rest } = rep
        return rest
      })
      .sort((a, b) => a.ownerName.localeCompare(b.ownerName))

    res.json({ hasAccess: true, reps })
  } catch (err) {
    console.error('[ManagerPortal] /whitespace error:', err)
    res.status(500).json({ error: 'Failed to load whitespace data' })
  }
})

// POST /api/manager/admin/generate-link — requireAdmin
// Body: { email?, slackUserId? }
router.post('/admin/generate-link', requireAdmin, async (req, res) => {
  const { email, slackUserId } = req.body as { email?: string; slackUserId?: string }
  if (!email && !slackUserId) return res.status(400).json({ error: 'Provide email or slackUserId' })

  const user = await db.user.findFirst({
    where: email ? { slackEmail: email } : { slackUserId: slackUserId! },
  })
  if (!user) return res.status(404).json({ error: 'User not found' })
  if (!user.slackUserId) return res.status(400).json({ error: 'User has no Slack ID on record' })

  const token = generateManagerToken(user.slackUserId)

  res.json({ token, name: user.slackName ?? user.slackEmail, expiresIn: '30d' })
})

export default router
