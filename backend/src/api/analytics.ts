import { Router } from 'express'
import { requireAdmin } from '../middleware/adminAuth'
import { db } from '../db'
import type { AlertType } from '../types'

// Prisma client is not regenerated locally — FlagSnapshot is only known at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const flagSnapshotDb = (db as any)

interface FlagSnapshotRow {
  id: string
  runAt: Date
  opportunityId: string
  alertType: AlertType
  ownerEmail: string
  ownerName: string | null
  managerEmail: string | null
  managerName: string | null
}

const router = Router()

router.get('/flags-over-time', requireAdmin, async (req, res) => {
  try {
    const days = parseInt((req.query.days as string) ?? '30', 10) || 30
    const ownerEmail = (req.query.ownerEmail as string) || undefined
    const managerEmail = (req.query.managerEmail as string) || undefined

    const since = new Date()
    since.setDate(since.getDate() - days)
    since.setHours(0, 0, 0, 0)

    // Fetch snapshots with optional owner/manager filter
    const snapshots: FlagSnapshotRow[] = await flagSnapshotDb.flagSnapshot.findMany({
      where: {
        runAt: { gte: since },
        ...(ownerEmail ? { ownerEmail } : {}),
        ...(managerEmail ? { managerEmail } : {}),
      },
      orderBy: { runAt: 'asc' },
    })

    // Fetch all snapshots in range (no filter) for dropdown population
    const allSnapshots: Array<{ ownerEmail: string; ownerName: string | null; managerEmail: string | null; managerName: string | null }> = await flagSnapshotDb.flagSnapshot.findMany({
      where: { runAt: { gte: since } },
      select: { ownerEmail: true, ownerName: true, managerEmail: true, managerName: true },
    })

    // Build dropdowns from unfiltered snapshots
    const ownerMap = new Map<string, string | null>()
    const managerMap = new Map<string, string | null>()
    for (const s of allSnapshots) {
      if (!ownerMap.has(s.ownerEmail)) ownerMap.set(s.ownerEmail, s.ownerName)
      if (s.managerEmail && !managerMap.has(s.managerEmail)) {
        managerMap.set(s.managerEmail, s.managerName)
      }
    }

    const owners = Array.from(ownerMap.entries())
      .map(([email, name]) => ({ email, name }))
      .sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email))

    const managers = Array.from(managerMap.entries())
      .map(([email, name]) => ({ email, name }))
      .sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email))

    // Group snapshots by calendar day, find latest runAt per day
    const dayToMaxRunAt = new Map<string, Date>()
    for (const s of snapshots) {
      const day = s.runAt.toISOString().split('T')[0]
      const current = dayToMaxRunAt.get(day)
      if (!current || s.runAt > current) {
        dayToMaxRunAt.set(day, s.runAt)
      }
    }

    // Filter to only snapshots from the latest run per day
    const latestRunAtMs = new Map<string, number>()
    for (const [day, date] of dayToMaxRunAt.entries()) {
      latestRunAtMs.set(day, date.getTime())
    }

    const filteredSnapshots = snapshots.filter((s) => {
      const day = s.runAt.toISOString().split('T')[0]
      return s.runAt.getTime() === latestRunAtMs.get(day)
    })

    // Build chart data per day
    type DayEntry = {
      date: string
      total: number
      STALLED: number
      PAST_DUE_INITIAL: number
      PAST_DUE_AMENDMENT: number
      PAST_DUE_RENEWAL: number
      MEDDPICC_MISSING: number
      NEXT_STEP_MISSING: number
      CLOSE_DATE_RISK: number
      STAGE_MISMATCH: number
    }

    const dayMap = new Map<string, { oppIds: Set<string>; counts: Record<string, number> }>()

    for (const s of filteredSnapshots) {
      const day = s.runAt.toISOString().split('T')[0]
      if (!dayMap.has(day)) {
        dayMap.set(day, { oppIds: new Set(), counts: {} })
      }
      const entry = dayMap.get(day)!
      entry.oppIds.add(s.opportunityId)
      entry.counts[s.alertType] = (entry.counts[s.alertType] ?? 0) + 1
    }

    const alertTypes = [
      'STALLED',
      'PAST_DUE_INITIAL',
      'PAST_DUE_AMENDMENT',
      'PAST_DUE_RENEWAL',
      'MEDDPICC_MISSING',
      'NEXT_STEP_MISSING',
      'CLOSE_DATE_RISK',
      'STAGE_MISMATCH',
    ]

    const chartData: DayEntry[] = Array.from(dayMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { oppIds, counts }]) => {
        const entry: DayEntry = {
          date,
          total: oppIds.size,
          STALLED: counts['STALLED'] ?? 0,
          PAST_DUE_INITIAL: counts['PAST_DUE_INITIAL'] ?? 0,
          PAST_DUE_AMENDMENT: counts['PAST_DUE_AMENDMENT'] ?? 0,
          PAST_DUE_RENEWAL: counts['PAST_DUE_RENEWAL'] ?? 0,
          MEDDPICC_MISSING: counts['MEDDPICC_MISSING'] ?? 0,
          NEXT_STEP_MISSING: counts['NEXT_STEP_MISSING'] ?? 0,
          CLOSE_DATE_RISK: counts['CLOSE_DATE_RISK'] ?? 0,
          STAGE_MISMATCH: counts['STAGE_MISMATCH'] ?? 0,
        }
        return entry
      })

    // ── Owner breakdown (per day, per owner name: total flag count) ───────────
    // Used for "stack by owner" view on the frontend
    const ownerDayMap = new Map<string, Map<string, number>>() // day → ownerLabel → flagCount
    const activeOwnerMap = new Map<string, string | null>()    // email → name (filtered data only)

    for (const s of filteredSnapshots) {
      const day = s.runAt.toISOString().split('T')[0]
      const label = s.ownerName ?? s.ownerEmail
      if (!ownerDayMap.has(day)) ownerDayMap.set(day, new Map())
      const dayOwners = ownerDayMap.get(day)!
      dayOwners.set(label, (dayOwners.get(label) ?? 0) + 1)
      if (!activeOwnerMap.has(s.ownerEmail)) activeOwnerMap.set(s.ownerEmail, s.ownerName)
    }

    // Collect all owner labels so every day point has the same keys
    const allOwnerLabels = Array.from(
      new Set(Array.from(ownerDayMap.values()).flatMap((m) => Array.from(m.keys())))
    ).sort()

    const ownerBreakdown: Array<Record<string, string | number>> = Array.from(ownerDayMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, counts]) => {
        const point: Record<string, string | number> = { date }
        for (const label of allOwnerLabels) {
          point[label] = counts.get(label) ?? 0
        }
        return point
      })

    // ── Active alert types (only those with ≥1 flag in filtered data) ─────────
    const alertTypeCounts: Record<string, number> = {}
    for (const s of filteredSnapshots) {
      alertTypeCounts[s.alertType] = (alertTypeCounts[s.alertType] ?? 0) + 1
    }
    const activeAlertTypes = alertTypes.filter((t) => (alertTypeCounts[t] ?? 0) > 0)

    const activeOwners = Array.from(activeOwnerMap.entries())
      .map(([email, name]) => ({ email, name, label: name ?? email }))
      .sort((a, b) => a.label.localeCompare(b.label))

    // Suppress unused variable warning
    void alertTypes

    res.json({ chartData, owners, managers, ownerBreakdown, activeAlertTypes, activeOwners })
  } catch (err) {
    console.error('[Analytics] flags-over-time error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
