import { Router } from 'express'
import { db } from '../db'
import { requireAdmin } from '../middleware/adminAuth'
import { triggerAlertJobNow } from '../jobs/scheduler'
import { runDryRun } from '../jobs/alertOrchestrator'
import { sendDm, resolveSlackUserId } from '../slack/bot'
import { buildCombinedMessage, buildPastDueMessage, buildStalledMessage, buildMeddpiccMessage, buildManagerAlertMessage } from '../slack/messages'
import { AlertType } from '../types'
import type { KnownBlock } from '@slack/web-api'
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

// Sent notification counts per opportunity split by recipient type (rep vs manager)
router.get('/opp-counts', async (req, res) => {
  const { oppIds } = req.query as { oppIds?: string }
  const ids = oppIds ? oppIds.split(',').filter(Boolean) : []
  if (!ids.length) return res.json({})

  const [rows, snoozes] = await Promise.all([
    db.notification.groupBy({
      by: ['opportunityId', 'recipientType'],
      _count: { id: true },
      _max: { sentAt: true },
      where: { opportunityId: { in: ids } },
    }),
    // Active snoozes only (snoozedUntil in the future)
    db.notification.findMany({
      where: {
        opportunityId: { in: ids },
        status: 'SNOOZED',
        snoozedUntil: { gt: new Date() },
      },
      orderBy: { snoozedUntil: 'desc' },
      select: { opportunityId: true, recipientType: true, snoozedUntil: true },
    }),
  ])

  const result: Record<string, { rep: number; manager: number; lastSentRep?: string; lastSentMgr?: string; snoozedRepUntil?: string; snoozedMgrUntil?: string }> = {}

  for (const row of rows) {
    if (!result[row.opportunityId]) result[row.opportunityId] = { rep: 0, manager: 0 }
    if (row.recipientType === 'manager') {
      result[row.opportunityId].manager = row._count.id
      if (row._max.sentAt) result[row.opportunityId].lastSentMgr = row._max.sentAt.toISOString()
    } else {
      result[row.opportunityId].rep = row._count.id
      if (row._max.sentAt) result[row.opportunityId].lastSentRep = row._max.sentAt.toISOString()
    }
  }

  // Layer in snooze info (first match per opp+type wins since ordered by snoozedUntil desc)
  for (const s of snoozes) {
    if (!result[s.opportunityId]) result[s.opportunityId] = { rep: 0, manager: 0 }
    if (s.recipientType === 'manager' && !result[s.opportunityId].snoozedMgrUntil) {
      result[s.opportunityId].snoozedMgrUntil = s.snoozedUntil!.toISOString()
    } else if (s.recipientType !== 'manager' && !result[s.opportunityId].snoozedRepUntil) {
      result[s.opportunityId].snoozedRepUntil = s.snoozedUntil!.toISOString()
    }
  }

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
    const { opportunityId, opportunityName, ownerName, ownerEmail, ownerSlackId, managerSlackId, alerts } = req.body as {
      opportunityId: string
      opportunityName: string
      ownerName: string
      ownerEmail?: string
      ownerSlackId: string | null
      managerSlackId: string
      alerts: { alertType: string; details: Record<string, unknown> }[]
    }
    if (!managerSlackId) return res.status(400).json({ error: 'No Slack ID for manager' })

    const blocks = await buildManagerAlertMessage(opportunityId, opportunityName, ownerName, alerts)
    const ts = await sendDm(managerSlackId, blocks, `FYI: ${opportunityName} needs attention`)

    // Record notification so counters stay accurate
    // Try slackUserId first, then fall back to email in case slackUserId isn't synced
    const repUser = await db.user.findFirst({
      where: {
        OR: [
          ...(ownerSlackId ? [{ slackUserId: ownerSlackId }] : []),
          ...(ownerEmail ? [{ slackEmail: ownerEmail }] : []),
        ],
      },
    })
    if (repUser) {
      await db.notification.create({
        data: {
          opportunityId,
          opportunityName,
          ownerId: repUser.id,
          alertType: (alerts[0]?.alertType ?? 'STALLED') as AlertType,
          alertDetails: alerts as never,
          slackMessageTs: ts ?? undefined,
          slackChannelId: managerSlackId,
          recipientType: 'manager',
          status: 'SENT',
        },
      })
    }

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
router.post('/dry-run', async (req, res) => {
  try {
    // bustCache=true only when explicitly requested — Gong cache is 6h and expensive to rebuild
    const bustCache = (req.query.bustCache === 'true') || (req.body as { bustCache?: boolean })?.bustCache === true
    const result = await runDryRun({ bustGongCache: bustCache })
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
    // Try slackUserId first, then fall back to email in case slackUserId isn't synced
    const owner = await db.user.findFirst({
      where: { OR: [{ slackUserId: ownerSlackId }, { slackEmail: ownerEmail }] },
    })
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

// RevOps snooze an opp from the dashboard (no Slack message sent)
router.post('/revops-snooze', async (req, res) => {
  try {
    const { opportunityId, opportunityName, alertTypes, ownerSlackId, ownerEmail, snoozeDays } = req.body as {
      opportunityId: string
      opportunityName: string
      alertTypes: string[]
      ownerSlackId?: string | null
      ownerEmail?: string
      snoozeDays: number
    }

    const snoozedUntil = new Date()
    snoozedUntil.setDate(snoozedUntil.getDate() + snoozeDays)

    // Find the opp owner user to use as ownerId (fall back to any revops user)
    const owner = await db.user.findFirst({
      where: {
        OR: [
          ...(ownerSlackId ? [{ slackUserId: ownerSlackId }] : []),
          ...(ownerEmail ? [{ slackEmail: ownerEmail }] : []),
          { isRevOps: true },
        ],
      },
    })
    if (!owner) return res.status(400).json({ error: 'No user found to attach snooze to' })

    for (const alertType of alertTypes) {
      await db.notification.create({
        data: {
          opportunityId,
          opportunityName,
          ownerId: owner.id,
          alertType: alertType as AlertType,
          alertDetails: { _source: 'revops_snooze' } as never,
          status: 'SNOOZED',
          snoozedUntil,
        },
      })
    }

    res.json({ ok: true, snoozedUntil: snoozedUntil.toISOString() })
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

// Prisma client is not regenerated locally — managerEmail/ownerEmail are runtime fields
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const notifDb = (db as any)

// GET /api/notifications/manager-summary-data
// Returns open flag counts and pending flag counts per manager → rep, for the summary DM preview.
router.get('/manager-summary-data', async (_req, res) => {
  try {
    type NotifRow = { managerEmail: string | null; managerName: string | null; ownerEmail: string; ownerName: string | null; opportunityId: string }
    // 1. Open (sent/snoozed) notifications grouped by manager → owner
    const openNotifs: NotifRow[] = await notifDb.notification.findMany({
      where: { status: { in: ['SENT', 'SNOOZED'] }, managerEmail: { not: null } },
      select: { managerEmail: true, managerName: true, ownerEmail: true, ownerName: true, opportunityId: true },
    })

    // Build: managerEmail → { managerName, reps: Map<ownerEmail, { ownerName, openOppIds }> }
    type RepStat = { ownerName: string | null; openOppIds: Set<string> }
    type MgrEntry = { managerName: string | null; reps: Map<string, RepStat> }
    const mgrMap = new Map<string, MgrEntry>()

    for (const n of openNotifs) {
      const mgrEmail = n.managerEmail!
      if (!mgrMap.has(mgrEmail)) mgrMap.set(mgrEmail, { managerName: n.managerName, reps: new Map() })
      const entry = mgrMap.get(mgrEmail)!
      if (!entry.reps.has(n.ownerEmail)) entry.reps.set(n.ownerEmail, { ownerName: n.ownerName, openOppIds: new Set() })
      entry.reps.get(n.ownerEmail)!.openOppIds.add(n.opportunityId)
    }

    // 2. Pending flags from last dry run
    const lastDryRunSetting = await db.appSetting.findUnique({ where: { key: 'lastDryRunFullResults' } })
    type DryRunAlertMin = { ownerEmail: string; ownerName: string | null; managerEmail: string | null; managerName: string | null; opportunityId: string; wouldSkip: boolean; skipType?: string }
    const pendingByMgr = new Map<string, Map<string, { ownerName: string | null; pendingOppIds: Set<string> }>>()

    if (lastDryRunSetting) {
      const dryRun = JSON.parse(lastDryRunSetting.value) as { wouldSend: DryRunAlertMin[] }
      for (const alert of (dryRun.wouldSend ?? [])) {
        if (!alert.managerEmail) continue
        if (!pendingByMgr.has(alert.managerEmail)) pendingByMgr.set(alert.managerEmail, new Map())
        const repMap = pendingByMgr.get(alert.managerEmail)!
        if (!repMap.has(alert.ownerEmail)) repMap.set(alert.ownerEmail, { ownerName: alert.ownerName, pendingOppIds: new Set() })
        repMap.get(alert.ownerEmail)!.pendingOppIds.add(alert.opportunityId)
      }
    }

    // 3. Merge into response
    const allManagerEmails = new Set([...mgrMap.keys(), ...pendingByMgr.keys()])
    const managers = Array.from(allManagerEmails).map((mgrEmail) => {
      const openEntry = mgrMap.get(mgrEmail)
      const pendingEntry = pendingByMgr.get(mgrEmail)
      const managerName = openEntry?.managerName ?? null

      const allRepEmails = new Set([
        ...(openEntry ? openEntry.reps.keys() : []),
        ...(pendingEntry ? pendingEntry.keys() : []),
      ])

      const reps = Array.from(allRepEmails).map((repEmail) => {
        const openRep = openEntry?.reps.get(repEmail)
        const pendingRep = pendingEntry?.get(repEmail)
        return {
          ownerEmail: repEmail,
          ownerName: openRep?.ownerName ?? pendingRep?.ownerName ?? null,
          openCount: openRep?.openOppIds.size ?? 0,
          pendingCount: pendingRep?.pendingOppIds.size ?? 0,
        }
      }).sort((a, b) => (b.openCount + b.pendingCount) - (a.openCount + a.pendingCount))

      return {
        managerEmail: mgrEmail,
        managerName,
        totalOpen: reps.reduce((s, r) => s + r.openCount, 0),
        totalPending: reps.reduce((s, r) => s + r.pendingCount, 0),
        reps,
      }
    }).sort((a, b) => (a.managerName ?? a.managerEmail).localeCompare(b.managerName ?? b.managerEmail))

    res.json({ managers })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// POST /api/notifications/send-manager-summary
// Sends a Slack DM to selected managers summarising their team's open + pending flags.
router.post('/send-manager-summary', async (req, res) => {
  const { managerEmails } = req.body as { managerEmails: string[] }
  if (!Array.isArray(managerEmails) || managerEmails.length === 0) {
    return res.status(400).json({ error: 'managerEmails must be a non-empty array' })
  }

  type NotifRow2 = { managerEmail: string | null; managerName: string | null; ownerEmail: string; ownerName: string | null; opportunityId: string }
  // Re-use the same data logic
  const openNotifs: NotifRow2[] = await notifDb.notification.findMany({
    where: { status: { in: ['SENT', 'SNOOZED'] }, managerEmail: { in: managerEmails } },
    select: { managerEmail: true, managerName: true, ownerEmail: true, ownerName: true, opportunityId: true },
  })

  type RepStat = { ownerName: string | null; openOppIds: Set<string> }
  type MgrEntry = { managerName: string | null; reps: Map<string, RepStat> }
  const mgrMap = new Map<string, MgrEntry>()
  for (const n of openNotifs) {
    const mgrEmail = n.managerEmail!
    if (!mgrMap.has(mgrEmail)) mgrMap.set(mgrEmail, { managerName: n.managerName, reps: new Map() })
    const entry = mgrMap.get(mgrEmail)!
    if (!entry.reps.has(n.ownerEmail)) entry.reps.set(n.ownerEmail, { ownerName: n.ownerName, openOppIds: new Set() })
    entry.reps.get(n.ownerEmail)!.openOppIds.add(n.opportunityId)
  }

  const lastDryRunSetting = await db.appSetting.findUnique({ where: { key: 'lastDryRunFullResults' } })
  type DryRunAlertMin = { ownerEmail: string; ownerName: string | null; managerEmail: string | null; managerName: string | null; opportunityId: string }
  const pendingByMgr = new Map<string, Map<string, { ownerName: string | null; pendingOppIds: Set<string> }>>()
  if (lastDryRunSetting) {
    const dryRun = JSON.parse(lastDryRunSetting.value) as { wouldSend: DryRunAlertMin[] }
    for (const alert of (dryRun.wouldSend ?? [])) {
      if (!alert.managerEmail || !managerEmails.includes(alert.managerEmail)) continue
      if (!pendingByMgr.has(alert.managerEmail)) pendingByMgr.set(alert.managerEmail, new Map())
      const repMap = pendingByMgr.get(alert.managerEmail)!
      if (!repMap.has(alert.ownerEmail)) repMap.set(alert.ownerEmail, { ownerName: alert.ownerName, pendingOppIds: new Set() })
      repMap.get(alert.ownerEmail)!.pendingOppIds.add(alert.opportunityId)
    }
  }

  const results: { managerEmail: string; ok: boolean; error?: string }[] = []

  for (const mgrEmail of managerEmails) {
    try {
      const slackUserId = await resolveSlackUserId(mgrEmail)
      if (!slackUserId) {
        results.push({ managerEmail: mgrEmail, ok: false, error: `No Slack user found for ${mgrEmail}` })
        continue
      }

      const openEntry = mgrMap.get(mgrEmail)
      const pendingEntry = pendingByMgr.get(mgrEmail)
      const managerFirstName = (openEntry?.managerName ?? mgrEmail).split(' ')[0]

      const allRepEmails = new Set([
        ...(openEntry ? openEntry.reps.keys() : []),
        ...(pendingEntry ? pendingEntry.keys() : []),
      ])

      const repRows = Array.from(allRepEmails).map((repEmail) => {
        const openRep = openEntry?.reps.get(repEmail)
        const pendingRep = pendingEntry?.get(repEmail)
        return {
          name: openRep?.ownerName ?? pendingRep?.ownerName ?? repEmail,
          openCount: openRep?.openOppIds.size ?? 0,
          pendingCount: pendingRep?.pendingOppIds.size ?? 0,
        }
      }).sort((a, b) => (b.openCount + b.pendingCount) - (a.openCount + a.pendingCount))

      const totalOpen = repRows.reduce((s, r) => s + r.openCount, 0)
      const totalPending = repRows.reduce((s, r) => s + r.pendingCount, 0)

      const repLines = repRows
        .filter((r) => r.openCount > 0 || r.pendingCount > 0)
        .map((r) => {
          const parts: string[] = []
          if (r.openCount > 0) parts.push(`${r.openCount} sent & open`)
          if (r.pendingCount > 0) parts.push(`${r.pendingCount} queued`)
          return `• *${r.name}* — ${parts.join(', ')}`
        })

      const blocks: KnownBlock[] = [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `👋 Hey ${managerFirstName}, here's a pipeline hygiene update for your team:` },
        },
        { type: 'divider' },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: repLines.length > 0
              ? repLines.join('\n')
              : '_No open or pending flags for your team right now._',
          },
        },
        { type: 'divider' },
        {
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: `*${totalOpen}* flags sent & awaiting action · *${totalPending}* queued to send next · Sent via RevBot`,
          }],
        },
      ]

      if (totalPending > 0) {
        blocks.splice(3, 0, {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `⏳ *${totalPending} more flag${totalPending !== 1 ? 's' : ''} queued* to send once your reps action the ones above. The sooner they respond, the sooner we can surface more.`,
          },
        })
      }

      await sendDm(slackUserId, blocks, `Pipeline hygiene update for your team — ${totalOpen} open, ${totalPending} queued`)
      results.push({ managerEmail: mgrEmail, ok: true })
    } catch (err) {
      results.push({ managerEmail: mgrEmail, ok: false, error: String(err) })
    }
  }

  return res.json({ results })
})

export default router
