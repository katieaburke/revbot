import { Router } from 'express'
import { requireAdmin } from '../middleware/adminAuth'
import {
  fetchReassignAccounts,
  buildPreview,
  sendReassignmentMessages,
  type ReassignmentPreview,
} from '../services/reassignment'
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

export default router
