import { Router } from 'express'
import { requireAdmin } from '../middleware/adminAuth'
import { fetchProspectAccounts } from '../services/salesforce'
import { buildAccountActivityIndex } from '../services/gong'
import { evaluateProspectingHygiene } from '../alerts/prospecting'
import { db } from '../db'

const router = Router()
router.use(requireAdmin)

// GET /api/accounts/prospecting-hygiene
// Returns all prospect accounts with their flags
router.get('/prospecting-hygiene', async (_req, res) => {
  try {
    const settings = await db.appSetting.findMany({
      where: { key: { in: ['accountRecordTypeFilter', 'prospectingStaleThresholdDays', 'prospectingRecentActivityDays'] } },
    })
    const settingMap = Object.fromEntries(settings.map((s) => [s.key, JSON.parse(s.value)]))
    const recordTypeFilter = (settingMap.accountRecordTypeFilter as string) ?? 'Enterprise'
    const staleThresholdDays = Number(settingMap.prospectingStaleThresholdDays ?? 14)
    const recentActivityDays = Number(settingMap.prospectingRecentActivityDays ?? 14)

    const accounts = await fetchProspectAccounts(recordTypeFilter)
    const accountIds = accounts.map((a) => a.Id)
    const gongActivity = await buildAccountActivityIndex(accountIds)

    const flags = evaluateProspectingHygiene(accounts, gongActivity, { staleThresholdDays, recentActivityDays })

    res.json({
      scannedAt: new Date().toISOString(),
      totalAccounts: accounts.length,
      flags,
      config: { recordTypeFilter, staleThresholdDays, recentActivityDays },
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

export default router
