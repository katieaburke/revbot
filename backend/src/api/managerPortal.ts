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

  try {
    const { slackUserId } = verifyManagerToken(token)
    const managerUser = await db.user.findUnique({ where: { slackUserId } })
    if (!managerUser) return res.status(404).json({ error: 'Manager not found' })

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
    const repNotifMap = new Map<string, { repUser: typeof managerUser | null; sfdcName: string; notifs: RawNotif[] }>()

    for (const rep of directReports) {
      const repUser = await db.user.findFirst({ where: { slackEmail: { equals: rep.email, mode: 'insensitive' } } })

      let notifs: RawNotif[] = []
      if (repUser) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = await (db as any).notification.findMany({
          where: { ownerId: repUser.id, status: { in: ['SENT', 'SNOOZED'] } },
          orderBy: { sentAt: 'desc' },
          select: { id: true, opportunityId: true, opportunityName: true, alertType: true, alertDetails: true, status: true, sentAt: true, snoozedUntil: true },
        }) as RawNotif[]

        // Deduplicate: one per opportunityId+alertType, newest first
        const seen = new Set<string>()
        notifs = raw.filter((n) => {
          const key = `${n.opportunityId}|${n.alertType}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        for (const n of notifs) allOppIds.push(n.opportunityId)
      }

      repNotifMap.set(rep.email.toLowerCase(), { repUser, sfdcName: rep.name, notifs })
    }

    // Batch fetch live opp meta
    const oppMeta = await fetchOppMeta([...new Set(allOppIds)])

    for (const rep of directReports) {
      const entry = repNotifMap.get(rep.email.toLowerCase())
      if (!entry) continue
      const { repUser, sfdcName, notifs } = entry

      const notifications = notifs.map((n) => {
        const meta = oppMeta.get(n.opportunityId)
        const details = (n.alertDetails as Record<string, unknown>) ?? {}
        return {
          ...n,
          alertDetails: { ...details, ...(meta ?? {}) },
          sfdcUrl: `${SFDC_BASE}/lightning/r/Opportunity/${n.opportunityId}/view`,
          sentAt: n.sentAt?.toISOString() ?? null,
          snoozedUntil: n.snoozedUntil?.toISOString() ?? null,
        }
      })

      const openCount = notifications.filter((n) => n.status === 'SENT').length
      const snoozedCount = notifications.filter((n) => n.status === 'SNOOZED').length
      const portalToken = repUser?.slackUserId ? generateRepToken(repUser.slackUserId) : null
      const portalUrl = portalToken ? `${config.FRONTEND_URL ?? config.APP_URL}/my-flags?token=${portalToken}` : null

      reps.push({
        name: repUser?.slackName ?? sfdcName ?? rep.email,
        email: rep.email,
        slackUserId: repUser?.slackUserId ?? null,
        portalUrl,
        openCount,
        snoozedCount,
        notifications,
      })
    }

    // Sort by openCount desc
    reps.sort((a, b) => b.openCount - a.openCount)

    res.json({
      manager: {
        name: managerUser.slackName ?? managerUser.slackEmail ?? 'Manager',
        email: managerUser.slackEmail,
      },
      reps,
    })
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired link — ask RevBot for a fresh one' })
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
