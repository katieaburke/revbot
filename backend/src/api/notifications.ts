import { Router } from 'express'
import { db } from '../db'
import { requireAdmin } from '../middleware/adminAuth'
import { triggerAlertJobNow } from '../jobs/scheduler'
import { sendDm } from '../slack/bot'
import { buildPastDueMessage, buildStalledMessage, buildMeddpiccMessage } from '../slack/messages'
import { AlertType } from '../types'
import { z } from 'zod'

const router = Router()
router.use(requireAdmin)

// List all notifications with filtering
router.get('/', async (req, res) => {
  const { status, alertType, page = '1', limit = '50' } = req.query as Record<string, string>

  const notifications = await db.notification.findMany({
    where: {
      ...(status ? { status: status as never } : {}),
      ...(alertType ? { alertType: alertType as AlertType } : {}),
    },
    include: { owner: { select: { slackName: true, slackEmail: true, slackUserId: true } } },
    orderBy: { sentAt: 'desc' },
    take: parseInt(limit),
    skip: (parseInt(page) - 1) * parseInt(limit),
  })

  const total = await db.notification.count({
    where: {
      ...(status ? { status: status as never } : {}),
      ...(alertType ? { alertType: alertType as AlertType } : {}),
    },
  })

  res.json({ notifications, total, page: parseInt(page), limit: parseInt(limit) })
})

// Get summary counts for dashboard
router.get('/summary', async (_req, res) => {
  const [total, sent, snoozed, resolved, byType] = await Promise.all([
    db.notification.count(),
    db.notification.count({ where: { status: 'SENT' } }),
    db.notification.count({ where: { status: 'SNOOZED' } }),
    db.notification.count({ where: { status: 'RESOLVED' } }),
    db.notification.groupBy({ by: ['alertType'], _count: { id: true }, where: { status: 'SENT' } }),
  ])

  res.json({ total, sent, snoozed, resolved, byType })
})

// Trigger an immediate alert run
router.post('/run-now', async (_req, res) => {
  try {
    const jobId = await triggerAlertJobNow()
    res.json({ jobId, message: 'Alert job queued' })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// RevOps manually nudge an opportunity owner
const nudgeSchema = z.object({
  opportunityId: z.string(),
  opportunityName: z.string(),
  targetUserSlackId: z.string(),
  alertType: z.nativeEnum(AlertType),
  customMessage: z.string().optional(),
  // For past due nudge
  closeDate: z.string().optional(),
  daysOverdue: z.number().optional(),
  oppType: z.string().optional(),
  // For stalled nudge
  stage: z.string().optional(),
  dealAgeDays: z.number().optional(),
  // For MEDDPICC nudge
  missingFields: z.array(z.string()).optional(),
  sfdcFieldMap: z.record(z.string()).optional(),
})

router.post('/nudge', async (req, res) => {
  try {
    const payload = nudgeSchema.parse(req.body)
    const { targetUserSlackId, alertType, customMessage, ...alertData } = payload

    const targetUser = await db.user.findUnique({ where: { slackUserId: targetUserSlackId } })
    if (!targetUser) return res.status(404).json({ error: 'Target user not found' })

    // Build the appropriate Block Kit message
    let blocks
    const isNudge = true

    if (alertType === AlertType.PAST_DUE_INITIAL || alertType === AlertType.PAST_DUE_AMENDMENT || alertType === AlertType.PAST_DUE_RENEWAL) {
      blocks = buildPastDueMessage({ alertType, ownerEmail: targetUser.slackEmail, ownerSfdcId: targetUser.sfdcUserId ?? '', ...alertData } as never, isNudge)
    } else if (alertType === AlertType.STALLED) {
      blocks = buildStalledMessage({ alertType: AlertType.STALLED, ownerEmail: targetUser.slackEmail, ownerSfdcId: targetUser.sfdcUserId ?? '', triggeredBy: [], ruleId: '', stageDurationDays: null, ...alertData } as never, isNudge)
    } else {
      blocks = buildMeddpiccMessage({ alertType: AlertType.MEDDPICC_MISSING, ownerEmail: targetUser.slackEmail, ownerSfdcId: targetUser.sfdcUserId ?? '', missingFields: (alertData.missingFields ?? []) as never, sfdcFieldMap: (alertData.sfdcFieldMap ?? {}) as never, ...alertData } as never, isNudge)
    }

    // Append custom message if provided
    if (customMessage) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `_RevOps note: ${customMessage}_` },
      } as never)
    }

    const ts = await sendDm(targetUserSlackId, blocks, `RevOps follow-up: ${alertData.opportunityName as string}`)

    // Log the nudge
    // Get sender from token (simplified — full impl would decode JWT)
    await db.nudgeLog.create({
      data: {
        opportunityId: alertData.opportunityId,
        opportunityName: alertData.opportunityName,
        nudgedById: targetUser.id, // TODO: replace with actual sender from JWT
        targetUserId: targetUser.id,
        alertType,
        customMessage: customMessage ?? null,
        slackMessageTs: ts ?? null,
      },
    })

    res.json({ ok: true, ts })
  } catch (err) {
    res.status(400).json({ error: String(err) })
  }
})

export default router
