import { db } from '../db'
import { fetchOpenOpportunities } from '../services/salesforce'
import { buildOpportunityActivityIndex, invalidateGongCache } from '../services/gong'
import { evaluatePastDue } from '../alerts/pastDue'
import { evaluateStalled } from '../alerts/stalled'
import { evaluateMeddpicc } from '../alerts/meddpicc'
import { sendDm, resolveSlackUserId } from '../slack/bot'
import { buildPastDueMessage, buildStalledMessage, buildMeddpiccMessage } from '../slack/messages'
import { AlertType, NotificationStatus } from '../types'
import type { PastDueAlert } from '../alerts/pastDue'
import type { StalledAlert } from '../alerts/stalled'
import type { MeddpiccAlert } from '../alerts/meddpicc'

const COOLDOWN_HOURS = 24

// ─── Dry run result types ──────────────────────────────────────────────────

export interface DryRunAlert {
  alertType: AlertType
  opportunityId: string
  opportunityName: string
  ownerEmail: string
  ownerSlackId: string | null  // null = couldn't resolve in Slack
  wouldSkip: boolean           // already snoozed or in cooldown
  skipReason?: string
  details: Record<string, unknown>
}

export interface DryRunResult {
  totalOpportunities: number
  wouldSend: DryRunAlert[]
  wouldSkip: DryRunAlert[]
  unreachable: DryRunAlert[]  // no Slack ID found for owner
  stallRulesActive: number
  meddpiccStagesActive: number
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function isSnoozedOrRecentlySent(oppId: string, alertType: AlertType): Promise<{ skip: boolean; reason?: string }> {
  const recent = await db.notification.findFirst({
    where: {
      opportunityId: oppId,
      alertType,
      status: { in: [NotificationStatus.SENT, NotificationStatus.SNOOZED] },
    },
    orderBy: { sentAt: 'desc' },
  })

  if (!recent) return { skip: false }

  if (recent.status === NotificationStatus.SNOOZED && recent.snoozedUntil && recent.snoozedUntil > new Date()) {
    return { skip: true, reason: `Snoozed until ${recent.snoozedUntil.toLocaleDateString()}` }
  }

  if (recent.status === NotificationStatus.SENT) {
    const hoursSince = (Date.now() - recent.sentAt.getTime()) / (1000 * 60 * 60)
    if (hoursSince < COOLDOWN_HOURS) {
      return { skip: true, reason: `Already sent ${Math.round(hoursSince)}h ago (cooldown: ${COOLDOWN_HOURS}h)` }
    }
  }

  return { skip: false }
}

// ─── Core evaluation (shared by live and dry run) ─────────────────────────

async function evaluate(opts: { bustGongCache?: boolean } = {}) {
  if (opts.bustGongCache) await invalidateGongCache()

  const opps = await fetchOpenOpportunities()
  const sfdcIds = opps.map((o) => o.Id)
  const gongActivity = await buildOpportunityActivityIndex(sfdcIds)

  const [stallRules, meddpiccRequirements] = await Promise.all([
    db.stallRule.findMany({ where: { enabled: true } }),
    db.meddpiccStageRequirement.findMany({ where: { enabled: true } }),
  ])

  return {
    opps,
    gongActivity,
    stallRules,
    meddpiccRequirements,
    pastDueAlerts: evaluatePastDue(opps),
    stalledAlerts: evaluateStalled(opps, stallRules, gongActivity),
    meddpiccAlerts: evaluateMeddpicc(opps, meddpiccRequirements),
  }
}

// ─── Dry run ───────────────────────────────────────────────────────────────

export async function runDryRun(opts: { bustGongCache?: boolean } = {}): Promise<DryRunResult> {
  console.log('[DryRun] Starting dry run evaluation...')

  const { opps, pastDueAlerts, stalledAlerts, meddpiccAlerts, stallRules, meddpiccRequirements } = await evaluate(opts)

  const wouldSend: DryRunAlert[] = []
  const wouldSkip: DryRunAlert[] = []
  const unreachable: DryRunAlert[] = []

  type AnyAlert = PastDueAlert | StalledAlert | MeddpiccAlert

  async function processAlert(alert: AnyAlert, alertType: AlertType) {
    const { skip, reason } = await isSnoozedOrRecentlySent(alert.opportunityId, alertType)
    const ownerSlackId = await resolveSlackUserId(alert.ownerEmail)

    const dryAlert: DryRunAlert = {
      alertType,
      opportunityId: alert.opportunityId,
      opportunityName: alert.opportunityName,
      ownerEmail: alert.ownerEmail,
      ownerSlackId,
      wouldSkip: skip,
      skipReason: reason,
      details: alert as unknown as Record<string, unknown>,
    }

    if (!ownerSlackId) {
      unreachable.push(dryAlert)
    } else if (skip) {
      wouldSkip.push(dryAlert)
    } else {
      wouldSend.push(dryAlert)
    }
  }

  for (const alert of pastDueAlerts) await processAlert(alert, alert.alertType)
  for (const alert of stalledAlerts) await processAlert(alert, AlertType.STALLED)
  for (const alert of meddpiccAlerts) await processAlert(alert, AlertType.MEDDPICC_MISSING)

  console.log(`[DryRun] Would send: ${wouldSend.length}, Would skip: ${wouldSkip.length}, Unreachable: ${unreachable.length}`)

  return {
    totalOpportunities: opps.length,
    wouldSend,
    wouldSkip,
    unreachable,
    stallRulesActive: stallRules.length,
    meddpiccStagesActive: meddpiccRequirements.length,
  }
}

// ─── Live run ──────────────────────────────────────────────────────────────

export async function runAlertJob(opts: { bustGongCache?: boolean } = {}): Promise<{ sent: number; skipped: number; errors: number }> {
  console.log('[AlertJob] Starting alert evaluation...')

  let sent = 0
  let skipped = 0
  let errors = 0

  const { pastDueAlerts, stalledAlerts, meddpiccAlerts } = await evaluate(opts)

  console.log(`[AlertJob] Found: ${pastDueAlerts.length} past due, ${stalledAlerts.length} stalled, ${meddpiccAlerts.length} MEDDPICC`)

  for (const alert of pastDueAlerts) {
    try {
      const { skip } = await isSnoozedOrRecentlySent(alert.opportunityId, alert.alertType)
      if (skip) { skipped++; continue }

      const slackUserId = await resolveSlackUserId(alert.ownerEmail)
      if (!slackUserId) { skipped++; continue }

      const dbUser = await db.user.findUnique({ where: { slackUserId } })
      if (!dbUser) { skipped++; continue }

      const blocks = buildPastDueMessage(alert)
      const ts = await sendDm(slackUserId, blocks, `Past due: ${alert.opportunityName}`)

      await db.notification.create({
        data: {
          opportunityId: alert.opportunityId,
          opportunityName: alert.opportunityName,
          ownerId: dbUser.id,
          alertType: alert.alertType,
          alertDetails: alert as unknown as import('@prisma/client').Prisma.InputJsonValue,
          slackMessageTs: ts,
          slackChannelId: slackUserId,
          status: NotificationStatus.SENT,
        },
      })
      sent++
    } catch (err) {
      console.error(`[AlertJob] Error on past due ${alert.opportunityId}:`, err)
      errors++
    }
  }

  for (const alert of stalledAlerts) {
    try {
      const { skip } = await isSnoozedOrRecentlySent(alert.opportunityId, AlertType.STALLED)
      if (skip) { skipped++; continue }

      const slackUserId = await resolveSlackUserId(alert.ownerEmail)
      if (!slackUserId) { skipped++; continue }

      const dbUser = await db.user.findUnique({ where: { slackUserId } })
      if (!dbUser) { skipped++; continue }

      const blocks = buildStalledMessage(alert)
      const ts = await sendDm(slackUserId, blocks, `Stalled deal: ${alert.opportunityName}`)

      await db.notification.create({
        data: {
          opportunityId: alert.opportunityId,
          opportunityName: alert.opportunityName,
          ownerId: dbUser.id,
          alertType: AlertType.STALLED,
          alertDetails: alert as unknown as import('@prisma/client').Prisma.InputJsonValue,
          slackMessageTs: ts,
          slackChannelId: slackUserId,
          stallRuleId: alert.ruleId,
          status: NotificationStatus.SENT,
        },
      })
      sent++
    } catch (err) {
      console.error(`[AlertJob] Error on stalled ${alert.opportunityId}:`, err)
      errors++
    }
  }

  for (const alert of meddpiccAlerts) {
    try {
      const { skip } = await isSnoozedOrRecentlySent(alert.opportunityId, AlertType.MEDDPICC_MISSING)
      if (skip) { skipped++; continue }

      const slackUserId = await resolveSlackUserId(alert.ownerEmail)
      if (!slackUserId) { skipped++; continue }

      const dbUser = await db.user.findUnique({ where: { slackUserId } })
      if (!dbUser) { skipped++; continue }

      const blocks = buildMeddpiccMessage(alert)
      const ts = await sendDm(slackUserId, blocks, `Missing MEDDPICC: ${alert.opportunityName}`)

      await db.notification.create({
        data: {
          opportunityId: alert.opportunityId,
          opportunityName: alert.opportunityName,
          ownerId: dbUser.id,
          alertType: AlertType.MEDDPICC_MISSING,
          alertDetails: alert as unknown as import('@prisma/client').Prisma.InputJsonValue,
          slackMessageTs: ts,
          slackChannelId: slackUserId,
          status: NotificationStatus.SENT,
        },
      })
      sent++
    } catch (err) {
      console.error(`[AlertJob] Error on MEDDPICC ${alert.opportunityId}:`, err)
      errors++
    }
  }

  console.log(`[AlertJob] Done. Sent: ${sent}, Skipped: ${skipped}, Errors: ${errors}`)
  return { sent, skipped, errors }
}
