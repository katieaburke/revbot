import type { App, BlockAction, ViewSubmitAction } from '@slack/bolt'
import type { KnownBlock } from '@slack/web-api'
import { db } from '../db'
import { updateCloseDate, updateMeddpiccFields, updateStage, updateOpportunity } from '../services/salesforce'
import { config } from '../config'
import { MEDDPICC_LABELS, type MeddpiccField } from '../alerts/meddpicc'
import jwt from 'jsonwebtoken'
import { registerConversationalHandler } from './conversational'

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
  // Natural language DM handler
  registerConversationalHandler(app)

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

    const { connected } = await requireSfdcUser(body.user.id, client as App['client'])
    if (!connected) {
      const token = jwt.sign({ slackUserId: body.user.id, redirect: 'meddpicc', oppId }, config.JWT_SECRET, { expiresIn: '1h' })
      await client.views.open({
        trigger_id: (body as BlockAction).trigger_id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Connect Salesforce' },
          blocks: [{
            type: 'section',
            text: { type: 'mrkdwn', text: `To update this deal in Salesforce, please <${config.APP_URL}/auth/sfdc/start?state=${token}|connect your Salesforce account> — this only takes a minute and is a one-time step.` },
          }],
        },
      })
      return
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

    const { connected } = await requireSfdcUser(body.user.id, client as App['client'])
    if (!connected) {
      const token = jwt.sign({ slackUserId: body.user.id, redirect: 'stage', oppId }, config.JWT_SECRET, { expiresIn: '1h' })
      await client.views.open({
        trigger_id: (body as BlockAction).trigger_id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Connect Salesforce' },
          blocks: [{
            type: 'section',
            text: { type: 'mrkdwn', text: `To update this deal in Salesforce, please <${config.APP_URL}/auth/sfdc/start?state=${token}|connect your Salesforce account> — this only takes a minute and is a one-time step.` },
          }],
        },
      })
      return
    }

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

  // ── Close Renewal ──────────────────────────────────────────────────────────

  app.action('close_renewal', async ({ ack, body, client }) => {
    await ack()
    const action = (body as BlockAction).actions[0] as { value: string }
    const { oppId, oppName } = JSON.parse(action.value)

    const { connected } = await requireSfdcUser(body.user.id, client as App['client'])
    if (!connected) {
      const token = jwt.sign({ slackUserId: body.user.id, redirect: 'renewal', oppId }, config.JWT_SECRET, { expiresIn: '1h' })
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
        callback_id: 'submit_close_renewal',
        private_metadata: JSON.stringify({ oppId, oppName, slackUserId: body.user.id }),
        title: { type: 'plain_text', text: 'Close Renewal' },
        submit: { type: 'plain_text', text: 'Close in Salesforce' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `Closing renewal: *${oppName}*\n\n_If the account has auto-renewed, close this at the current flat renewal amount. Open a separate amendment for any growth you're still pitching._`,
            },
          },
          {
            type: 'input',
            block_id: 'close_date',
            label: { type: 'plain_text', text: 'Actual Close Date' },
            element: {
              type: 'datepicker',
              action_id: 'date_value',
              initial_date: new Date().toISOString().split('T')[0],
              placeholder: { type: 'plain_text', text: 'Select close date' },
            },
          },
          {
            type: 'input',
            block_id: 'renewal_type',
            label: { type: 'plain_text', text: 'Renewal type' },
            element: {
              type: 'static_select',
              action_id: 'value',
              options: [
                { text: { type: 'plain_text', text: 'Flat renewal (auto-renewed)' }, value: 'flat' },
                { text: { type: 'plain_text', text: 'Standard renewal (rep-closed)' }, value: 'standard' },
              ],
            },
          },
          {
            type: 'input',
            block_id: 'renewal_notes',
            label: { type: 'plain_text', text: 'Notes (optional)' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'Any context for this renewal...' },
            },
          },
        ],
      },
    })
  })

  app.view('submit_close_renewal', async ({ ack, view, client }) => {
    await ack()
    const { oppId, oppName, slackUserId } = JSON.parse(view.private_metadata)
    const closeDate = view.state.values.close_date.date_value.selected_date!
    const renewalType = view.state.values.renewal_type.value.selected_option!.value
    const notes = view.state.values.renewal_notes?.value?.value ?? ''

    const user = await db.user.findUniqueOrThrow({ where: { slackUserId } })

    try {
      const typeLabel = renewalType === 'flat' ? 'Flat Renewal' : 'Standard Renewal'
      await updateOpportunity(user.id, oppId, {
        StageName: 'Closed Won',
        CloseDate: closeDate,
      })

      // Log an activity note
      const { getConnectionForUser } = await import('../services/salesforce') as typeof import('../services/salesforce')
      const conn = await getConnectionForUser(user.id)
      await conn.sobject('Task').create({
        WhatId: oppId,
        Subject: `${typeLabel} — closed via Beacon`,
        Description: notes || `Renewal closed as ${typeLabel} via Beacon.`,
        Status: 'Completed',
        ActivityDate: closeDate,
      })

      const followUp = renewalType === 'flat'
        ? `\n\n_Don't forget to open a separate amendment for any growth you're still pursuing._`
        : ''

      await client.chat.postMessage({
        channel: slackUserId,
        text: `✅ *${oppName}* closed as *${typeLabel}* in Salesforce.${followUp}`,
      })

      await db.notification.updateMany({
        where: { opportunityId: oppId, status: 'SENT' },
        data: { status: 'RESOLVED', resolvedAt: new Date(), sfdcUpdatedAt: new Date() },
      })
    } catch (err) {
      await client.chat.postMessage({
        channel: slackUserId,
        text: `❌ Failed to update Salesforce: ${(err as Error).message}`,
      })
    }
  })

  // ── Snooze (legacy fixed 7-day, kept for any old messages still in flight) ──

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

  // ── Snooze (with duration picker) ─────────────────────────────────────────

  app.action('snooze_options', async ({ ack, body, client }) => {
    await ack()
    const action = (body as BlockAction).actions[0] as { value: string }
    const { oppId, alertType } = JSON.parse(action.value)

    await client.views.open({
      trigger_id: (body as BlockAction).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'submit_snooze',
        private_metadata: JSON.stringify({ oppId, alertType, slackUserId: body.user.id }),
        title: { type: 'plain_text', text: 'Snooze Alert' },
        submit: { type: 'plain_text', text: 'Snooze' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'snooze_duration',
            label: { type: 'plain_text', text: 'Remind me again in...' },
            element: {
              type: 'radio_buttons',
              action_id: 'value',
              options: [
                { text: { type: 'plain_text', text: '3 days' }, value: '3' },
                { text: { type: 'plain_text', text: '1 week' }, value: '7' },
                { text: { type: 'plain_text', text: '2 weeks' }, value: '14' },
                { text: { type: 'plain_text', text: '1 month' }, value: '30' },
              ],
            },
          },
        ],
      },
    })
  })

  app.view('submit_snooze', async ({ ack, view, client }) => {
    await ack()
    const { oppId, alertType, slackUserId } = JSON.parse(view.private_metadata)
    const days = parseInt(view.state.values.snooze_duration.value.selected_option!.value, 10)
    const snoozedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000)

    await db.notification.updateMany({
      where: { opportunityId: oppId, alertType, status: { in: ['SENT', 'SNOOZED'] } },
      data: { status: 'SNOOZED', snoozedUntil },
    })

    await client.chat.postMessage({
      channel: slackUserId,
      text: `😴 Snoozed for ${days} day${days === 1 ? '' : 's'} — I'll remind you again on ${snoozedUntil.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.`,
    })
  })

  // ── Need Help → #askrevops ─────────────────────────────────────────────────

  app.action('need_help', async ({ ack, body, client }) => {
    await ack()
    await client.chat.postMessage({
      channel: body.user.id,
      text: `👋 Post in *#askrevops* and the RevOps team will help you out!`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `👋 Post in *#askrevops* and the RevOps team will help you out!`,
          },
        },
      ],
    })
  })

  // ── Update Next Step ───────────────────────────────────────────────────────

  app.action('update_next_step', async ({ ack, body, client }) => {
    await ack()
    const action = (body as BlockAction).actions[0] as { value: string }
    const { oppId, oppName } = JSON.parse(action.value)

    const { connected } = await requireSfdcUser(body.user.id, client as App['client'])
    if (!connected) {
      const token = jwt.sign({ slackUserId: body.user.id, redirect: 'next_step', oppId }, config.JWT_SECRET, { expiresIn: '1h' })
      await client.views.open({
        trigger_id: (body as BlockAction).trigger_id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Connect Salesforce' },
          blocks: [{
            type: 'section',
            text: { type: 'mrkdwn', text: `To update this deal in Salesforce, please <${config.APP_URL}/auth/sfdc/start?state=${token}|connect your Salesforce account> — this only takes a minute and is a one-time step.` },
          }],
        },
      })
      return
    }

    await client.views.open({
      trigger_id: (body as BlockAction).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'submit_next_step',
        private_metadata: JSON.stringify({ oppId, oppName, slackUserId: body.user.id }),
        title: { type: 'plain_text', text: 'Update Next Step' },
        submit: { type: 'plain_text', text: 'Save to Salesforce' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `Updating next step for *${oppName}*` },
          },
          {
            type: 'input',
            block_id: 'next_step_text',
            label: { type: 'plain_text', text: 'Next Step' },
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'What is the next action on this deal?' },
            },
          },
          {
            type: 'input',
            block_id: 'next_step_date',
            label: { type: 'plain_text', text: 'Next Step Date' },
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

  app.view('submit_next_step', async ({ ack, view, client }) => {
    await ack()
    const { oppId, oppName, slackUserId } = JSON.parse(view.private_metadata)
    const nextStepText = view.state.values.next_step_text.value.value!
    const nextStepDate = view.state.values.next_step_date.date_value.selected_date!

    const user = await db.user.findUniqueOrThrow({ where: { slackUserId } })

    try {
      await updateOpportunity(user.id, oppId, {
        NextStep: nextStepText,
        Next_Step_Date__c: nextStepDate,
      })

      await client.chat.postMessage({
        channel: slackUserId,
        text: `✅ Next step updated for *${oppName}*: "${nextStepText}" by *${nextStepDate}*.`,
      })

      await db.notification.updateMany({
        where: { opportunityId: oppId, alertType: 'NEXT_STEP_MISSING', status: { in: ['SENT', 'SNOOZED'] } },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          sfdcUpdatedAt: new Date(),
          sfdcUpdateFields: { NextStep: nextStepText, Next_Step_Date__c: nextStepDate },
        },
      })
    } catch (err) {
      await client.chat.postMessage({
        channel: slackUserId,
        text: `❌ Failed to update Salesforce: ${(err as Error).message}`,
      })
    }
  })

  // ── Open in Salesforce (URL button — just needs ack) ──────────────────────

  app.action('open_sfdc', async ({ ack }) => { await ack() })

  // ── Update Prospecting Fields (BDR hygiene nudge) ──────────────────────────

  const PROSPECTING_STATUSES = ['Planned', 'Prospecting', 'Paused', 'Nurturing', 'Success']
  const PAUSE_REASONS = ['Budget constraints', 'Evaluating competitors', 'No budget cycle', 'Not a priority', 'Timing not right', 'Not ICP']

  app.action('update_status_sfdc', async ({ ack, body, client }) => {
    await ack()
    const action = (body as BlockAction).actions[0] as { value: string }
    const { accountId, accountName, prospectingStatus, prospectingPauseReason, reEngageDate, competitor, competitorEndDate } = JSON.parse(action.value) as {
      accountId: string
      accountName: string
      prospectingStatus: string | null
      prospectingPauseReason: string | null
      reEngageDate: string | null
      competitor: string | null
      competitorEndDate: string | null
    }

    // channel + message ts so we can update the original message after submit
    const channel = (body as { channel?: { id?: string } }).channel?.id
    const messageTs = (body as { message?: { ts?: string } }).message?.ts

    const statusOptions = PROSPECTING_STATUSES.map((s) => ({
      text: { type: 'plain_text' as const, text: s },
      value: s,
    }))
    const pauseOptions = PAUSE_REASONS.map((r) => ({
      text: { type: 'plain_text' as const, text: r },
      value: r,
    }))

    await client.views.open({
      trigger_id: (body as BlockAction).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'submit_prospecting_update',
        private_metadata: JSON.stringify({ accountId, accountName, slackUserId: body.user.id, channel, messageTs }),
        title: { type: 'plain_text', text: 'Update Account' },
        submit: { type: 'plain_text', text: 'Save to Salesforce' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `Updating prospecting fields for *${accountName}*` },
          },
          {
            type: 'input',
            block_id: 'prospecting_status',
            label: { type: 'plain_text', text: 'Prospecting Status' },
            element: {
              type: 'static_select',
              action_id: 'value',
              ...(prospectingStatus ? { initial_option: { text: { type: 'plain_text' as const, text: prospectingStatus }, value: prospectingStatus } } : {}),
              options: statusOptions,
            },
          },
          {
            type: 'input',
            block_id: 'pause_reason',
            label: { type: 'plain_text', text: 'Hold reason' },
            hint: { type: 'plain_text', text: 'Set this if moving to Paused' },
            optional: true,
            element: {
              type: 'static_select',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'Select a reason' },
              ...(prospectingPauseReason ? { initial_option: { text: { type: 'plain_text' as const, text: prospectingPauseReason }, value: prospectingPauseReason } } : {}),
              options: pauseOptions,
            },
          },
          {
            type: 'input',
            block_id: 're_engage_date',
            label: { type: 'plain_text', text: 'Date to re-engage' },
            hint: { type: 'plain_text', text: 'Set if pausing or deferring outreach' },
            optional: true,
            element: {
              type: 'datepicker',
              action_id: 'date_value',
              placeholder: { type: 'plain_text', text: 'Select a date' },
              ...(reEngageDate ? { initial_date: reEngageDate } : {}),
            },
          },
          {
            type: 'input',
            block_id: 'competitor',
            label: { type: 'plain_text', text: 'Incumbent vendor' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'value',
              placeholder: { type: 'plain_text', text: 'e.g. Salesforce, HubSpot' },
              ...(competitor ? { initial_value: competitor } : {}),
            },
          },
          {
            type: 'input',
            block_id: 'competitor_end_date',
            label: { type: 'plain_text', text: 'Vendor contract end date' },
            optional: true,
            element: {
              type: 'datepicker',
              action_id: 'date_value',
              placeholder: { type: 'plain_text', text: 'Select a date' },
              ...(competitorEndDate ? { initial_date: competitorEndDate } : {}),
            },
          },
        ],
      },
    })
  })

  app.view('submit_prospecting_update', async ({ ack, view, client }) => {
    await ack()
    const { accountId, accountName, slackUserId, channel, messageTs } = JSON.parse(view.private_metadata) as {
      accountId: string
      accountName: string
      slackUserId: string
      channel: string | null
      messageTs: string | null
    }

    const status = view.state.values.prospecting_status?.value?.selected_option?.value ?? null
    const pauseReason = view.state.values.pause_reason?.value?.selected_option?.value ?? null
    const reEngageDate = view.state.values.re_engage_date?.date_value?.selected_date ?? null
    const competitor = view.state.values.competitor?.value?.value?.trim() || null
    const competitorEndDate = view.state.values.competitor_end_date?.date_value?.selected_date ?? null

    try {
      const { updateProspectAccount } = await import('../services/salesforce')

      await updateProspectAccount(accountId, {
        ...(status !== null ? { Prospecting_Status__c: status } : {}),
        // Clear hold reason if not paused, set it if paused
        ...(status && status !== 'Paused' ? { Prospecting_Pause_Reason__c: null } : {}),
        ...(status === 'Paused' && pauseReason ? { Prospecting_Pause_Reason__c: pauseReason } : {}),
        ...(reEngageDate !== null ? { Date_to_Re_engage__c: reEngageDate } : {}),
        ...(competitor !== null ? { Competitor__c: competitor } : {}),
        ...(competitorEndDate !== null ? { End_of_competitor_engagement__c: competitorEndDate } : {}),
      })

      // Build confirmation summary
      const updatedLines: string[] = []
      if (status) updatedLines.push(`• *Status* → ${status}`)
      if (status === 'Paused' && pauseReason) updatedLines.push(`• *Hold reason* → ${pauseReason}`)
      if (reEngageDate) updatedLines.push(`• *Date to re-engage* → ${reEngageDate}`)
      if (competitor) updatedLines.push(`• *Incumbent vendor* → ${competitor}`)
      if (competitorEndDate) updatedLines.push(`• *Vendor contract end* → ${competitorEndDate}`)

      await client.chat.postMessage({
        channel: slackUserId,
        text: `✅ *${accountName}* updated in Salesforce`,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `✅ *${accountName}* updated in Salesforce:\n${updatedLines.join('\n')}` },
          },
        ],
      })

      // Update original nudge message to reflect it's been actioned
      if (channel && messageTs) {
        try {
          const updatedBySlackUser = await client.users.info({ user: slackUserId })
          const updatedByName = (updatedBySlackUser.user as { real_name?: string })?.real_name ?? 'BDR'
          const updatedAt = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

          // Fetch the original message blocks and append an "Updated" context block
          const history = await client.conversations.history({
            channel,
            latest: messageTs,
            inclusive: true,
            limit: 1,
          })
          const originalMsg = history.messages?.[0]
          if (originalMsg?.blocks) {
            // Replace the actions block with a "done" context block
            const updatedBlocks = (originalMsg.blocks as KnownBlock[]).map((b) =>
              b.type === 'actions'
                ? {
                    type: 'context' as const,
                    elements: [{ type: 'mrkdwn' as const, text: `✅ Updated by *${updatedByName}* · ${updatedAt}` }],
                  }
                : b
            )
            await client.chat.update({
              channel,
              ts: messageTs,
              blocks: updatedBlocks,
              text: `Updated by ${updatedByName}`,
            })
          }
        } catch {
          // Non-fatal — message update failed but SFDC write succeeded
        }
      }
    } catch (err) {
      await client.chat.postMessage({
        channel: slackUserId,
        text: `❌ Failed to update Salesforce: ${(err as Error).message}`,
      })
    }
  })

  // ── Log Activity (for stalled) ─────────────────────────────────────────────

  app.action('log_activity', async ({ ack, body, client }) => {
    await ack()
    const action = (body as BlockAction).actions[0] as { value: string }
    const { oppId, oppName } = JSON.parse(action.value)

    const { connected } = await requireSfdcUser(body.user.id, client as App['client'])
    if (!connected) {
      const token = jwt.sign({ slackUserId: body.user.id, redirect: 'activity', oppId }, config.JWT_SECRET, { expiresIn: '1h' })
      await client.views.open({
        trigger_id: (body as BlockAction).trigger_id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Connect Salesforce' },
          blocks: [{
            type: 'section',
            text: { type: 'mrkdwn', text: `To log activity in Salesforce, please <${config.APP_URL}/auth/sfdc/start?state=${token}|connect your Salesforce account> — this only takes a minute and is a one-time step.` },
          }],
        },
      })
      return
    }

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
      const { getConnectionForUser } = await import('../services/salesforce')
      const conn = await getConnectionForUser(user.id)
      await conn.sobject('Task').create({
        WhatId: oppId,
        Subject: `${activityType} - Beacon`,
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
