import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import { config } from './config'
import { db } from './db'
import { initSlack } from './slack/bot'
import { startWorker, alertQueue, scheduleReassignmentJob } from './jobs/scheduler'
import authRouter from './api/auth'
import configRouter from './api/config'
import notificationsRouter from './api/notifications'
import extensionRouter from './api/extension'
import analyticsRouter from './api/analytics'
import accountsRouter from './api/accounts'
import territoryRouter from './api/territory'
import repPortalRouter from './api/repPortal'
import managerPortalRouter from './api/managerPortal'
import whitespaceRouter from './api/whitespace'
import handRaiseRouter from './api/handRaise'

async function main() {
  // Init Slack (optional — skipped if tokens not set)
  const slackApp = initSlack()

  // Start BullMQ worker
  startWorker()

  // Express app — start this FIRST so HTTP is available immediately.
  // Redis/BullMQ startup tasks run in the background so a slow/unavailable
  // Redis connection never delays the HTTP server coming online.
  const app = express()
  app.use(helmet())
  app.use(cors({ origin: '*' }))
  app.use(express.json())

  // Mount Slack Bolt middleware if configured
  if (slackApp) {
    const slackReceiver = (slackApp as unknown as { receiver: { router: express.Router } }).receiver
    if (slackReceiver?.router) app.use('/slack', slackReceiver.router)
  }

  // API routes
  app.use('/auth', authRouter)
  app.use('/api/config', configRouter)
  app.use('/api/notifications', notificationsRouter)
  app.use('/api/extension', extensionRouter)
  app.use('/api/analytics', analyticsRouter)
  app.use('/api/accounts', accountsRouter)
  app.use('/api/territory', territoryRouter)
  app.use('/api/rep', repPortalRouter)
  app.use('/api/manager', managerPortalRouter)
  app.use('/api/whitespace', whitespaceRouter)
  app.use('/api/hand-raise', handRaiseRouter)

  app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }))

  app.listen(config.PORT, () => {
    console.log(`🚀 Beacon running on port ${config.PORT}`)
    console.log(`   Admin UI: http://localhost:5173`)

    // Run Redis/BullMQ startup tasks in the background so they never block the
    // HTTP server from accepting requests. A slow or unavailable Redis won't
    // delay startup — these will retry or log a warning and move on.
    setImmediate(async () => {
      // Clear any previously scheduled repeatable alert jobs — alerts are now sent manually only
      try {
        const repeatableJobs = await alertQueue.getRepeatableJobs()
        for (const job of repeatableJobs) {
          if (job.name === 'run-alerts') {
            await alertQueue.removeRepeatableByKey(job.key)
            console.log(`[Scheduler] Removed repeatable job: ${job.key}`)
          }
        }
      } catch (err) {
        console.warn('⚠️  Could not clear scheduled jobs:', (err as Error).message)
      }

      // Schedule daily territory reassignment (Mon–Fri 7am)
      try {
        await scheduleReassignmentJob()
      } catch (err) {
        console.warn('⚠️  Could not schedule reassignment job:', (err as Error).message)
      }
    })
  })

  // Start Slack socket mode if in dev and configured
  if (slackApp && config.NODE_ENV === 'development' && config.SLACK_APP_TOKEN) {
    await slackApp.start()
    console.log('⚡ Slack socket mode connected')
  }
}

main().catch((err) => {
  console.error('Fatal error during startup:', err)
  process.exit(1)
})

// Prevent background job crashes / unhandled rejections from taking down the HTTP server.
// Log them so they're visible in platform logs, but keep the process alive.
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled promise rejection (non-fatal):', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception (non-fatal):', err)
})
