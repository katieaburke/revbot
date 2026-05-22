import { Queue, Worker } from 'bullmq'
import { redis } from '../redis'
import { runAlertJob } from './alertOrchestrator'

const QUEUE_NAME = 'alert-jobs'

export const alertQueue = new Queue(QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 50,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  },
})

export function startWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === 'run-alerts') {
        return runAlertJob({ bustGongCache: job.data?.bustGongCache === true })
      }
    },
    { connection: redis, concurrency: 1 }
  )

  worker.on('completed', (job, result) => {
    console.log(`[Worker] Job ${job.id} completed:`, result)
  })

  worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed:`, err.message)
  })

  return worker
}

// Schedule the recurring alert check based on DB config
// Default: daily at 8am — configurable via admin settings
export async function scheduleAlertJob(cronExpression = '0 8 * * 1-5') {
  // Remove existing repeatable jobs first
  const repeatableJobs = await alertQueue.getRepeatableJobs()
  for (const job of repeatableJobs) {
    if (job.name === 'run-alerts') {
      await alertQueue.removeRepeatableByKey(job.key)
    }
  }

  await alertQueue.add('run-alerts', {}, { repeat: { pattern: cronExpression } })
  console.log(`[Scheduler] Alert job scheduled: ${cronExpression}`)
}

// Trigger an immediate one-off run (e.g. from admin UI) — always busts Gong cache
export async function triggerAlertJobNow() {
  const job = await alertQueue.add('run-alerts', { triggeredAt: new Date().toISOString(), bustGongCache: true })
  console.log(`[Scheduler] Manual alert job triggered: ${job.id}`)
  return job.id
}
