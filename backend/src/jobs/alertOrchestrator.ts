import { db } from '../db'
import { fetchOpenOpportunities, invalidateSfdcOppCache } from '../services/salesforce'
import { buildOpportunityActivityIndex, invalidateGongCache, warmGongCallCache, isGongCacheWarm } from '../services/gong'
import { evaluatePastDue } from '../alerts/pastDue'
import { evaluateStalled } from '../alerts/stalled'
import { evaluateMeddpicc } from '../alerts/meddpicc'
import { evaluateNextStep } from '../alerts/nextStep'
import { evaluateCloseDateRisk } from '../alerts/closeDate'
import { evaluateStageMismatch } from '../alerts/stageMismatch'
import { sendDm, resolveSlackUserId } from '../slack/bot'
import { buildPastDueMessage, buildStalledMessage, buildMeddpiccMessage, buildNextStepMessage, buildCloseDateRiskMessage, buildStageMismatchMessage } from '../slack/messages'
import { AlertType, NotificationStatus } from '../types'
import type { PastDueAlert } from '../alerts/pastDue'
import type { StalledAlert } from '../alerts/stalled'
import type { MeddpiccAlert } from '../alerts/meddpicc'
import type { NextStepAlert } from '../alerts/nextStep'
import type { CloseDateRiskAlert } from '../alerts/closeDate'
import type { StageMismatchAlert } from '../alerts/stageMismatch'

const DEFAULT_COOLDOWN_BUSINESS_DAYS = 3

/** Count weekdays (Mon–Fri) that have fully elapsed since `from`. */
function businessDaysSince(from: Date): number {
  const now = new Date()
  let count = 0
  const cursor = new Date(from)
  cursor.setHours(0, 0, 0, 0)
  cursor.setDate(cursor.getDate() + 1) // start counting from the next calendar day
  while (cursor <= now) {
    const day = cursor.getDay()
    if (day !== 0 && day !== 6) count++ // skip Sunday (0) and Saturday (6)
    cursor.setDate(cursor.getDate() + 1)
  }
  return count
}

// ─── Dry run result types ──────────────────────────────────────────────────

export type SkipType = 'cooldown' | 'snoozed_owner' | 'snoozed_revops'

export interface DryRunAlert {
  alertType: AlertType
  opportunityId: string
  opportunityName: string
  accountName: string | null
  opportunityType: string | null
  salesChannel: string | null
  salesFunction: string | null
  salesRegion: string | null
  ownerEmail: string
  ownerName: string | null
  ownerSlackId: string | null  // null = couldn't resolve in Slack
  managerEmail: string | null
  managerName: string | null
  managerSlackId: string | null
  wouldSkip: boolean           // already snoozed or in cooldown
  skipReason?: string
  skipType?: SkipType
  details: Record<string, unknown>
}

export interface ResolvedNotification {
  opportunityId: string
  opportunityName: string
  alertType: AlertType
  resolveReason: 'opp_closed' | 'flag_cleared'
  ownerEmail: string
  managerEmail: string | null
}

export interface DryRunResult {
  totalOpportunities: number
  wouldSend: DryRunAlert[]
  wouldSkip: DryRunAlert[]
  unreachable: DryRunAlert[]  // no Slack ID found for owner
  resolved: ResolvedNotification[]
  stallRulesActive: number
  meddpiccStagesActive: number
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function isSnoozedOrRecentlySent(oppId: string, alertType: AlertType, cooldownBusinessDays: number): Promise<{ skip: boolean; reason?: string; skipType?: SkipType }> {
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
    const details = recent.alertDetails as Record<string, unknown> | null
    const isRevopsSnooze = details?._source === 'revops_snooze'
    const until = recent.snoozedUntil.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    return {
      skip: true,
      reason: isRevopsSnooze ? `RevOps snoozed until ${until}` : `Snoozed by owner until ${until}`,
      skipType: isRevopsSnooze ? 'snoozed_revops' : 'snoozed_owner',
    }
  }

  if (recent.status === NotificationStatus.SENT) {
    const bdSince = businessDaysSince(recent.sentAt)
    if (bdSince < cooldownBusinessDays) {
      const dayLabel = bdSince === 1 ? '1 business day' : `${bdSince} business days`
      return {
        skip: true,
        reason: `Sent ${dayLabel} ago (cooldown: ${cooldownBusinessDays} business days)`,
        skipType: 'cooldown',
      }
    }
  }

  return { skip: false }
}

// ─── Core evaluation (shared by live and dry run) ─────────────────────────

