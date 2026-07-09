import { Router } from 'express'
import { db } from '../db'
import { verifyRepToken, generateRepToken } from '../lib/repToken'
import { requireAdmin } from '../middleware/adminAuth'

const router = Router()

const SFDC_BASE = 'https://uberall.lightning.force.com'

// GET /api/rep/me?token=xxx
// Returns the authenticated rep's open notifications
router.get('/me', async (req, res) => {
  const { token } = req.query as { token?: string }
  if (!token) return res.status(400).json({ error: 'Missing token' })

  try {
    const { slackUserId } = verifyRepToken(token)

    const user = await db.user.findUnique({ where: { slackUserId } })
    if (!user) return res.status(404).json({ error: 'User not found' })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notifications = await (db as any).notification.findMany({
      where: {
        ownerId: user.id,
        status: { in: ['SENT', 'SNOOZED'] },
      },
      orderBy: { sentAt: 'desc' },
      select: {
        id: true,
        opportunityId: true,
        opportunityName: true,
        alertType: true,
        alertDetails: true,
        status: true,
        sentAt: true,
        snoozedUntil: true,
      },
    })

    res.json({
      rep: {
        name: user.slackName ?? user.slackEmail ?? 'Rep',
        email: user.slackEmail,
      },
      notifications: notifications.map((n: {
        id: string
        opportunityId: string
        opportunityName: string
        alertType: string
        alertDetails: unknown
        status: string
        sentAt: Date | null
        snoozedUntil: Date | null
      }) => ({
        ...n,
        sfdcUrl: `${SFDC_BASE}/lightning/r/Opportunity/${n.opportunityId}/view`,
        sentAt: n.sentAt?.toISOString() ?? null,
        snoozedUntil: n.snoozedUntil?.toISOString() ?? null,
      })),
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
