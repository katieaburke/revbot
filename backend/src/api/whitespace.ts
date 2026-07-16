import { Router } from 'express'
import axios from 'axios'
import { requireAdmin } from '../middleware/adminAuth'
import { getServiceConnection } from '../services/salesforce'
import { generateRepToken } from '../lib/repToken'
import { config } from '../config'
import { sendDm } from '../slack/bot'
import { db } from '../db'

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
        Account__r.Owner.Email,
        Account__r.Owner.Name,
        Current_Status__c,
        Fit_Use_Case__c,
        Current_Locations_Covered__c,
        Total_Locations_Fit__c,
        Expansion_Potential__c,
        ARR_Potential__c,
        Priority__c
      FROM Product_Coverage__c
      WHERE Current_Status__c = 'Has'
        AND (Total_Locations_Fit__c = null OR Total_Locations_Fit__c = 0)
        AND Account__r.RecordType.Name = 'Enterprise Account Record'
        AND Price_per_location__c > 0
        AND (NOT Product_Coverage_Name__c LIKE '%pull api%')
        AND (NOT Product_Coverage_Name__c LIKE '%services%')
        AND (NOT Product_Coverage_Name__c LIKE '%minimum commit%')
        AND (NOT Product_Coverage_Name__c LIKE '%package%')
        AND (NOT Product_Coverage_Name__c LIKE '%standalone%')
        AND (NOT Product_Coverage_Name__c LIKE '%fee%')
        AND (NOT Product_Coverage_Name__c LIKE '%bundle%')
        AND (NOT Product_Coverage_Name__c LIKE '%additional%')
      ORDER BY Account__r.Name ASC
    `.trim()

    const url = `${conn.instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`
    const resp = await axios.get<{
      records: {
        Id: string
        Name: string
        Product_Coverage_Name__c: string | null
        Account__c: string
        Account__r: { Name: string; Owner: { Email: string | null; Name: string | null } } | null
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
    const accountMap = new Map<string, {
      accountId: string
      accountName: string
      ownerEmail: string | null
      ownerName: string | null
      records: unknown[]
    }>()

    for (const r of resp.data.records) {
      const accountId = r.Account__c
      const accountName = r.Account__r?.Name ?? accountId
      const ownerEmail = r.Account__r?.Owner?.Email ?? null
      const ownerName = r.Account__r?.Owner?.Name ?? null

      if (!accountMap.has(accountId)) {
        accountMap.set(accountId, { accountId, accountName, ownerEmail, ownerName, records: [] })
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

    const accountsRaw = Array.from(accountMap.values()).sort((a, b) =>
      a.accountName.localeCompare(b.accountName)
    )

    // Look up slackUserId for each unique owner email
    const uniqueOwnerEmails = [...new Set(accountsRaw.map((a) => a.ownerEmail).filter(Boolean))] as string[]
    const ownerSlackMap = new Map<string, string | null>()
    await Promise.all(
      uniqueOwnerEmails.map(async (email) => {
        const user = await db.user.findFirst({
          where: { slackEmail: { equals: email, mode: 'insensitive' } },
        })
        ownerSlackMap.set(email.toLowerCase(), user?.slackUserId ?? null)
      })
    )

    const accounts = accountsRaw.map((a) => ({
      ...a,
      ownerSlackUserId: a.ownerEmail ? (ownerSlackMap.get(a.ownerEmail.toLowerCase()) ?? null) : null,
    }))

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

// POST /api/whitespace/send-prompt
router.post('/send-prompt', requireAdmin, async (req, res) => {
  const { repSlackUserId, repEmail, repName, accountCount, lineCount } = req.body as {
    repSlackUserId?: string
    repEmail?: string
    repName?: string
    accountCount?: number
    lineCount?: number
  }

  if (!repSlackUserId || !repEmail || !repName || accountCount === undefined || lineCount === undefined) {
    return res.status(400).json({ error: 'Missing required fields' })
  }

  try {
    const token = generateRepToken(repSlackUserId)
    const baseUrl = config.FRONTEND_URL ?? config.APP_URL
    const portalUrl = `${baseUrl}/my-flags?token=${token}`

    const lineWord = lineCount === 1 ? 'line' : 'lines'
    const accountWord = accountCount === 1 ? 'account' : 'accounts'

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '📊 Quick data request — expansion potential', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Hey ${repName}! We're building out whitespace data across your book and need your help filling in a few gaps.\n\nYou have *${lineCount} product coverage ${lineWord}* across *${accountCount} ${accountWord}* where we're missing the total location fit count.`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Can you take 5 mins to fill these in?* It helps us calculate expansion potential and ARR opportunity across your accounts.`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Fill in my accounts →', emoji: true },
            url: portalUrl,
            action_id: 'open_whitespace_prompt',
            style: 'primary',
          },
        ],
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `📋 <${portalUrl}|Open in your RevBot portal>` },
        ],
      },
    ]

    await sendDm(repSlackUserId, blocks as never, 'Quick data request — expansion potential')

    res.json({ ok: true })
  } catch (err) {
    console.error('[Whitespace] /send-prompt error:', err)
    res.status(500).json({ error: 'Failed to send Slack message' })
  }
})

export default router
