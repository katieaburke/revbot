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
        Priority__c,
        Price_per_location__c
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
        Price_per_location__c: number | null
      }[]
    }>(url, {
      headers: { Authorization: `Bearer ${conn.accessToken!}` },
      timeout: 20_000,
    })

    console.log(`[Whitespace] SFDC returned ${resp.data.records.length} records`)

    // Collect unique owner emails for Slack lookup
    const uniqueOwnerEmails = [
      ...new Set(
        resp.data.records
          .map((r) => r.Account__r?.Owner?.Email ?? null)
          .filter((e): e is string => e !== null)
      ),
    ]
    const ownerSlackMap = new Map<string, string | null>()
    await Promise.all(
      uniqueOwnerEmails.map(async (email) => {
        const user = await db.user.findFirst({
          where: { slackEmail: { equals: email, mode: 'insensitive' } },
        })
        ownerSlackMap.set(email.toLowerCase(), user?.slackUserId ?? null)
      })
    )

    // Group by AM owner email, then by account within each AM
    type RecordShape = {
      id: string
      name: string
      productCoverageName: string | null
      accountId: string
      accountName: string
      currentStatus: string | null
      fitUseCase: string | null
      currentLocationsCovered: number | null
      totalLocationsFit: number | null
      arrPotential: number | null
      priority: string | null
      pricePerLocation: number | null
      currentArr: number
    }

    type AccountShape = {
      accountId: string
      accountName: string
      totalCurrentArr: number
      records: RecordShape[]
    }

    type AmShape = {
      ownerEmail: string | null
      ownerName: string | null
      ownerSlackUserId: string | null
      totalLines: number
      totalCurrentArr: number
      accounts: AccountShape[]
    }

    // ownerKey -> AM accumulator
    const amMap = new Map<string, AmShape & { accountMap: Map<string, AccountShape> }>()

    for (const r of resp.data.records) {
      const accountId = r.Account__c
      const accountName = r.Account__r?.Name ?? accountId
      const ownerEmail = r.Account__r?.Owner?.Email ?? null
      const ownerName = r.Account__r?.Owner?.Name ?? null
      const ownerSlackUserId = ownerEmail
        ? (ownerSlackMap.get(ownerEmail.toLowerCase()) ?? null)
        : null

      const ownerKey = ownerEmail?.toLowerCase() ?? `__no_owner__${ownerName ?? accountId}`

      const pricePerLocation = r.Price_per_location__c ?? 0
      const currentLocationsCovered = r.Current_Locations_Covered__c ?? 0
      const currentArr = currentLocationsCovered * pricePerLocation * 12

      const record: RecordShape = {
        id: r.Id,
        name: r.Name,
        productCoverageName: r.Product_Coverage_Name__c,
        accountId,
        accountName,
        currentStatus: r.Current_Status__c,
        fitUseCase: r.Fit_Use_Case__c,
        currentLocationsCovered: r.Current_Locations_Covered__c,
        totalLocationsFit: r.Total_Locations_Fit__c,
        arrPotential: r.ARR_Potential__c,
        priority: r.Priority__c,
        pricePerLocation: r.Price_per_location__c,
        currentArr,
      }

      if (!amMap.has(ownerKey)) {
        amMap.set(ownerKey, {
          ownerEmail,
          ownerName,
          ownerSlackUserId,
          totalLines: 0,
          totalCurrentArr: 0,
          accounts: [],
          accountMap: new Map(),
        })
      }

      const am = amMap.get(ownerKey)!
      am.totalLines += 1
      am.totalCurrentArr += currentArr

      if (!am.accountMap.has(accountId)) {
        const acct: AccountShape = { accountId, accountName, totalCurrentArr: 0, records: [] }
        am.accountMap.set(accountId, acct)
        am.accounts.push(acct)
      }

      const acct = am.accountMap.get(accountId)!
      acct.totalCurrentArr += currentArr
      acct.records.push(record)
    }

    // Build final response: sort AMs alphabetically by ownerName
    const ams: AmShape[] = Array.from(amMap.values())
      .map((am) => {
        // Sort accounts by totalCurrentArr descending
        am.accounts.sort((a, b) => b.totalCurrentArr - a.totalCurrentArr)
        // Sort records within each account by currentArr descending
        for (const acct of am.accounts) {
          acct.records.sort((a, b) => b.currentArr - a.currentArr)
        }
        const { accountMap: _accountMap, ...rest } = am
        return rest
      })
      .sort((a, b) => {
        const nameA = a.ownerName ?? ''
        const nameB = b.ownerName ?? ''
        return nameA.localeCompare(nameB)
      })

    console.log(`[Whitespace] Returning ${ams.length} AMs`)
    res.json({ ams })
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
  const { repSlackUserId, repEmail, repName, accountCount, lineCount, currentArr } = req.body as {
    repSlackUserId?: string
    repEmail?: string
    repName?: string
    accountCount?: number
    lineCount?: number
    currentArr?: number
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

    const fmtEur = (val: number) =>
      new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(val)

    const arrText =
      currentArr != null && currentArr > 0
        ? `Your accounts represent *${fmtEur(currentArr)}* in current ARR — there may be significant expansion potential we're not capturing.`
        : null

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
      ...(arrText
        ? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: arrText,
              },
            },
          ]
        : []),
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
