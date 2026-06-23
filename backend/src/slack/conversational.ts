/**
 * Conversational Slack handler — AI-powered intent detection.
 *
 * Claude interprets what the rep says and routes to the right action:
 *   - update_close_date → update CloseDate in Salesforce
 *   - snooze            → snooze their alert
 *   - list_alerts       → show active alerts
 *   - help              → show help text
 *   - escalate          → redirect to #askrevops (general issues, questions, confusion)
 *   - unknown           → polite fallback
 */

import type { App, BlockAction, SayFn } from '@slack/bolt'
import Anthropic from '@anthropic-ai/sdk'
import * as chrono from 'chrono-node'
import { db } from '../db'
import { updateCloseDate } from '../services/salesforce'
import { config } from '../config'
import { lastBusinessDayOfMonth, parseMonthOnly } from '../utils/dateUtils'
import type { Notification } from '@prisma/client'

// ── Claude client (lazy — only init if key is present) ───────────────────────

let _claude: Anthropic | null = null
function getClaudeClient(): Anthropic | null {
  if (!config.ANTHROPIC_API_KEY) return null
  if (!_claude) _claude = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
  return _claude
}

// ── Intent schema returned by Claude ─────────────────────────────────────────

type Intent =
  | { type: 'update_close_date'; datePhrase: string }
  | { type: 'snooze'; days: number }
  | { type: 'list_alerts' }
  | { type: 'help' }
  | { type: 'escalate'; reason: string }   // → #askrevops
  | { type: 'unknown' }

// ── AI intent classifier ──────────────────────────────────────────────────────

async function classifyIntent(text: string, oppNames: string[]): Promise<Intent> {
  const claude = getClaudeClient()

  // Fallback to regex if no API key
  if (!claude) return regexFallback(text)

  const contextNote = oppNames.length
    ? `The rep currently has open alerts on: ${oppNames.join(', ')}.`
    : `The rep has no open alerts at the moment.`

  const systemPrompt = `You are a Slack bot assistant for a sales pipeline tool called Beacon.
Reps DM you to take action on their Salesforce opportunities or ask for help.

${contextNote}

Classify the rep's message into exactly one of these intents and return valid JSON only:

1. update_close_date — they want to change a close date. Extract the date phrase.
   {"type":"update_close_date","datePhrase":"<the date they mentioned>"}

2. snooze — they want to pause/snooze an alert. Extract days (default 7 if unspecified).
   {"type":"snooze","days":<number>}

3. list_alerts — they want to see their active alerts.
   {"type":"list_alerts"}

4. help — they want to know what the bot can do.
   {"type":"help"}

5. escalate — they have a technical problem, a general question, confusion, a complaint, or something that isn't a direct Salesforce action. This includes things like "I'm having a technical error", "I don't understand", "why did I get this", "there's a bug", "I can't log in", etc.
   {"type":"escalate","reason":"<brief summary of what they said>"}

6. unknown — truly uninterpretable.
   {"type":"unknown"}

Return ONLY the JSON object, nothing else.`

  try {
    const response = await claude.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 100,
      system: systemPrompt,
      messages: [{ role: 'user', content: text }],
    })

    const raw = (response.content[0] as { type: string; text: string }).text.trim()
    return JSON.parse(raw) as Intent
  } catch (err) {
    console.error('[Conversational] Claude classification failed:', (err as Error).message)
    return regexFallback(text)
  }
}

// ── Simple regex fallback (no AI key) ────────────────────────────────────────