async function evaluate(opts: { bustGongCache?: boolean } = {}) {
  console.log('[Evaluate] Step 1: bust cache check')
  if (opts.bustGongCache) await Promise.all([invalidateGongCache(), invalidateSfdcOppCache()])

  const t0 = Date.now()
  console.log('[Evaluate] Step 2: Redis warm check...')
  const gongWarm = await isGongCacheWarm()
  console.log(`[Evaluate] Step 3: Redis check done in ${Date.now() - t0}ms, gongWarm=${gongWarm}`)

  if (!gongWarm) {
    warmGongCallCache().catch((err) => console.warn('[Gong] Background warm failed:', String(err)))
    console.warn('[Gong] Cache cold — skipping Gong activity this run.')
  }

  console.log('[Evaluate] Step 4: fetching SFDC opps...')
  const opps = await fetchOpenOpportunities({ bustCache: opts.bustGongCache })
  console.log(`[Evaluate] SFDC opps: ${Date.now() - t0}ms (${opps.length} opps, gongWarm=${gongWarm})`)
  const sfdcIds = opps.map((o) => o.Id)

  const tGong = Date.now()
  const gongActivity: Awaited<ReturnType<typeof buildOpportunityActivityIndex>> = gongWarm
    ? await buildOpportunityActivityIndex(sfdcIds)
    : new Map()
  console.log(`[Evaluate] Gong index: ${Date.now() - tGong}ms`)

  const [stallRules, stallThresholds, meddpiccRequirements, closeDateRiskRules, stageMismatchRules, bufferSettings] = await Promise.all([
    db.stallRule.findMany({ where: { enabled: true } }),
    db.stallThresholdByStage.findMany({ where: { enabled: true } }),
    db.meddpiccStageRequirement.findMany({ where: { enabled: true } }),
    db.closeDateRiskRule.findMany({ where: { enabled: true } }),
    db.stageMismatchRule.findMany(),
    db.appSetting.findMany({ where: { key: { in: ['pastDueBufferDays', 'nextStepBufferDays', 'cooldownBusinessDays'] } } }),
  ])

  const settingMap = Object.fromEntries(bufferSettings.map((s) => [s.key, JSON.parse(s.value)]))
  const pastDueBufferDays = Number(settingMap.pastDueBufferDays ?? 0)
  const nextStepBufferDays = Number(settingMap.nextStepBufferDays ?? 0)
  const cooldownBusinessDays = Number(settingMap.cooldownBusinessDays ?? DEFAULT_COOLDOWN_BUSINESS_DAYS)

  return {
    opps,
    gongActivity,
    stallRules,
    stallThresholds,
    meddpiccRequirements,
    closeDateRiskRules,
    stageMismatchRules,
    cooldownBusinessDays,
    pastDueAlerts: evaluatePastDue(opps, pastDueBufferDays),
    stalledAlerts: evaluateStalled(opps, stallRules, gongActivity, stallThresholds),
    meddpiccAlerts: evaluateMeddpicc(opps, meddpiccRequirements),
    nextStepAlerts: evaluateNextStep(opps, nextStepBufferDays),
    closeDateRiskAlerts: evaluateCloseDateRisk(opps, closeDateRiskRules),
    stageMismatchAlerts: evaluateStageMismatch(opps, stageMismatchRules),
  }
}

// ─── Auto-resolve stale notifications ─────────────────────────────────────
// Marks SENT/SNOOZED notifications as RESOLVED when:
//   1. The opp is no longer open in Salesforce (closed won/lost/etc.)
//   2. The opp is open but that specific flag no longer fires

async function autoResolveStale(
  openOppIds: Set<string>,
  currentAlerts: Array<{ opportunityId: string; alertType: AlertType }>
): Promise<ResolvedNotification[]> {
  const currentFlagKeys = new Set(currentAlerts.map((a) => `${a.opportunityId}:${a.alertType}`))

  type ActiveNotif = { id: string; opportunityId: string; opportunityName: string; alertType: string; owner: { slackEmail: string | null } | null }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const active: ActiveNotif[] = await (db as any).notification.findMany({
    where: { status: { in: ['SENT', 'SNOOZED'] } },
    select: { id: true, opportunityId: true, opportunityName: true, alertType: true, owner: { select: { slackEmail: true } } },
  })

  const toResolve = active.filter((n) => {
    if (!openOppIds.has(n.opportunityId)) return true          // opp closed
    if (!currentFlagKeys.has(`${n.opportunityId}:${n.alertType}`)) return true  // flag cleared
    return false
  })

  if (toResolve.length) {
    await db.notification.updateMany({
      where: { id: { in: toResolve.map((n) => n.id) } },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    })
    console.log(`[AutoResolve] Resolved ${toResolve.length} stale notifications`)
  }

  return toResolve.map((n) => ({
    opportunityId: n.opportunityId,
    opportunityName: n.opportunityName,
    alertType: n.alertType as AlertType,
    resolveReason: !openOppIds.has(n.opportunityId) ? 'opp_closed' : 'flag_cleared',
    ownerEmail: n.owner?.slackEmail ?? '',
    managerEmail: null,
  }))
}

