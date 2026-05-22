import type { App, BlockAction, ViewSubmitAction } from '@slack/bolt'
import { db } from '../db'
import { updateCloseDate, updateMeddpiccFields, updateStage } from '../services/salesforce'
import { config } from '../config'
import { MEDDPICC_LABELS, type MeddpiccField } from '../alerts/meddpicc'
import jwt from 'jsonwebtoken'

// Helper: get or prompt user to connect SFDC
async function requireSfdcUser(slackUserId: string, client: App['client'], triggerId?: string) {
  const user = await db.user.findUnique({ where: { slackUserId } })

  if (!user) {
    // Unknown user — create a stub and prompt to connect
    const slackUser = await (client as Parameters<typeof client.users.info>[0] extends never ? never : typeof client).users.info({ user: slackUserId })
    const email = (slackUser as { user?: { profile?: { email?: string } } }).user?.profile?.email ?? ''
    const created = await db.user.create({
      data: { slackUserId, slackEmail: email, slackName: (slackUser as { user?: { real_name?: string } }).user?.real_name },
    })
    return { user: created, connected: false }
  }

  if (!user.sfdcAccessToken) {
    return { user, connected: false }
  }

  return { user, connected: true }
}

export function registerHandlers(app: App) {

  // ── Update Close Date ──────────────────────────────────────────────────────

  app.action('update_close_date', async ({ ack, body, client }) => {
    await ack()
    const action = (body as BlockAction).actions[0] as { value: string }
    const { oppId, oppName } = JSON.parse(action.value)
    const slackUserId = body.user.id

    const { connected } = await requireSfdcUser(slackUserId, client as App['client'])
    if (!connected) {
      const token = jwt.sign({ slackUserId, redirect: 'close_date', oppId }, config.JWT_SECRET, { expiresIn: '1h' })
      await client.views.open({
        trigger_id: (body as BlockAction).trigger_id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Connect Salesforce' },
          blocks: [{
            type: 'section',
            text: { type: 'mrkdwn', text: `Before updating, please <${config.APP_URL}/auth/sfdc/start?state=${token}|connect your Salesforce account> (one-time).` },
          }],
        },
      })
      return
    }

    await client.views.open({
      trigger_id: (body as BlockAction).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'submit_close_date',
        private_metadata: JSON.stringify({ oppId, oppName, slackUserId }),
        title: { type: 'plain_text', text: 'Update Close Date' },
        submit: { type: 'plain_text', text: 'Update in Salesforce' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `Updating close date for *${oppName}*` },
          },
          {
            type: 'input',
            block_id: 'new_close_date',
            label: { type: 'plain_text', text: 'New Close Date' },
            element: {
              type: 'datepicker',
              action_id: 'date_value',
              placeholder: { type: 'plain_text', text: 'Select a date' },
            },
          },
        ],
      },
    })
  })

  app.view('submit_close_date', async ({ ack, view, body, client }) => {
    await ack()
    const { oppId, oppName, slackUserId } = JSON.parse(view.private_metadata)
    const newDate = view.state.values.new_close_date.date_value.selected_date!

    const user = await db.user.findUniqueOrThrow({ where: { slackUserId } })

    try {
      await updateCloseDate(user.id, oppId, newDate)

      await client.chat.postMessage({
        channel: slackUserId,
        text: `✅ Close date for *${oppName}* updated to *${newDate}* in Salesforce.`,
      })

      // Mark notification resolved
      await db.notification.updateMany({
        where: { opportunityId: oppId, status: 'SENT' },
        data: { status: 'RESOLVED', resolvedAt: new Date(), sfdcUpdatedAt: new Date(), sfdcUpdateFields: { CloseDate: newDate } },
      })
    } catch (err) {
      await client.chat.postMessage({
        channel: slackUserId,
        text: `❌ Failed to update Salesforce: ${(err as Error).message}`,
      })
    }
  })

  // ── Update MEDDPICC ────────────────────────────────────────────────────────

  app.action('update_meddpicc', async ({ ack, body, client }) => {
    await ack()
    const action = (body as BlockAction).actions[0] as { value: string }
    const { oppId, oppName, missingFields, sfdcFieldMap } = JSON.parse(action.value) as {
      oppId: string
      oppName: string
      missingFields: MeddpiccField[]
      sfdcFieldMap: Record<MeddpiccField, string>
    }

    const inputBlocks = missingFields.map((field) => ({
      type: 'input',
      block_id: `meddpicc_${field}`,
      label: { type: 'plain_text', text: MEDDPICC_LABELS[field] },
      element: {
        type: 'plain_text_input',
        action_id: 'value',
        multiline: field === 'decisionProcess' || field === 'decisionCriteria',
        placeholder: { type: 'plain_text', text: `Enter ${MEDDPICC_LABELS[field]}` },
      },
      optional: false,
    }))

    await client.views.open({
      trigger_id: (body as BlockAction).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'submit_meddpicc',
        private_metadata: JSON.stringify({ oppId, oppName, missingFields, sfdcFieldMap, slackUserId: body.user.id }),
        title: { type: 'plain_text', text: 'Update MEDDPICC' },
        submit: { type: 'plain_text', text: 'Save to Salesforce' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `Updating missing MEDDPICC fields for *${oppName}*` },
          },
          ...inputBlocks,
        ],
      },
    })
  })

  app.view('submit_meddpicc', async ({ ack, view, client }) => {
    await ack()
    const { oppId, oppName, missingFields, sfdcFieldMap, slackUserId } = JSON.parse(view.private_metadata)

    const user = await db.user.findUniqueOrThrow({ where: { slackUserId } })
    const updates: Record<string, string> = {}

    for (const field of missingFields as MeddpiccField[]) {
      const val = view.state.values[`meddpicc_${field}`]?.value?.value
      if (val) updates[sfdcFieldMap[field]] = val
    }

    try {
      await updateMeddpiccFields(user.id, oppId, updates)

      const updatedLabels = (missingFields as MeddpiccField[])
        .filter((f) => updates[sfdcFieldMap[f]])
        .map((f) => MEDDPICC_LABELS[f])
        .join(', ')

      await client.chat.postMessage({
        channel: slackUserId,
        text: `✅ MEDDPICC updated for *${oppName}*: ${updatedLabels}`,
      })

      await db.notification.updateMany({
        where: { opportunityId: oppId, alertType: 'MEDDPICC_MISSING', status: 'SENT' },
        data: { status: 'RESOLVED', resolvedAt: new Date(), sfdcUpdatedAt: new Date(), sfdcUpdateFields: updates },
      })
    } catch (err) {
      await client.chat.postMessage({
        channel: slackUserId,
        text: `❌ Failed to update Salesforce: ${(err as Error).message}`,
      })
    }
  })

  // ── Update Stage ───────────────────────────────────────────────────────────

  app.action('update_stage', async ({ ack, body, client }) => {
    await ack()
    const action = (body as BlockAction).actions[0] as { value: string }
    const { oppId, oppName, currentStage } = JSON.parse(action.value)

    // Fetch available stages from config
    const stageConfig = await db.meddpiccStageRequirement.findMany({ select: { stageName: true } })
    const stageOptions = stageConfig.map((s: { stageName: string }) => ({
      text: { type: 'plain_text' as const, text: s.stageName },
      value: s.stageName,
    }))

    await client.views.open({
      trigger_id: (body as BlockAction).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'submit_stage',
        private_metadata: JSON.stringify({ oppId, oppName, slackUserId: body.user.id }),
        title: { type: 'plain_text', text: 'Update Stage' },
        submit: { type: 'plain_text', text: 'Update in Salesforce' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `Updating stage for *${oppName}* (currently *${currentStage}*)` },
          },
          {
            type: 'input',
            block_id: 'new_stage',
            label: { type: 'plain_text', text: 'New Stage' },
            element: {
              type: 'static_select',
              action_id: 'stage_value',
              options: stageOptions.length > 0 ? stageOptions : [{ text: { type: 'plain_text', text: currentStage }, value: currentStage }],
            },
          },
        ],
      },
    })
  })

  app.view('submit_stage', async ({ ack, view, client }) => {
    await ack()
    const { oppId, oppName, slackUserId } = JSON.parse(view.private_metadata)
    const newStage = view.state.values.new_stage.stage_value.selected_option!.value

    const user = await db.user.findUniqueOrThrow({ where: { slackUserId } })

    try {
      await updateStage(user.id, oppId, newStage)
      await client.chat.postMessage({
        channel: slackUserId,
        text: `✅ Stage for *${oppName}* updated to *${newStage}* in Salesforce.`,
      })
      await db.notification.updateMany({
        where: { opportunityId: oppId, alertType: 'STALLED', status: 'SENT' },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      })
    } catch (err) {
      await client.chat.postMessage({
        channel: slackUserId,
        text: `❌ Failed to update Salesforce: ${(err as Error).message}`,
      })
    }
  })

  // ── Snooze ─────────────────────────────────────────────────────────────────

  app.action('snooze_notification', async ({ ack, body, client }) => {
    await ack()
    const action = (body as BlockAction).actions[0] as { value: string }
    const { oppId, days, alertType } = JSON.parse(action.value)

    const snoozedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000)

    await db.notification.updateMany({
      where: { opportunityId: oppId, alertType, status: 'SENT' },
      data: { status: 'SNOOZED', snoozedUntil },
    })

    await client.chat.postMessage({
      channel: body.user.id,
      text: `😴 Snoozed — I'll remind you again on ${snoozedUntil.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.`,
    })
  })

  // ── Log Activity (for stalled) ─────────────────────────────────────────────

  app.action('log_activity', async ({ ack, body, client }) => {
    await ack()
    const action = (body as BlockAction).actions[0] as { value: string }
    const { oppId, oppName } = JSON.parse(action.value)

    await client.views.open({
      trigger_id: (body as BlockAction).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'submit_activity',
        private_metadata: JSON.stringify({ oppId, oppName, slackUserId: body.user.id }),
        title: { type: 'plain_text', text: 'Log Activity' },
        submit: { type: 'plain_text', text: 'Log in Salesforce' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'activity_note',
            label: { type: 'plain_text', text: 'Activity Notes' },
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'What happened on this deal?' },
            },
          },
          {
            type: 'input',
            block_id: 'activity_type',
            label: { type: 'plain_text', text: 'Activity Type' },
            element: {
              type: 'static_select',
              action_id: 'value',
              options: [
                { text: { type: 'plain_text', text: 'Call' }, value: 'Call' },
                { text: { type: 'plain_text', text: 'Email' }, value: 'Email' },
                { text: { type: 'plain_text', text: 'Meeting' }, value: 'Meeting' },
                { text: { type: 'plain_text', text: 'Demo' }, value: 'Demo' },
              ],
            },
          },
        ],
      },
    })
  })

  app.view('submit_activity', async ({ ack, view, client }) => {
    await ack()
    const { oppId, oppName, slackUserId } = JSON.parse(view.private_metadata)
    const note = view.state.values.activity_note.value.value!
    const activityType = view.state.values.activity_type.value.selected_option!.value

    const user = await db.user.findUniqueOrThrow({ where: { slackUserId } })
    const { updateOpportunity } = await import('../services/salesforce')

    try {
      // Create a Task in SFDC
      const jsforce = await import('jsforce')
      const { getConnectionForUser } = await import('../services/salesforce')
      const conn = await getConnectionForUser(user.id)
      await conn.sobject('Task').create({
        WhatId: oppId,
        Subject: `${activityType} - Pipeline Nudge`,
        Description: note,
        Status: 'Completed',
        Type: activityType,
        ActivityDate: new Date().toISOString().split('T')[0],
      })

      await client.chat.postMessage({
        channel: slackUserId,
        text: `✅ Activity logged on *${oppName}* in Salesforce.`,
      })

      await db.notification.updateMany({
        where: { opportunityId: oppId, alertType: 'STALLED', status: 'SENT' },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      })
    } catch (err) {
      await client.chat.postMessage({
        channel: slackUserId,
        text: `❌ Failed to log activity: ${(err as Error).message}`,
      })
    }
  })
}
