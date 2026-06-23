import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import { config } from './config'
import { db } from './db'
import { initSlack } from './slack/bot'
import { startWorker, scheduleAlertJob } from './jobs/scheduler'
import authRouter from './api/auth'
import configRouter from './api/config'
import notificationsRouter from './api/notifications'
import extensionRouter from './api/extension'

async function main() {
  // Init Slack (optional — skipped if tokens not set)
  const slackApp = initSlack()

  // Start BullMQ worker
  startWorker()

  // Schedule default alert job (Mon-Fri 8am, overridden by DB setting)
  try {
    const cronSetting = await db.appSetting.findUnique({ where: { key: 'alertCron' } })
    const cron = cronSetting ? JSON.parse(cronSetting.value) : '0 8 * * 1-5'
    await scheduleAlertJob(cron)
  } catch (err) {
    console.warn('⚠️  Could not schedule alert job (DB not ready?):', (err as Error).message)
  }

  // Express app
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

  app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }))

  app.listen(config.PORT, () => {
    console.log(`🚀 Beacon running on port ${config.PORT}`)
    console.log(`   Admin UI: http://localhost:5173`)
  })

  // Start Slack socket mode if in dev and configured
  if (slackApp && config.NODE_ENV === 'development' && config.SLACK_APP_TOKEN) {
    await slackApp.start()
    console.log('⚡ Slack socket mode connected')
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
