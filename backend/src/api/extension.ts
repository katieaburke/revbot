import { Router } from 'express'
import { db } from '../db'
import { buildOpportunityActivityIndex, isSingleThreaded, daysSinceLastGongCall } from '../services/gong'
import { AlertType } from '../types'
import { sendDm } from '../slack/bot'
import { buildPastDueMessage, buildStalledMessage, buildMeddpiccMessage } from '../slack/messages'
import { z } from 'zod'

const router = Router()

// ── Extension API key auth ─────────────────────────────────────────────────

async function requireExtensionKey(
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction
) {
  const key = req.headers['x-extension-key'] as string | undefined

  if (!key) return res.status(401).json({ error: 'Missing X-Extension-Key' })

  // Key is stored in AppSetting — RevOps generates it from admin UI
  const setting = await db.appSetting.findUnique({ where: { key: 'extensionApiKey' } })
  if (!setting || JSON.parse(setting.value) !== key) {
    return res.status(401).json({ error: 'Invalid extension key' })
  }

  next()
}

router.use(requireExtensionKey)

// ── Deal health endpoint ───────────────────────────────────────────────────

router.get('/deal-health/:opportunityId', async (req, res) => {
  const { opportunityId } = req.params

  // Fetch active notifications for this opp
  const notifications = await db.notification.findMany({
    where: {
      opportunityId,
      status: { in: ['SENT', 'SNOOZED'] },
    },
    include: {
      owner: { select: { slackName: true, slackEmail: true, slackUserId: true } },
    },
    orderBy: { sentAt: 'desc' },
  })

  // Pull Gong activity from cache (or fetch if cold)
  const gongMap = await buildOpportunityActivityIndex([opportunityId])
  const gongActivity = gongMap.get(opportunityId)

  res.json({
    opportunityId,
    opportunityName: notifications[0]?.opportunityName ?? '',
    activeAlerts: notifications.map((n: typeof notifications[number]) => ({
      id: n.id,
      alertType: n.alertType,
      alertDetails: n.alertDetails,
      status: n.status,
      sentAt: n.sentAt,
      snoozedUntil: n.snoozedUntil ?? undefined,
      owner: n.owner,
    })),
    gongLastCallDate: gongActivity?.lastCallDate ?? null,
    gongTotalCalls: gongActivity?.totalCalls ?? 0,
    gongSingleThreaded: gongActivity ? isSingleThreaded(gongActivity) : false,
  })
})

// ── Extension nudge ────────────────────────────────────────────────────────

const nudgeSchema = z.object({
  opportunityId: z.string(),
  opportunityName: z.string(),
  targetUserSlackId: z.string(),
  alertType: z.nativeEnum(AlertType),
  customMessage: z.string().optional(),
  senderEmail: z.string().email(),
})

router.post('/nudge', async (req, res) => {
  try {
    const payload = nudgeSchema.parse(req.body)

    const targetUser = await db.user.findUnique({ where: { slackUserId: payload.targetUserSlackId } })
    if (!targetUser) return res.status(404).json({ error: 'Target user not found' })

    const sender = await db.user.findUnique({ where: { slackEmail: payload.senderEmail } })
    if (!sender) return res.status(404).json({ error: 'Sender not found — ensure your email is registered' })

    if (!sender.isRevOps) return res.status(403).json({ error: 'Only RevOps members can send nudges' })

    // Get the latest alert details for this opp+type to build the message
    const latestAlert = await db.notification.findFirst({
      where: { opportunityId: payload.opportunityId, alertType: payload.alertType },
      orderBy: { sentAt: 'desc' },
    })

    const alertDetails = (latestAlert?.alertDetails ?? {}) as Record<string, unknown>
    let blocks

    if (payload.alertType === AlertType.PAST_DUE_INITIAL || payload.alertType === AlertType.PAST_DUE_AMENDMENT || payload.alertType === AlertType.PAST_DUE_RENEWAL) {
      blocks = buildPastDueMessage({ alertType: payload.alertType, ownerEmail: targetUser.slackEmail, ownerSfdcId: targetUser.sfdcUserId ?? '', ...alertDetails } as never, true)
    } else if (payload.alertType === AlertType.STALLED) {
      blocks = buildStalledMessage({ alertType: AlertType.STALLED, ownerEmail: targetUser.slackEmail, ownerSfdcId: targetUser.sfdcUserId ?? '', triggeredBy: [], ruleId: '', stageDurationDays: null, dealAgeDays: 0, stage: '', opportunityId: payload.opportunityId, opportunityName: payload.opportunityName, ...alertDetails } as never, true)
    } else {
      blocks = buildMeddpiccMessage({ alertType: AlertType.MEDDPICC_MISSING, ownerEmail: targetUser.slackEmail, ownerSfdcId: targetUser.sfdcUserId ?? '', missingFields: [], sfdcFieldMap: {}, opportunityId: payload.opportunityId, opportunityName: payload.opportunityName, stage: '', ...alertDetails } as never, true)
    }

    if (payload.customMessage) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `_From ${sender.slackName ?? sender.slackEmail}: ${payload.customMessage}_` },
      } as never)
    }

    const ts = await sendDm(payload.targetUserSlackId, blocks, `RevOps nudge: ${payload.opportunityName}`)

    await db.nudgeLog.create({
      data: {
        opportunityId: payload.opportunityId,
        opportunityName: payload.opportunityName,
        nudgedById: sender.id,
        targetUserId: targetUser.id,
        alertType: payload.alertType,
        customMessage: payload.customMessage ?? null,
        slackMessageTs: ts ?? null,
      },
    })

    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: String(err) })
  }
})

export default router
