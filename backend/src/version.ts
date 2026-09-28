import { execSync } from 'child_process'

/**
 * Build identity for the running process.
 *
 * This exists because `/health` only ever said `{ ok: true }`, and "is my fix actually
 * deployed?" had no answer short of grepping the served JS bundle for a string only
 * present in the new code. That cost real time during an incident — twice the symptom
 * looked like the fix hadn't worked when the truth was a stale browser tab.
 *
 * Railway injects RAILWAY_GIT_COMMIT_SHA at build time; Vercel uses
 * VERCEL_GIT_COMMIT_SHA. Locally neither exists, so fall back to asking git directly.
 * Resolved once at module load — the answer cannot change while the process lives, and
 * shelling out per request to a health endpoint would be daft.
 */
function resolveCommit(): string {
  const fromEnv =
    process.env.RAILWAY_GIT_COMMIT_SHA ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GIT_COMMIT_SHA ??
    process.env.SOURCE_VERSION // Heroku
  if (fromEnv) return fromEnv

  try {
    // Only reachable in local dev; production images generally ship without a .git dir,
    // which is why the env vars are tried first rather than as a fallback.
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'unknown'
  }
}

const commit = resolveCommit()

export const versionInfo = {
  commit,
  commitShort: commit === 'unknown' ? 'unknown' : commit.slice(0, 7),
  branch: process.env.RAILWAY_GIT_BRANCH ?? process.env.VERCEL_GIT_COMMIT_REF ?? null,
  // Process start, not build time. Distinguishes "the deploy didn't land" from "it
  // landed and then the process restarted", which look identical from the outside.
  startedAt: new Date().toISOString(),
  nodeEnv: process.env.NODE_ENV ?? 'development',
}

export function uptimeSeconds(): number {
  return Math.round(process.uptime())
}
