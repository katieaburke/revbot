import { Router } from 'express'
import { requireAdmin } from '../middleware/adminAuth'
import {
  fetchReassignAccounts,
  buildPreview,
  sendReassignmentMessages,
  LEADERS,
  ANA,
  SPANISH_SPEAKING_OWNERS,
  NORTHERN_EUROPE_OWNERS,
  LATAM_COUNTRIES,
  type ReassignmentPreview,
  type RoutingOverrides,
} from '../services/reassignment'
import {
  fetchChurnedAccounts,
  fetchSalesReps,
  updateAccountOwner,
  notifyNewOwner,
} from '../services/churnedReassignment'
import { getServiceConnection } from '../services/salesforce'
import { config } from '../config'
import { db } from '../db'

const router = Router()
router.use(requireAdmin)

// ── Routing config helpers ────────────────────────────────────────────────────

async function loadRoutingOverrides(): Promise<RoutingOverrides> {
  const rows = await db.appSetting.findMany({
    where: { key: { in: ['territoryRules:spanishOwners', 'territoryRules:northernEuropeOwners'] } },
  })
  const overrides: RoutingOverrides = {}
  for (const row of rows) {
    if (row.key === 'territoryRules:spanishOwners') overrides.spanishSpeakingOwners = JSON.parse(row.value)
    if (row.key === 'territoryRules:northernEuropeOwners') overrides.northernEuropeOwners = JSON.parse(row.value)
  }
  return overrides
}

// GET /api/territory/routing-config
router.get('/routing-config', async (_req, res) => {
  try {
    const overrides = await loadRoutingOverrides()
    res.json({
      leaders: LEADERS,
      ana: ANA,
      spanishSpeakingOwners: overrides.spanishSpeakingOwners ?? [...SPANISH_SPEAKING_OWNERS],
      northernEuropeOwners: overrides.northernEuropeOwners ?? [...NORTHERN_EUROPE_OWNERS],
      latamCountries: [...LATAM_COUNTRIES],
      rules: [
        { id: 1, description: 'Named Spanish-speaking reps', route: 'Samy Benmeziane', suggestAna: true, condition: 'Owner name is in the Spanish-speaking reps list' },
        { id: 2, description: 'US-CAN rep + LATAM billing country', route: 'Samy Benmeziane', suggestAna: true, condition: 'Role includes "US-CAN New Business" AND billing country is in LATAM list' },
        { id: 3, description: 'US-CAN New Business rep', route: 'Allison Townsend', suggestAna: false, condition: 'Role includes "US-CAN" and "New Business"' },
        { id: 4, description: 'Northern Europe named reps', route: 'Jo Billington', suggestAna: false, condition: 'Owner name is in the Northern Europe reps list' },
        { id: 5, description: 'Enrico Pisoni', route: 'Karolina Vetter', suggestAna: false, condition: 'Owner name is exactly "Enrico Pisoni"' },
        { id: 6, description: 'EMEA New Business rep', route: 'Samy Benmeziane', suggestAna: false, condition: 'Role includes "EMEA" and "New Business"' },
        { id: 7, description: 'Inactive owner (# in name)', route: 'Allison Townsend (US/CAN) or Samy Benmeziane (rest)', suggestAna: false, condition: 'Owner or secondary owner name contains "#" — routes by billing country' },
      ],
    })
  } catch (err) {
    console.error('[Territory] Routing config error:', err)
    res.status(500).json({ error: (err as Error).message })
  }
})

// PUT /api/territory/routing-config
router.put('/routing-config', async (req, res) => {
  const { spanishSpeakingOwners, northernEuropeOwners } = req.body ?? {}
  try {
    if (Array.isArray(spanishSpeakingOwners)) {
      await db.appSetting.upsert({
        where: { key: 'territoryRules:spanishOwners' },
        create: { key: 'territoryRules:spanishOwners', value: JSON.stringify(spanishSpeakingOwners) },
        update: { value: JSON.stringify(spanishSpeakingOwners) },
      })
    }
    if (Array.isArray(northernEuropeOwners)) {
      await db.appSetting.upsert({
        where: { key: 'territoryRules:northernEuropeOwners' },
        create: { key: 'territoryRules:northernEuropeOwners', value: JSON.stringify(northernEuropeOwners) },
        update: { value: JSON.stringify(northernEuropeOwners) },
      })
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('[Territory] Routing config update error:', err)
    res.status(500).json({ error: (err as Error).message })
  }
})

// GET /api/territory/reassignment/preview
router.get('/reassignment/preview', async (_req, res) => {
  try {
    const [accounts, overrides] = await Promise.all([fetchReassignAccounts(), loadRoutingOverrides()])
    const preview = buildPreview(accounts, overrides)
    res.json(preview)
  } catch (err) {
    console.error('[Territory] Preview error:', err)
    res.status(500).json({ error: (err as Error).message })
  }
})

// POST /api/territory/reassignment/send
router.post('/reassignment/send', async (req, res) => {
  try {
    // Accept an explicit preview payload (so UI can send what it previewed)
    // or re-fetch live data if none supplied
    let preview: ReassignmentPreview
    if (req.body?.preview) {
      preview = req.body.preview as ReassignmentPreview
    } else {
      const [accounts, overrides] = await Promise.all([fetchReassignAccounts(), loadRoutingOverrides()])
      preview = buildPreview(accounts, overrides)
    }

    const appUrl = config.APP_URL ?? 'https://beacon.uberall.com'
    const result = await sendReassignmentMessages(preview, appUrl)
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[Territory] Send error:', err)
    res.status(500).json({ error: (err as Error).message })
  }
})

// ── Churned reassignment ────────────────────────────────────────────────────────

// GET /api/territory/churned/accounts
// Returns churned accounts (contract ended >6m ago, still owned by AM) + available sales reps
router.get('/churned/accounts', async (_req, res) => {
  try {
    const [accounts, reps] = await Promise.all([fetchChurnedAccounts(), fetchSalesReps()])
    res.json({ accounts, reps })
  } catch (err) {
    console.error('[Territory/Churned] Fetch error:', err)
    res.status(500).json({ error: (err as Error).message })
  }
})

// POST /api/territory/churned/reassign
// Body: { accountId, newOwnerId, newOwnerName, newOwnerEmail, account: ChurnedAccount }
// Updates OwnerId in SFDC, sends Slack DM to new owner
router.post('/churned/reassign', async (req, res) => {
  const { accountId, newOwnerId, newOwnerName, newOwnerEmail, account } = req.body ?? {}
  if (!accountId || !newOwnerId || !newOwnerName || !newOwnerEmail) {
    res.status(400).json({ error: 'accountId, newOwnerId, newOwnerName, newOwnerEmail are required' })
    return
  }

  try {
    // 1. Update owner in SFDC
    await updateAccountOwner(accountId, newOwnerId)

    // 2. Send Slack DM to new owner
    const conn = await getServiceConnection()
    await notifyNewOwner(account, newOwnerName, newOwnerEmail, conn.instanceUrl)

    res.json({ ok: true })
  } catch (err) {
    console.error('[Territory/Churned] Reassign error:', err)
    res.status(500).json({ error: (err as Error).message })
  }
})

export default router
