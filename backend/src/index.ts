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

async function main() {
  // Init Slack
  const slackApp = initSlack()

  // Start BullMQ worker
  startWorker()

  // Schedule default alert job (Mon-Fri 8am, overridden by DB setting)
  const cronSetting = await db.appSetting.findUnique({ where: { key: 'alertCron' } })
  const cron = cronSetting ? JSON.parse(cronSetting.value) : '0 8 * * 1-5'
  await scheduleAlertJob(cron)

  // Express app
  const app = express()
  app.use(helmet())
  app.use(cors({ origin: config.NODE_ENV === 'development' ? '*' : process.env.FRONTEND_URL }))
  app.use(express.json())

  // Mount Slack Bolt as middleware (handles /slack/events and /slack/actions)
  const slackReceiver = (slackApp as unknown as { receiver: { router: express.Router } }).receiver
  if (slackReceiver?.router) {
    app.use('/slack', slackReceiver.router)
  }

  // API routes
  app.use('/auth', authRouter)
  app.use('/api/config', configRouter)
  app.use('/api/notifications', notificationsRouter)

  app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }))

  app.listen(config.PORT, () => {
    console.log(`🚀 Pipeline Nudge running on port ${config.PORT}`)
    console.log(`   Admin UI: http://localhost:5173`)
  })

  // Start Slack socket mode if in dev
  if (config.NODE_ENV === 'development' && config.SLACK_APP_TOKEN) {
    await slackApp.start()
    console.log('⚡ Slack socket mode connected')
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
