import { App, LogLevel } from '@slack/bolt'
import { config } from '../config'
import { registerHandlers } from './handlers'
import { db } from '../db'
import type { KnownBlock } from '@slack/bolt'

export let slackApp: App

export function isSlackConfigured(): boolean {
  return !!(config.SLACK_BOT_TOKEN && config.SLACK_SIGNING_SECRET)
}

export function initSlack(): App | null {
  if (!isSlackConfigured()) {
    console.warn('⚠️  Slack not configured — skipping Slack bot init. Set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET to enable.')
    return null
  }

  slackApp = new App({
    token: config.SLACK_BOT_TOKEN!,
    signingSecret: config.SLACK_SIGNING_SECRET!,
    ...(config.NODE_ENV === 'development' && config.SLACK_APP_TOKEN
      ? { socketMode: true, appToken: config.SLACK_APP_TOKEN }
      : {}),
    logLevel: config.NODE_ENV === 'development' ? LogLevel.DEBUG : LogLevel.ERROR,
  })

  registerHandlers(slackApp)
  return slackApp
}

// ── Test mode override ────────────────────────────────────────────────────────
// If slackTestRecipient is set in AppSetting, ALL DMs go to that user instead.
// A banner is prepended so the tester can see who the real recipient would be.

// Cache the resolved real Slack ID for the test recipient (skips DB — admin users have fake IDs)
let _testOverrideSlackId: string | null | undefined = undefined

export function invalidateTestOverrideCache(): void {
  _testOverrideSlackId = undefined
}

async function getTestOverrideSlackId(): Promise<string | null> {
  try {
    const setting = await db.appSetting.findUnique({ where: { key: 'slackTestRecipient' } })
    if (!setting) { _testOverrideSlackId = undefined; return null }
    const email = JSON.parse(setting.value) as string
    if (!email) { _testOverrideSlackId = undefined; return null }

    // Return cached ID if we already resolved it
    if (_testOverrideSlackId !== undefined) return _testOverrideSlackId

    // Go directly to Slack API — bypass DB since admin users have fake slackUserIds
    if (!slackApp) return null
    const result = await slackApp.client.users.lookupByEmail({ email })
    const id = result.user?.id ?? null
    _testOverrideSlackId = id
    if (id) console.log(`[TestMode] Resolved override recipient ${email} → ${id}`)
    else console.warn(`[TestMode] Could not resolve Slack ID for ${email} — test mode inactive`)
    return id
  } catch (err) {
    console.warn('[TestMode] Failed to resolve override recipient:', (err as Error).message)
    return null
  }
}

async function resolveActualRecipient(
  intendedSlackUserId: string
): Promise<{ recipientId: string; testBanner: KnownBlock | null }> {
  const overrideId = await getTestOverrideSlackId()
  if (!overrideId || overrideId === intendedSlackUserId) {
    return { recipientId: intendedSlackUserId, testBanner: null }
  }

  // Look up the intended recipient's name for the banner
  const intended = await db.user.findUnique({ where: { slackUserId: intendedSlackUserId } })
  const intendedName = intended?.slackName ?? intended?.slackEmail ?? intendedSlackUserId

  const banner: KnownBlock = {
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `🧪 *Test mode* — this message would normally go to *${intendedName}*`,
    }],
  }

  return { recipientId: overrideId, testBanner: banner }
}

// ── Send a DM ─────────────────────────────────────────────────────────────────
export async function sendDm(slackUserId: string, blocks: KnownBlock[], text: string): Promise<string | undefined> {
  if (!slackApp) { console.warn('[Slack] sendDm skipped — Slack not configured'); return undefined }

  const { recipientId, testBanner } = await resolveActualRecipient(slackUserId)
  const finalBlocks = testBanner ? [testBanner, ...blocks] : blocks

  try {
    const result = await slackApp.client.chat.postMessage({
      channel: recipientId,
      text: testBanner ? `[TEST → ${slackUserId}] ${text}` : text,
      blocks: finalBlocks,
    })
    return result.ts as string | undefined
  } catch (err) {
    console.error(`Failed to send DM to ${recipientId}:`, err)
    return undefined
  }
}

// Resolve Slack user ID from email (cached via User table)
export async function resolveSlackUserId(email: string): Promise<string | null> {
  const existing = await db.user.findUnique({ where: { slackEmail: email } })
  if (existing) return existing.slackUserId

  if (!slackApp) return null

  try {
    const result = await slackApp.client.users.lookupByEmail({ email })
    const slackUser = result.user
    if (!slackUser?.id) return null

    // Upsert the user record
    await db.user.upsert({
      where: { slackEmail: email },
      create: {
        slackUserId: slackUser.id,
        slackEmail: email,
        slackName: slackUser.real_name ?? null,
        slackAvatarUrl: slackUser.profile?.image_72 ?? null,
      },
      update: {
        slackUserId: slackUser.id,
        slackName: slackUser.real_name ?? null,
      },
    })

    return slackUser.id
  } catch (err) {
    console.error(`Could not resolve Slack user for ${email}:`, err)
    return null
  }
}