// ─── Dry run ───────────────────────────────────────────────────────────────

export async function runDryRun(opts: { bustGongCache?: boolean } = {}): Promise<DryRunResult> {
  console.log('[DryRun] Starting dry run evaluation...')

  const { opps, pastDueAlerts, stalledAlerts, meddpiccAlerts, nextStepAlerts, closeDateRiskAlerts, stageMismatchAlerts, stallRules, stallThresholds, meddpiccRequirements, cooldownBusinessDays } = await evaluate(opts)

  const oppById = new Map(opps.map((o) => [o.Id, o]))

  // ── Bulk pre-load to avoid per-alert DB queries ──────────────────────────
  // Instead of one DB round-trip per alert (×hundreds), load everything upfront in 2 queries.

  // 1. All known users keyed by email — replaces resolveSlackUserId() per alert
  const allUsers = await db.user.findMany({ select: { slackEmail: true, slackUserId: true } })
  const slackIdByEmail = new Map(allUsers.map((u) => [u.slackEmail, u.slackUserId]))

  // 2. All active (SENT / SNOOZED) notifications — replaces isSnoozedOrRecentlySent() per alert
  const activeNotifications = await db.notification.findMany({
    where: { status: { in: ['SENT', 'SNOOZED'] } },
    select: { opportunityId: true, alertType: true, status: true, sentAt: true, snoozedUntil: true, alertDetails: true },
    orderBy: { sentAt: 'desc' },
  })
  // Build a map: "${opportunityId}:${alertType}" → most-recent notification
  const notifByKey = new Map<string, typeof activeNotifications[number]>()
  for (const n of activeNotifications) {
    const key = `${n.opportunityId}:${n.alertType}`
    if (!notifByKey.has(key)) notifByKey.set(key, n) // already ordered desc, first wins
  }

  function checkSnoozeOrCooldown(
    oppId: string,
    alertType: AlertType,
    cdDays: number
  ): { skip: boolean; reason?: string; skipType?: SkipType } {
    const n = notifByKey.get(`${oppId}:${alertType}`)
    if (!n) return { skip: false }

    if (n.status === 'SNOOZED' && n.snoozedUntil && n.snoozedUntil > new Date()) {
      const isRevops = (n.alertDetails as Record<string, unknown> | null)?._source === 'revops_snooze'
      const until = n.snoozedUntil.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      return {
        skip: true,
        reason: isRevops ? `RevOps snoozed until ${until}` : `Snoozed by owner until ${until}`,
        skipType: isRevops ? 'snoozed_revops' : 'snoozed_owner',
      }
    }

    if (n.status === 'SENT') {
      const bdSince = businessDaysSince(n.sentAt)
      if (bdSince < cdDays) {
        const label = bdSince === 1 ? '1 business day' : `${bdSince} business days`
        return { skip: true, reason: `Sent ${label} ago (cooldown: ${cdDays} business days)`, skipType: 'cooldown' }
      }
    }

    return { skip: false }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const wouldSend: DryRunAlert[] = []
  const wouldSkip: DryRunAlert[] = []
  const unreachable: DryRunAlert[] = []

  type AnyAlert = PastDueAlert | StalledAlert | MeddpiccAlert | NextStepAlert | CloseDateRiskAlert | StageMismatchAlert

  function processAlert(alert: AnyAlert, alertType: AlertType) {
    const opp = oppById.get(alert.opportunityId)
    const managerEmail = opp?.Owner?.Manager?.Email ?? null
    const managerName = opp?.Owner?.Manager?.Name ?? null

    const { skip, reason, skipType } = checkSnoozeOrCooldown(alert.opportunityId, alertType, cooldownBusinessDays)
    const ownerSlackId = slackIdByEmail.get(alert.ownerEmail) ?? null
    const managerSlackId = managerEmail ? (slackIdByEmail.get(managerEmail) ?? null) : null

    const dryAlert: DryRunAlert = {
      alertType,
      opportunityId: alert.opportunityId,
      opportunityName: alert.opportunityName,
      accountName: opp?.Account?.Name ?? null,
      opportunityType: opp?.Type ?? null,
      salesChannel: opp?.Sales_Channel__c ?? null,
      salesFunction: opp?.Sales_Function__c ?? null,
      salesRegion: opp?.Sales_Region__c ?? null,
      ownerEmail: alert.ownerEmail,
      ownerName: opp?.Owner?.Name ?? null,
      ownerSlackId,
      managerEmail,
      managerName,
      managerSlackId,
      wouldSkip: skip,
      skipReason: reason,
      skipType,
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

  // All alert processing is now synchronous (pure in-memory map lookups)
  for (const a of pastDueAlerts) processAlert(a, a.alertType)
  for (const a of stalledAlerts) processAlert(a, AlertType.STALLED)
  for (const a of meddpiccAlerts) processAlert(a, AlertType.MEDDPICC_MISSING)
  for (const a of nextStepAlerts) processAlert(a, AlertType.NEXT_STEP_MISSING)
  for (const a of closeDateRiskAlerts) processAlert(a, AlertType.CLOSE_DATE_RISK)
  for (const a of stageMismatchAlerts) processAlert(a, AlertType.STAGE_MISMATCH)

  console.log(`[DryRun] Would send: ${wouldSend.length}, Would skip: ${wouldSkip.length}, Unreachable: ${unreachable.length}`)

  // Auto-resolve notifications for closed opps and cleared flags
  const allCurrentAlerts = [
    ...pastDueAlerts.map((a) => ({ opportunityId: a.opportunityId, alertType: a.alertType })),
    ...stalledAlerts.map((a) => ({ opportunityId: a.opportunityId, alertType: AlertType.STALLED })),
    ...meddpiccAlerts.map((a) => ({ opportunityId: a.opportunityId, alertType: AlertType.MEDDPICC_MISSING })),
    ...nextStepAlerts.map((a) => ({ opportunityId: a.opportunityId, alertType: AlertType.NEXT_STEP_MISSING })),
    ...closeDateRiskAlerts.map((a) => ({ opportunityId: a.opportunityId, alertType: AlertType.CLOSE_DATE_RISK })),
    ...stageMismatchAlerts.map((a) => ({ opportunityId: a.opportunityId, alertType: AlertType.STAGE_MISMATCH })),
  ]
  const resolved = await autoResolveStale(new Set(opps.map((o) => o.Id)), allCurrentAlerts)

  // Save summary for playbook pages to display
  // Count ALL flagged opps (would send + skipped + unreachable) so sidebar shows
  // total flags regardless of cooldown/notification status
  const summaryByType: Record<string, number> = {}
  const summaryByStallRule: Record<string, number> = {}
  const summarybyStageMismatchRule: Record<string, number> = {}

  for (const alert of [...wouldSend, ...wouldSkip, ...unreachable]) {
    summaryByType[alert.alertType] = (summaryByType[alert.alertType] ?? 0) + 1
    // Per stall rule
    if (alert.alertType === 'STALLED' && alert.details.ruleId) {
      const rid = alert.details.ruleId as string
      summaryByStallRule[rid] = (summaryByStallRule[rid] ?? 0) + 1
    }
    // Per stage mismatch rule
    if (alert.alertType === 'STAGE_MISMATCH' && alert.details.ruleName) {
      const rn = alert.details.ruleName as string
      summarybyStageMismatchRule[rn] = (summarybyStageMismatchRule[rn] ?? 0) + 1
    }
  }

  const runTimestamp = new Date().toISOString()
  const runAt = new Date(runTimestamp)

  await Promise.all([
    db.appSetting.upsert({
      where: { key: 'lastDryRunSummary' },
      create: {
        key: 'lastDryRunSummary',
        value: JSON.stringify({
          timestamp: runTimestamp,
          totalOpportunities: opps.length,
          byAlertType: summaryByType,
          byStallRule: summaryByStallRule,
          byStageMismatchRule: summarybyStageMismatchRule,
        }),
      },
      update: {
        value: JSON.stringify({
          timestamp: runTimestamp,
          totalOpportunities: opps.length,
          byAlertType: summaryByType,
          byStallRule: summaryByStallRule,
          byStageMismatchRule: summarybyStageMismatchRule,
        }),
      },
    }),
    db.appSetting.upsert({
      where: { key: 'lastDryRunFullResults' },
      create: {
        key: 'lastDryRunFullResults',
        value: JSON.stringify({
          timestamp: runTimestamp,
          totalOpportunities: opps.length,
          wouldSend,
          wouldSkip,
          unreachable,
          resolved,
          stallRulesActive: stallRules.length + stallThresholds.length,
          meddpiccStagesActive: meddpiccRequirements.length,
        }),
      },
      update: {
        value: JSON.stringify({
          timestamp: runTimestamp,
          totalOpportunities: opps.length,
          wouldSend,
          wouldSkip,
          unreachable,
          resolved,
          stallRulesActive: stallRules.length + stallThresholds.length,
          meddpiccStagesActive: meddpiccRequirements.length,
        }),
      },
    }),
(db as any).flagSnapshot.createMany({
      data: [...wouldSend, ...wouldSkip, ...unreachable].map((alert) => ({
        runAt,
        opportunityId: alert.opportunityId,
        alertType: alert.alertType,
        ownerEmail: alert.ownerEmail,
        ownerName: alert.ownerName ?? null,
        managerEmail: alert.managerEmail ?? null,
        managerName: alert.managerName ?? null,
      })),
      skipDuplicates: false,
    }),
  ])

  return {
    totalOpportunities: opps.length,
    wouldSend,
    wouldSkip,
    unreachable,
    resolved,
    stallRulesActive: stallRules.length + stallThresholds.length,
    meddpiccStagesActive: meddpiccRequirements.length,
  }
}

// ─── Live run ──────────────────────────────────────────────────────────────

export async function runAlertJob(opts: { bustGongCache?: boolean } = {}): Promise<{ sent: number; skipped: number; errors: number }> {
  console.log('[AlertJob] Starting alert evaluation...')

  let sent = 0
  let skipped = 0
  let errors = 0

  const { opps, pastDueAlerts, stalledAlerts, meddpiccAlerts, nextStepAlerts, closeDateRiskAlerts, stageMismatchAlerts, cooldownBusinessDays } = await evaluate(opts)

  console.log(`[AlertJob] Found: ${pastDueAlerts.length} past due, ${stalledAlerts.length} stalled, ${meddpiccAlerts.length} MEDDPICC, ${nextStepAlerts.length} missing next step, ${closeDateRiskAlerts.length} close date risk, ${stageMismatchAlerts.length} stage mismatch`)

  // Auto-resolve closed opps and cleared flags before sending new ones
  const allCurrentAlerts = [
    ...pastDueAlerts.map((a) => ({ opportunityId: a.opportunityId, alertType: a.alertType })),
    ...stalledAlerts.map((a) => ({ opportunityId: a.opportunityId, alertType: AlertType.STALLED })),
    ...meddpiccAlerts.map((a) => ({ opportunityId: a.opportunityId, alertType: AlertType.MEDDPICC_MISSING })),
    ...nextStepAlerts.map((a) => ({ opportunityId: a.opportunityId, alertType: AlertType.NEXT_STEP_MISSING })),
    ...closeDateRiskAlerts.map((a) => ({ opportunityId: a.opportunityId, alertType: AlertType.CLOSE_DATE_RISK })),
    ...stageMismatchAlerts.map((a) => ({ opportunityId: a.opportunityId, alertType: AlertType.STAGE_MISMATCH })),
  ]
  await autoResolveStale(new Set(opps.map((o) => o.Id)), allCurrentAlerts)

  for (const alert of pastDueAlerts) {
    try {
      const { skip } = await isSnoozedOrRecentlySent(alert.opportunityId, alert.alertType, cooldownBusinessDays)
      if (skip) { skipped++; continue }

      const slackUserId = await resolveSlackUserId(alert.ownerEmail)
      if (!slackUserId) { skipped++; continue }

      const dbUser = await db.user.findUnique({ where: { slackUserId } })
      if (!dbUser) { skipped++; continue }

      const blocks = await buildPastDueMessage(alert)
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
      const { skip } = await isSnoozedOrRecentlySent(alert.opportunityId, AlertType.STALLED, cooldownBusinessDays)
      if (skip) { skipped++; continue }

      const slackUserId = await resolveSlackUserId(alert.ownerEmail)
      if (!slackUserId) { skipped++; continue }

      const dbUser = await db.user.findUnique({ where: { slackUserId } })
      if (!dbUser) { skipped++; continue }

      const blocks = await buildStalledMessage(alert)
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
      const { skip } = await isSnoozedOrRecentlySent(alert.opportunityId, AlertType.MEDDPICC_MISSING, cooldownBusinessDays)
      if (skip) { skipped++; continue }

      const slackUserId = await resolveSlackUserId(alert.ownerEmail)
      if (!slackUserId) { skipped++; continue }

      const dbUser = await db.user.findUnique({ where: { slackUserId } })
      if (!dbUser) { skipped++; continue }

      const blocks = await buildMeddpiccMessage(alert)
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

  for (const alert of nextStepAlerts) {
    try {
      const { skip } = await isSnoozedOrRecentlySent(alert.opportunityId, AlertType.NEXT_STEP_MISSING, cooldownBusinessDays)
      if (skip) { skipped++; continue }

      const slackUserId = await resolveSlackUserId(alert.ownerEmail)
      if (!slackUserId) { skipped++; continue }

      const dbUser = await db.user.findUnique({ where: { slackUserId } })
      if (!dbUser) { skipped++; continue }

      const blocks = await buildNextStepMessage(alert)
      const ts = await sendDm(slackUserId, blocks, `Missing next step: ${alert.opportunityName}`)

      await db.notification.create({
        data: {
          opportunityId: alert.opportunityId,
          opportunityName: alert.opportunityName,
          ownerId: dbUser.id,
          alertType: AlertType.NEXT_STEP_MISSING,
          alertDetails: alert as unknown as import('@prisma/client').Prisma.InputJsonValue,
          slackMessageTs: ts,
          slackChannelId: slackUserId,
          status: NotificationStatus.SENT,
        },
      })
      sent++
    } catch (err) {
      console.error(`[AlertJob] Error on next step ${alert.opportunityId}:`, err)
      errors++
    }
  }

  for (const alert of closeDateRiskAlerts) {
    try {
      const { skip } = await isSnoozedOrRecentlySent(alert.opportunityId, AlertType.CLOSE_DATE_RISK, cooldownBusinessDays)
      if (skip) { skipped++; continue }

      const slackUserId = await resolveSlackUserId(alert.ownerEmail)
      if (!slackUserId) { skipped++; continue }

      const dbUser = await db.user.findUnique({ where: { slackUserId } })
      if (!dbUser) { skipped++; continue }

      const blocks = await buildCloseDateRiskMessage(alert)
      const ts = await sendDm(slackUserId, blocks, `Close date risk: ${alert.opportunityName}`)

      await db.notification.create({
        data: {
          opportunityId: alert.opportunityId,
          opportunityName: alert.opportunityName,
          ownerId: dbUser.id,
          alertType: AlertType.CLOSE_DATE_RISK,
          alertDetails: alert as unknown as import('@prisma/client').Prisma.InputJsonValue,
          slackMessageTs: ts,
          slackChannelId: slackUserId,
          status: NotificationStatus.SENT,
        },
      })
      sent++
    } catch (err) {
      console.error(`[AlertJob] Error on close date risk ${alert.opportunityId}:`, err)
      errors++
    }
  }

  for (const alert of stageMismatchAlerts) {
    try {
      const { skip } = await isSnoozedOrRecentlySent(alert.opportunityId, AlertType.STAGE_MISMATCH, cooldownBusinessDays)
      if (skip) { skipped++; continue }

      const slackUserId = await resolveSlackUserId(alert.ownerEmail)
      if (!slackUserId) { skipped++; continue }

      const dbUser = await db.user.findUnique({ where: { slackUserId } })
      if (!dbUser) { skipped++; continue }

      const blocks = await buildStageMismatchMessage(alert)
      const ts = await sendDm(slackUserId, blocks, `Stage mismatch: ${alert.opportunityName}`)

      await db.notification.create({
        data: {
          opportunityId: alert.opportunityId,
          opportunityName: alert.opportunityName,
          ownerId: dbUser.id,
          alertType: AlertType.STAGE_MISMATCH,
          alertDetails: alert as unknown as import('@prisma/client').Prisma.InputJsonValue,
          slackMessageTs: ts,
          slackChannelId: slackUserId,
          status: NotificationStatus.SENT,
        },
      })
      sent++
    } catch (err) {
      console.error(`[AlertJob] Error on stage mismatch ${alert.opportunityId}:`, err)
      errors++
    }
  }

  console.log(`[AlertJob] Done. Sent: ${sent}, Skipped: ${skipped}, Errors: ${errors}`)
  return { sent, skipped, errors }
}
