import { App, LogLevel } from '@slack/bolt'
import { config } from '../config'
import { registerHandlers } from './handlers'
import { db } from '../db'
import type { KnownBlock } from '@slack/bolt'

export let slackApp: App

export function initSlack(): App {
  slackApp = new App({
    token: config.SLACK_BOT_TOKEN,
    signingSecret: config.SLACK_SIGNING_SECRET,
    // Use socket mode in dev (no public URL needed), HTTP in prod
    ...(config.NODE_ENV === 'development' && config.SLACK_APP_TOKEN
      ? { socketMode: true, appToken: config.SLACK_APP_TOKEN }
      : {}),
    logLevel: config.NODE_ENV === 'development' ? LogLevel.DEBUG : LogLevel.ERROR,
  })

  registerHandlers(slackApp)
  return slackApp
}

// Send a DM to a Slack user. Looks up by SFDC email if slackUserId not known.
export async function sendDm(slackUserId: string, blocks: KnownBlock[], text: string): Promise<string | undefined> {
  try {
    const result = await slackApp.client.chat.postMessage({
      channel: slackUserId,
      text,
      blocks,
    })
    return result.ts as string | undefined
  } catch (err) {
    console.error(`Failed to send DM to ${slackUserId}:`, err)
    return undefined
  }
}

// Resolve Slack user ID from email (cached via User table)
export async function resolveSlackUserId(email: string): Promise<string | null> {
  // Check DB first
  const existing = await db.user.findUnique({ where: { slackEmail: email } })
  if (existing) return existing.slackUserId

  // Look up via Slack API
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