function regexFallback(text: string): Intent {
  const lower = text.toLowerCase().trim()

  if (/^(help|\?)$/.test(lower)) return { type: 'help' }
  if (/^(list|my alerts|alerts)/.test(lower)) return { type: 'list_alerts' }

  const closeDateRe = /(?:update|change|push|move|set|new)\s+(?:the\s+)?close\s+date\s+(?:to|for)?\s+(.+)/i
  const m = text.match(closeDateRe)
  if (m) return { type: 'update_close_date', datePhrase: m[1].trim() }

  if (/^snooze$/i.test(lower)) return { type: 'snooze', days: 7 }
  const snoozeM = lower.match(/snooze\s+(?:for\s+)?(\d+)\s*(day|days|week|weeks)/i)
  if (snoozeM) {
    const n = parseInt(snoozeM[1], 10)
    return { type: 'snooze', days: snoozeM[2].startsWith('week') ? n * 7 : n }
  }

  return { type: 'unknown' }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getActiveAlerts(slackUserId: string): Promise<Notification[]> {
  return db.notification.findMany({
    where: { owner: { slackUserId }, status: { in: ['SENT', 'SNOOZED'] } },
    orderBy: { sentAt: 'desc' },
    take: 10,
  })
}

function alertLabel(type: string) {
  return (
    { STALLED: 'Zombie Pipeline', MEDDPICC_MISSING: 'MEDDPICC / BANT', PAST_DUE: 'Past Due' }[type] ?? type
  )
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function executeCloseDate(
  slackUserId: string,
  alert: Notification,
  dateStr: string,
  say: SayFn
) {
  const user = await db.user.findUnique({ where: { slackUserId } })
  if (!user?.sfdcAccessToken) {
    await say({ text: `You'll need to connect Salesforce first. Reach out in *#askrevops* for help.` })
    return
  }
  try {
    await updateCloseDate(user.id, alert.opportunityId, dateStr)
    await db.notification.updateMany({
      where: { opportunityId: alert.opportunityId, status: { in: ['SENT', 'SNOOZED'] } },
      data: { status: 'RESOLVED', resolvedAt: new Date(), sfdcUpdatedAt: new Date(), sfdcUpdateFields: { CloseDate: dateStr } },
    })
    await say({ text: `✅ Close date for *${alert.opportunityName}* updated to *${dateStr}* in Salesforce.` })
  } catch (err) {
    await say({ text: `❌ Couldn't update Salesforce: ${(err as Error).message}` })
  }
}

async function executeSnooze(alert: Notification, days: number, say: SayFn) {
  const snoozedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
  await db.notification.update({ where: { id: alert.id }, data: { status: 'SNOOZED', snoozedUntil } })
  await say({
    text: `😴 Snoozed *${alert.opportunityName}* — I'll remind you again on ${snoozedUntil.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.`,
  })
}

// ── Disambiguation (multiple opps) ────────────────────────────────────────────

function pickOppBlocks(
  prompt: string,
  alerts: Notification[],
  actionId: string,
  actionValueFn: (a: Notification) => object
) {
  return {
    text: prompt,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: prompt } },
      ...alerts.slice(0, 5).map((a) => ({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${a.opportunityName}* — ${alertLabel(a.alertType)}` },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'This one' },
          action_id: actionId,
          value: JSON.stringify(actionValueFn(a)),
        },
      })),
    ],
  }
}

// ── Help text ─────────────────────────────────────────────────────────────────

const HELP_TEXT = `Here's what you can tell me:

• *update close date to [date]* — e.g. "update close date to July 1" or "push to next Friday"
• *snooze* or *snooze 7 days* — pause alerts on a deal for a while
• *list* — see your active alerts

For anything else — questions, technical issues, or general help — post in *#askrevops* and the team will assist you. 👋`

// ── Date resolution ───────────────────────────────────────────────────────────
// If the phrase is just a month (or quarter), return last business day of that month.
// Otherwise fall back to chrono-node for specific dates.

function resolveDate(phrase: string): string | null {
  // Try month-only first
  const monthOnly = parseMonthOnly(phrase.trim())
  if (monthOnly) {
    const d = lastBusinessDayOfMonth(monthOnly.year, monthOnly.month)
    return d.toISOString().split('T')[0]
  }

  // Fall back to chrono-node for "next Friday", "July 15", "2026-08-01", etc.
  const parsed = chrono.parseDate(phrase, new Date(), { forwardDate: true })
  return parsed ? parsed.toISOString().split('T')[0] : null
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

async function handleIntent(slackUserId: string, text: string, say: SayFn) {
  const activeAlerts = await getActiveAlerts(slackUserId)
  const oppNames = activeAlerts.map((a) => a.opportunityName)

  const intent = await classifyIntent(text, oppNames)
  console.log(`[Conversational] ${slackUserId}: "${text}" → ${intent.type}`)

  switch (intent.type) {
    // ── Help ──
    case 'help':
      await say({ text: HELP_TEXT })
      return

    // ── List alerts ──
    case 'list_alerts': {
      if (activeAlerts.length === 0) {
        await say({ text: '✅ You have no active alerts right now.' })
        return
      }
      const lines = activeAlerts
        .map((a, i) => `${i + 1}. *${a.opportunityName}* — ${alertLabel(a.alertType)}`)
        .join('\n')
      await say({ text: `You have ${activeAlerts.length} active alert(s):\n\n${lines}` })
      return
    }

    // ── Escalate to #askrevops ──
    case 'escalate':
      await say({
        text: `Looks like you need a hand with something I can't fix directly. Post in *<#askrevops>* and the RevOps team will help you out. 👋`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `Looks like you need a hand with something I can't fix directly.\n\nPost in *#askrevops* and the RevOps team will help you out. 👋`,
            },
          },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `_I heard: "${intent.reason}"_` }],
          },
        ],
      })
      return

    // ── Update close date ──
    case 'update_close_date': {
      const dateStr = resolveDate(intent.datePhrase)
      if (!dateStr) {
        await say({ text: `I couldn't make out that date. Try something like "update close date to July 1", "push to August", or "push to next Friday".` })
        return
      }

      const relevant = activeAlerts.filter((a) => ['PAST_DUE', 'STALLED'].includes(a.alertType))
      const pool = relevant.length > 0 ? relevant : activeAlerts

      if (pool.length === 0) {
        await say({ text: `You don't have any active alerts to update right now.` })
        return
      }
      if (pool.length === 1) {
        await executeCloseDate(slackUserId, pool[0], dateStr, say)
        return
      }
      await say(pickOppBlocks(
        `Which opportunity should I update the close date to *${dateStr}*?`,
        pool,
        'quick_close_date',
        (a) => ({ oppId: a.opportunityId, oppName: a.opportunityName, dateStr, slackUserId })
      ))
      return
    }

    // ── Snooze ──
    case 'snooze': {
      const days = intent.days ?? 7
      if (activeAlerts.length === 0) {
        await say({ text: `You have no active alerts to snooze.` })
        return
      }
      if (activeAlerts.length === 1) {
        await executeSnooze(activeAlerts[0], days, say)
        return
      }
      await say(pickOppBlocks(
        `Which alert should I snooze for ${days} day${days === 1 ? '' : 's'}?`,
        activeAlerts,
        'quick_snooze',
        (a) => ({ notifId: a.id, oppName: a.opportunityName, days })
      ))
      return
    }

    // ── Unknown ──
    default:
      await say({ text: `I'm not sure what you mean. Type *help* to see what I can do, or post in *#askrevops* if you need help from the team.` })
  }
}

