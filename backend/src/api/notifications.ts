import { Router } from 'express'
import { db } from '../db'
import { requireAdmin } from '../middleware/adminAuth'
import { triggerAlertJobNow } from '../jobs/scheduler'
import { runDryRun } from '../jobs/alertOrchestrator'
import { sendDm } from '../slack/bot'
import { buildCombinedMessage, buildPastDueMessage, buildStalledMessage, buildMeddpiccMessage, buildManagerAlertMessage } from '../slack/messages'
import { AlertType } from '../types'
import { getServiceConnection } from '../services/salesforce'
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

// Sent notification counts per opportunity (for the dashboard badges)
router.get('/opp-counts', async (req, res) => {
  const { oppIds } = req.query as { oppIds?: string }
  const ids = oppIds ? oppIds.split(',').filter(Boolean) : []
  if (!ids.length) return res.json({})

  const rows = await db.notification.groupBy({
    by: ['opportunityId'],
    _count: { id: true },
    where: { opportunityId: { in: ids } },
  })

  const result: Record<string, number> = {}
  for (const row of rows) result[row.opportunityId] = row._count.id
  res.json(result)
})

// Get persisted dry run results from the last run
router.get('/last-dry-run', async (_req, res) => {
  const setting = await db.appSetting.findUnique({ where: { key: 'lastDryRunFullResults' } })
  if (!setting) return res.json(null)
  res.json(JSON.parse(setting.value))
})

// Notify a deal owner's manager about flagged alerts
router.post('/notify-manager', async (req, res) => {
  try {
    const { opportunityId, opportunityName, ownerName, managerSlackId, alerts } = req.body as {
      opportunityId: string
      opportunityName: string
      ownerName: string
      managerSlackId: string
      alerts: { alertType: string; details: Record<string, unknown> }[]
    }
    if (!managerSlackId) return res.status(400).json({ error: 'No Slack ID for manager' })

    const blocks = await buildManagerAlertMessage(opportunityId, opportunityName, ownerName, alerts)
    const ts = await sendDm(managerSlackId, blocks, `FYI: ${opportunityName} needs attention`)
    res.json({ ok: true, ts })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
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

// Dry run — evaluates all alerts against live data, returns what would be sent, nothing is sent
router.post('/dry-run', async (_req, res) => {
  try {
    const result = await runDryRun({ bustGongCache: true })
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// Send a drafted alert for a single opp to the rep
router.post('/send-draft', async (req, res) => {
  try {
    const { opportunityId, opportunityName, ownerSlackId, ownerEmail, alerts } = req.body as {
      opportunityId: string
      opportunityName: string
      ownerSlackId: string
      ownerEmail: string
      alerts: { alertType: string; details: Record<string, unknown> }[]
    }

    if (!ownerSlackId) return res.status(400).json({ error: 'No Slack ID for this owner' })

    const blocks = await buildCombinedMessage(opportunityId, opportunityName, alerts)
    const ts = await sendDm(ownerSlackId, blocks, `Action needed: ${opportunityName}`)

    // Record each alert type as a notification
    const owner = await db.user.findFirst({ where: { slackUserId: ownerSlackId } })
    if (owner) {
      for (const a of alerts) {
        await db.notification.create({
          data: {
            opportunityId,
            opportunityName,
            ownerId: owner.id,
            alertType: a.alertType as AlertType,
            alertDetails: a.details as never,
            slackMessageTs: ts ?? undefined,
            status: 'SENT',
          },
        })
      }
    }

    res.json({ ok: true, ts })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// Delete a Salesforce opportunity directly (for cleaning up test opps)
router.delete('/sfdc-opportunity/:id', async (req, res) => {
  try {
    const conn = await getServiceConnection()
    await conn.sobject('Opportunity').delete(req.params.id)
    res.json({ ok: true })
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
      blocks = await buildPastDueMessage({ alertType, ownerEmail: targetUser.slackEmail, ownerSfdcId: targetUser.sfdcUserId ?? '', ...alertData } as never, isNudge)
    } else if (alertType === AlertType.STALLED) {
      blocks = await buildStalledMessage({ alertType: AlertType.STALLED, ownerEmail: targetUser.slackEmail, ownerSfdcId: targetUser.sfdcUserId ?? '', triggeredBy: [], ruleId: '', stageDurationDays: null, ...alertData } as never, isNudge)
    } else {
      blocks = await buildMeddpiccMessage({ alertType: AlertType.MEDDPICC_MISSING, ownerEmail: targetUser.slackEmail, ownerSfdcId: targetUser.sfdcUserId ?? '', missingFields: (alertData.missingFields ?? []) as never, sfdcFieldMap: (alertData.sfdcFieldMap ?? {}) as never, ...alertData } as never, isNudge)
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
