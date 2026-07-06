import { Router } from 'express'
import { requireAdmin } from '../middleware/adminAuth'
import {
  fetchReassignAccounts,
  buildPreview,
  sendReassignmentMessages,
  type ReassignmentPreview,
} from '../services/reassignment'
import {
  fetchChurnedAccounts,
  fetchSalesReps,
  updateAccountOwner,
  notifyNewOwner,
} from '../services/churnedReassignment'
import { getServiceConnection } from '../services/salesforce'
import { config } from '../config'

const router = Router()
router.use(requireAdmin)

// GET /api/territory/reassignment/preview
router.get('/reassignment/preview', async (_req, res) => {
  try {
    const accounts = await fetchReassignAccounts()
    const preview = buildPreview(accounts)
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
      const accounts = await fetchReassignAccounts()
      preview = buildPreview(accounts)
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
