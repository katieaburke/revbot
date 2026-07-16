import { Router } from 'express'
import axios from 'axios'
import { requireAdmin } from '../middleware/adminAuth'
import { getServiceConnection } from '../services/salesforce'

const router = Router()

// GET /api/whitespace/expansion-potential
router.get('/expansion-potential', requireAdmin, async (_req, res) => {
  try {
    const conn = await getServiceConnection()

    const soql = `
      SELECT
        Id,
        Name,
        Product_Coverage_Name__c,
        Account__c,
        Account__r.Name,
        Current_Status__c,
        Fit_Use_Case__c,
        Current_Locations_Covered__c,
        Total_Locations_Fit__c,
        Expansion_Potential__c,
        ARR_Potential__c,
        Priority__c
      FROM Product_Coverage__c
      WHERE Total_Locations_Fit__c = null
        AND Fit_Use_Case__c IN ('Strong Fit', 'Possible Fit')
        AND Current_Status__c != 'Not Relevant'
      ORDER BY Account__r.Name ASC
    `.trim()

    const url = `${conn.instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`
    const resp = await axios.get<{
      records: {
        Id: string
        Name: string
        Product_Coverage_Name__c: string | null
        Account__c: string
        Account__r: { Name: string } | null
        Current_Status__c: string | null
        Fit_Use_Case__c: string | null
        Current_Locations_Covered__c: number | null
        Total_Locations_Fit__c: number | null
        Expansion_Potential__c: number | null
        ARR_Potential__c: number | null
        Priority__c: string | null
      }[]
    }>(url, {
      headers: { Authorization: `Bearer ${conn.accessToken!}` },
      timeout: 20_000,
    })

    // Group by account, sorted alphabetically (ORDER BY already covers it)
    const accountMap = new Map<string, { accountId: string; accountName: string; records: unknown[] }>()

    for (const r of resp.data.records) {
      const accountId = r.Account__c
      const accountName = r.Account__r?.Name ?? accountId

      if (!accountMap.has(accountId)) {
        accountMap.set(accountId, { accountId, accountName, records: [] })
      }

      accountMap.get(accountId)!.records.push({
        id: r.Id,
        name: r.Name,
        productCoverageName: r.Product_Coverage_Name__c,
        accountId,
        accountName,
        currentStatus: r.Current_Status__c,
        fitUseCase: r.Fit_Use_Case__c,
        currentLocationsCovered: r.Current_Locations_Covered__c,
        totalLocationsFit: r.Total_Locations_Fit__c,
        expansionPotential: r.Expansion_Potential__c,
        arrPotential: r.ARR_Potential__c,
        priority: r.Priority__c,
      })
    }

    const accounts = Array.from(accountMap.values()).sort((a, b) =>
      a.accountName.localeCompare(b.accountName)
    )

    res.json({ accounts })
  } catch (err) {
    console.error('[Whitespace] /expansion-potential error:', err)
    res.status(500).json({ error: 'Failed to load expansion potential data from Salesforce' })
  }
})

// PATCH /api/whitespace/product-coverage/:id
router.patch('/product-coverage/:id', requireAdmin, async (req, res) => {
  const { id } = req.params
  const { totalLocationsFit } = req.body as { totalLocationsFit?: number }

  if (totalLocationsFit === undefined || totalLocationsFit === null) {
    return res.status(400).json({ error: 'totalLocationsFit is required' })
  }

  try {
    const conn = await getServiceConnection()

    await axios.patch(
      `${conn.instanceUrl}/services/data/v59.0/sobjects/Product_Coverage__c/${id}`,
      { Total_Locations_Fit__c: totalLocationsFit },
      {
        headers: {
          Authorization: `Bearer ${conn.accessToken!}`,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      }
    )

    res.json({ ok: true })
  } catch (err) {
    console.error('[Whitespace] PATCH product-coverage error:', err)
    res.status(500).json({ error: 'Failed to update Product Coverage record in Salesforce' })
  }
})

export default router