// ── Register with Slack Bolt ──────────────────────────────────────────────────

export function registerConversationalHandler(app: App) {
  // Listen for DMs
  app.message(async ({ message, say }) => {
    if (message.channel_type !== 'im') return
    if ('bot_id' in message) return
    if ('subtype' in message && (message as { subtype?: string }).subtype) return

    const slackUserId = (message as { user?: string }).user
    const text = (message as { text?: string }).text ?? ''
    if (!slackUserId || !text.trim()) return

    await handleIntent(slackUserId, text, say)
  })

  // ── Quick close date (from disambiguation buttons) ────────────────────────
  app.action('quick_close_date', async ({ ack, body, client }) => {
    await ack()
    const action = (body as BlockAction).actions[0] as { value: string }
    const { oppId, dateStr, slackUserId } = JSON.parse(action.value)

    // Wrap client.chat.postMessage as a SayFn-compatible function
    const say: SayFn = (payload) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.chat.postMessage({ channel: slackUserId, ...(payload as any) }) as ReturnType<SayFn>

    const alert = await db.notification.findFirst({
      where: { opportunityId: oppId, owner: { slackUserId }, status: { in: ['SENT', 'SNOOZED'] } },
    })
    if (!alert) {
      await say({ text: `Couldn't find that alert — it may have already been resolved.` })
      return
    }
    await executeCloseDate(slackUserId, alert, dateStr, say)
  })

  // ── Quick snooze (from disambiguation buttons) ────────────────────────────
  app.action('quick_snooze', async ({ ack, body, client }) => {
    await ack()
    const action = (body as BlockAction).actions[0] as { value: string }
    const { notifId, days } = JSON.parse(action.value)
    const slackUserId = body.user.id

    const say: SayFn = (payload) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.chat.postMessage({ channel: slackUserId, ...(payload as any) }) as ReturnType<SayFn>

    const alert = await db.notification.findUnique({ where: { id: notifId } })
    if (!alert) {
      await say({ text: `Couldn't find that alert.` })
      return
    }
    await executeSnooze(alert, days, say)
  })
}
