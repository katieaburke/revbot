import { db } from '../db'
import { fetchOpenOpportunities } from '../services/salesforce'
import { fetchGongActivityBySfdcId, fetchGongWarningsBySfdcId } from '../services/gong'
import { evaluatePastDue } from '../alerts/pastDue'
import { evaluateStalled } from '../alerts/stalled'
import { evaluateMeddpicc } from '../alerts/meddpicc'
import { sendDm, resolveSlackUserId } from '../slack/bot'
import { buildPastDueMessage, buildStalledMessage, buildMeddpiccMessage } from '../slack/messages'
import { AlertType, NotificationStatus } from '../types'

const COOLDOWN_HOURS = 24 // don't re-notify for same opp+type within this window

async function isSnoozedOrRecentlySent(oppId: string, alertType: AlertType): Promise<boolean> {
  const recent = await db.notification.findFirst({
    where: {
      opportunityId: oppId,
      alertType,
      status: { in: [NotificationStatus.SENT, NotificationStatus.SNOOZED] },
    },
    orderBy: { sentAt: 'desc' },
  })

  if (!recent) return false
  if (recent.status === NotificationStatus.SNOOZED && recent.snoozedUntil && recent.snoozedUntil > new Date()) return true
  if (recent.status === NotificationStatus.SENT) {
    const hoursSince = (Date.now() - recent.sentAt.getTime()) / (1000 * 60 * 60)
    if (hoursSince < COOLDOWN_HOURS) return true
  }

  return false
}

export async function runAlertJob(): Promise<{ sent: number; skipped: number; errors: number }> {
  console.log('[AlertJob] Starting alert evaluation...')

  let sent = 0
  let skipped = 0
  let errors = 0

  // 1. Fetch all open opps from SFDC
  const opps = await fetchOpenOpportunities()
  console.log(`[AlertJob] Fetched ${opps.length} open opportunities`)

  const sfdcIds = opps.map((o) => o.Id)

  // 2. Fetch Gong data in parallel
  const [gongActivity, gongWarnings] = await Promise.all([
    fetchGongActivityBySfdcId(sfdcIds),
    fetchGongWarningsBySfdcId(sfdcIds),
  ])

  // 3. Load config from DB
  const [stallRules, meddpiccRequirements] = await Promise.all([
    db.stallRule.findMany({ where: { enabled: true } }),
    db.meddpiccStageRequirement.findMany({ where: { enabled: true } }),
  ])

  // 4. Evaluate all alert types
  const pastDueAlerts = evaluatePastDue(opps)
  const stalledAlerts = evaluateStalled(opps, stallRules, gongActivity, gongWarnings)
  const meddpiccAlerts = evaluateMeddpicc(opps, meddpiccRequirements)

  console.log(`[AlertJob] Found: ${pastDueAlerts.length} past due, ${stalledAlerts.length} stalled, ${meddpiccAlerts.length} MEDDPICC`)

  // 5. Send notifications (with dedup/snooze checks)
  for (const alert of pastDueAlerts) {
    try {
      if (await isSnoozedOrRecentlySent(alert.opportunityId, alert.alertType)) {
        skipped++
        continue
      }

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
          alertDetails: alert as unknown as Record<string, unknown>,
          slackMessageTs: ts,
          slackChannelId: slackUserId,
          status: NotificationStatus.SENT,
        },
      })
      sent++
    } catch (err) {
      console.error(`[AlertJob] Error processing past due alert for ${alert.opportunityId}:`, err)
      errors++
    }
  }

  for (const alert of stalledAlerts) {
    try {
      if (await isSnoozedOrRecentlySent(alert.opportunityId, AlertType.STALLED)) {
        skipped++
        continue
      }

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
          alertDetails: alert as unknown as Record<string, unknown>,
          slackMessageTs: ts,
          slackChannelId: slackUserId,
          stallRuleId: alert.ruleId,
          status: NotificationStatus.SENT,
        },
      })
      sent++
    } catch (err) {
      console.error(`[AlertJob] Error processing stalled alert for ${alert.opportunityId}:`, err)
      errors++
    }
  }

  for (const alert of meddpiccAlerts) {
    try {
      if (await isSnoozedOrRecentlySent(alert.opportunityId, AlertType.MEDDPICC_MISSING)) {
        skipped++
        continue
      }

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
          alertDetails: alert as unknown as Record<string, unknown>,
          slackMessageTs: ts,
          slackChannelId: slackUserId,
          status: NotificationStatus.SENT,
        },
      })
      sent++
    } catch (err) {
      console.error(`[AlertJob] Error processing MEDDPICC alert for ${alert.opportunityId}:`, err)
      errors++
    }
  }

  console.log(`[AlertJob] Done. Sent: ${sent}, Skipped: ${skipped}, Errors: ${errors}`)
  return { sent, skipped, errors }
}
