import { Queue, Worker } from 'bullmq'
import { redis } from '../redis'
import { runAlertJob, runDryRun } from './alertOrchestrator'
import { runReassignmentJob } from '../services/reassignment'
import { config } from '../config'

const QUEUE_NAME = 'alert-jobs'

export const alertQueue = new Queue(QUEUE_NAME, {
  connection: redis as any,
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
      if (job.name === 'run-dry-run') {
        return runDryRun({ bustGongCache: job.data?.bustGongCache === true })
      }
      if (job.name === 'run-reassignment') {
        return runReassignmentJob(config.APP_URL)
      }
    },
    { connection: redis as any, concurrency: 1 }
  )

  worker.on('completed', (job, result) => {
    console.log(`[Worker] Job ${job.id} completed:`, result)
  })

  worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed:`, err.message)
  })

  worker.on('error', (err) => {
    // Prevent unhandled worker errors (e.g. BullMQ repeatable job issues) from crashing the process
    console.error('[Worker] Error (non-fatal):', err.message)
  })

  return worker
}

const DEFAULT_CRON = '0 8 * * 1-5' // Mon–Fri 8am

// Schedule the recurring alert check based on DB config
export async function scheduleAlertJob(cronExpression?: string | null) {
  const cron = cronExpression?.trim() || DEFAULT_CRON

  // Remove existing repeatable jobs first
  const repeatableJobs = await alertQueue.getRepeatableJobs()
  for (const job of repeatableJobs) {
    if (job.name === 'run-alerts') {
      await alertQueue.removeRepeatableByKey(job.key)
    }
  }

  await alertQueue.add('run-alerts', {}, { repeat: { pattern: cron } })
  console.log(`[Scheduler] Alert job scheduled: ${cron}`)
}

// Trigger an immediate one-off run (e.g. from admin UI) — always busts Gong cache
export async function triggerAlertJobNow() {
  const job = await alertQueue.add('run-alerts', { triggeredAt: new Date().toISOString(), bustGongCache: true })
  console.log(`[Scheduler] Manual alert job triggered: ${job.id}`)
  return job.id
}

// Queue a dry-run via BullMQ so it runs in the worker, not in the HTTP request context.
// Race against a 5s timeout — if Redis is slow/unavailable, fall back to direct background run.
export async function triggerDryRunJob(bustGongCache = false): Promise<string | null> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('queue-timeout')), 5_000)
  )
  try {
    const job = await Promise.race([
      alertQueue.add(
        'run-dry-run',
        { triggeredAt: new Date().toISOString(), bustGongCache },
        { removeOnComplete: 5, removeOnFail: 5, attempts: 1 },
      ),
      timeout,
    ])
    console.log(`[Scheduler] Dry-run job queued: ${job.id}`)
    return job.id ?? null
  } catch (err) {
    // Redis unavailable or timed out — run directly in background so the HTTP response
    // is already sent before work starts. This is the same isolation as a job.
    console.warn('[Scheduler] BullMQ unavailable, running dry-run in background:', (err as Error).message)
    runDryRun({ bustGongCache }).catch((e) => console.error('[DryRun] Background run failed:', e))
    return null
  }
}

// ── Territory reassignment ──────────────────────────────────────────────────

const REASSIGNMENT_CRON = '0 7 * * 1-5' // Mon–Fri 7am

export async function scheduleReassignmentJob() {
  // Remove any existing reassignment repeatable jobs
  const repeatableJobs = await alertQueue.getRepeatableJobs()
  for (const job of repeatableJobs) {
    if (job.name === 'run-reassignment') {
      await alertQueue.removeRepeatableByKey(job.key)
    }
  }
  await alertQueue.add('run-reassignment', {}, { repeat: { pattern: REASSIGNMENT_CRON } })
  console.log(`[Scheduler] Reassignment job scheduled: ${REASSIGNMENT_CRON}`)
}

export async function triggerReassignmentJobNow() {
  const job = await alertQueue.add('run-reassignment', { triggeredAt: new Date().toISOString() })
  console.log(`[Scheduler] Manual reassignment job triggered: ${job.id}`)
  return job.id
}
