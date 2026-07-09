import { Router } from 'express'
import axios from 'axios'
import { db } from '../db'
import { verifyRepToken, generateRepToken } from '../lib/repToken'
import { requireAdmin } from '../middleware/adminAuth'
import { getServiceConnection } from '../services/salesforce'
import { stageApiToLabel } from '../utils/stageMapping'
import { recheckForRep } from '../jobs/alertOrchestrator'

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
    console.warn('[RepPortal] Could not fetch live opp meta from SFDC:', err)
  }
  return map
}

// GET /api/rep/me?token=xxx
router.get('/me', async (req, res) => {
  const { token } = req.query as { token?: string }
  if (!token) return res.status(400).json({ error: 'Missing token' })

  try {
    const { slackUserId } = verifyRepToken(token)
    const user = await db.user.findUnique({ where: { slackUserId } })
    if (!user) return res.status(404).json({ error: 'User not found' })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await (db as any).notification.findMany({
      where: { ownerId: user.id, status: { in: ['SENT', 'SNOOZED'] } },
      orderBy: { sentAt: 'desc' },
      select: { id: true, opportunityId: true, opportunityName: true, alertType: true, alertDetails: true, status: true, sentAt: true, snoozedUntil: true },
    })

    // Deduplicate: one notification per opportunityId+alertType, newest first
    const seen = new Set<string>()
    const deduped = (raw as { id: string; opportunityId: string; opportunityName: string; alertType: string; alertDetails: unknown; status: string; sentAt: Date | null; snoozedUntil: Date | null }[])
      .filter((n) => {
        const key = `${n.opportunityId}|${n.alertType}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

    // Fetch live opp data from SFDC to ensure ACV/close date/stage are current
    const oppIds = [...new Set(deduped.map((n) => n.opportunityId))]
    const oppMeta = await fetchOppMeta(oppIds)

    const notifications = deduped.map((n) => {
      const meta = oppMeta.get(n.opportunityId)
      const details = (n.alertDetails as Record<string, unknown>) ?? {}
      return {
        ...n,
        alertDetails: {
          ...details,
          // Overlay with live SFDC data (always current)
          ...(meta ?? {}),
        },
        sfdcUrl: `${SFDC_BASE}/lightning/r/Opportunity/${n.opportunityId}/view`,
        sentAt: n.sentAt?.toISOString() ?? null,
        snoozedUntil: n.snoozedUntil?.toISOString() ?? null,
      }
    })

    // Pending: flags in the last dry run that would be sent to this rep
    let pending: { opportunityId: string; opportunityName: string; alertType: string; details: Record<string, unknown> }[] = []
    try {
      const setting = await db.appSetting.findUnique({ where: { key: 'lastDryRunFullResults' } })
      if (setting?.value) {
        const dryRun = JSON.parse(setting.value) as { wouldSend: { opportunityId: string; opportunityName: string; alertType: string; ownerEmail: string; details: Record<string, unknown> }[] }
        const repEmail = user.slackEmail?.toLowerCase()
        if (repEmail) {
          // Exclude opps already in their active notifications
          const notifOppAlertKeys = new Set(notifications.filter(n => n.status === 'SENT').map(n => `${n.opportunityId}|${n.alertType}`))
          pending = (dryRun.wouldSend ?? [])
            .filter((a) => a.ownerEmail?.toLowerCase() === repEmail && !notifOppAlertKeys.has(`${a.opportunityId}|${a.alertType}`))
            .slice(0, 10)
        }
      }
    } catch { /* non-fatal */ }

    res.json({
      rep: { name: user.slackName ?? user.slackEmail ?? 'Rep', email: user.slackEmail },
      notifications,
      pending,
    })
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired link — ask RevBot for a fresh one' })
  }
})

// POST /api/rep/snooze
// Body: { token, notificationId, days } OR { token, notificationId, snoozeUntil: ISO string }
router.post('/snooze', async (req, res) => {
  const { token, notificationId, days, snoozeUntil } = req.body as {
    token?: string; notificationId?: string; days?: number; snoozeUntil?: string
  }
  if (!token || !notificationId || (!days && !snoozeUntil)) return res.status(400).json({ error: 'Missing fields' })

  try {
    const { slackUserId } = verifyRepToken(token)
    const user = await db.user.findUnique({ where: { slackUserId } })
    if (!user) return res.status(404).json({ error: 'User not found' })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notif = await (db as any).notification.findFirst({
      where: { id: notificationId, ownerId: user.id, status: { in: ['SENT', 'SNOOZED'] } },
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

// POST /api/rep/update-close-date
router.post('/update-close-date', async (req, res) => {
  const { token, opportunityId, closeDate } = req.body as {
    token?: string; opportunityId?: string; closeDate?: string
  }
  if (!token || !opportunityId || !closeDate) return res.status(400).json({ error: 'Missing fields' })

  try {
    const { slackUserId } = verifyRepToken(token)
    const user = await db.user.findUnique({ where: { slackUserId } })
    if (!user) return res.status(404).json({ error: 'User not found' })

    const conn = await getServiceConnection()
    await conn.sobject('Opportunity').update({ Id: opportunityId, CloseDate: closeDate })

    await db.notification.updateMany({
      where: { opportunityId, ownerId: user.id, status: { in: ['SENT', 'SNOOZED'] } },
      data: { status: 'RESOLVED', resolvedAt: new Date(), sfdcUpdatedAt: new Date(), sfdcUpdateFields: { CloseDate: closeDate } as never },
    })

    res.json({ ok: true })
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired link' })
  }
})

// POST /api/rep/update-next-step
router.post('/update-next-step', async (req, res) => {
  const { token, opportunityId, nextStep, nextStepDate } = req.body as {
    token?: string; opportunityId?: string; nextStep?: string; nextStepDate?: string
  }
  if (!token || !opportunityId) return res.status(400).json({ error: 'Missing fields' })

  try {
    const { slackUserId } = verifyRepToken(token)
    const user = await db.user.findUnique({ where: { slackUserId } })
    if (!user) return res.status(404).json({ error: 'User not found' })

    const fields: Record<string, unknown> = {}
    if (nextStep?.trim()) fields.NextStep = nextStep.trim()
    if (nextStepDate) fields.Next_Step_Date__c = nextStepDate

    if (!Object.keys(fields).length) return res.status(400).json({ error: 'Provide nextStep or nextStepDate' })

    const conn = await getServiceConnection()
    await conn.sobject('Opportunity').update({ Id: opportunityId, ...fields })

    await db.notification.updateMany({
      where: { opportunityId, ownerId: user.id, alertType: 'NEXT_STEP_MISSING', status: { in: ['SENT', 'SNOOZED'] } },
      data: { status: 'RESOLVED', resolvedAt: new Date(), sfdcUpdatedAt: new Date(), sfdcUpdateFields: fields as never },
    })

    res.json({ ok: true })
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired link' })
  }
})

// POST /api/rep/recheck — re-evaluate alerts for this rep using cached data
router.post('/recheck', async (req, res) => {
  const { token } = req.body as { token?: string }
  if (!token) return res.status(400).json({ error: 'Missing token' })

  try {
    const { slackUserId } = verifyRepToken(token)
    const user = await db.user.findUnique({ where: { slackUserId } })
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (!user.slackEmail) return res.status(400).json({ error: 'No email on record' })

    const result = await recheckForRep(user.slackEmail)
    res.json(result)
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired link' })
  }
})

// ── Admin: generate a magic link for any rep (by email or slackUserId) ───────
// POST /api/rep/admin/generate-link  — requires admin JWT

router.post('/admin/generate-link', requireAdmin, async (req, res) => {
  const { email, slackUserId } = req.body as { email?: string; slackUserId?: string }
  if (!email && !slackUserId) return res.status(400).json({ error: 'Provide email or slackUserId' })

  const user = await db.user.findFirst({
    where: email ? { slackEmail: email } : { slackUserId: slackUserId! },
  })
  if (!user) return res.status(404).json({ error: 'User not found' })
  if (!user.slackUserId) return res.status(400).json({ error: 'User has no Slack ID on record' })

  const token = generateRepToken(user.slackUserId)

  res.json({ token, name: user.slackName ?? user.slackEmail, expiresIn: '30d' })
})

export default router
