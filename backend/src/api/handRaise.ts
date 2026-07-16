import { Router } from 'express'
import axios from 'axios'
import { requireAdmin } from '../middleware/adminAuth'
import { getServiceConnection } from '../services/salesforce'
import { sendDm } from '../slack/bot'
import { db } from '../db'

const router = Router()

const SFDC_BASE = 'https://uberall.lightning.force.com'

interface SfdcContactRecord {
  Id: string
  Name: string
  Email: string | null
  AccountId: string | null
  Account: {
    Name: string | null
    RecordType: { Name: string | null } | null
  } | null
  Contact_Stage__c: string | null
  Account_Stage__c: string | null
  Hand_Raise__c: boolean
  Hand_Raise_Date_Time__c: string | null
  Hand_Raise_Comment__c: string | null
  Is_Marketing_Qualified__c: boolean
  Last_Rep_Communication_Date__c: string | null
  Gong__Current_Flow_Name__c: string | null
  Outreach_Current_Sequence_Name__c: string | null
  Type_of_Hand_Raise__c: string | null
  LeadSource: string | null
  CreatedDate: string
  Owner: {
    Name: string
    Email: string | null
    UserRole: { Name: string | null } | null
  }
}

interface ContactEntry {
  id: string
  name: string
  email: string | null
  accountId: string | null
  accountName: string | null
  accountRecordType: string | null
  contactStage: string | null
  accountStage: string | null
  handRaiseDate: string | null
  typeOfHandRaise: string | null
  comment: string | null
  lastRepCommDate: string | null
  currentFlowName: string | null
  createdDate: string
  sfdcUrl: string
}

interface OwnerGroup {
  ownerName: string
  ownerEmail: string | null
  ownerRole: string | null
  contacts: ContactEntry[]
}

// GET /api/hand-raise/leads
router.get('/leads', requireAdmin, async (_req, res) => {
  try {
    const conn = await getServiceConnection()

    // Replicate the Salesforce report filters:
    // - Hand Raise = true
    // - Marketing Qualified = true
    // - Hand Raise Date/Time in last 30 days
    // - Account Name does not contain 'test' or 'uberall'
    // - Email does not contain 'uberall'
    // - Owner Name does not contain 'Zamin'
    // NOTE: "Followed Up?" = No is a row-level formula (Last_Rep_Communication_Date__c > Hand_Raise_Date_Time__c)
    //       SOQL can't compare two fields, so we filter that in JS post-query.
    // NOTE: Contact Stage != Disqualified, Account Stage != Customer, Account RecordType filtering
    //       also applied in JS since formula/cross-object fields can be unreliable in WHERE.
    const soql = `
      SELECT Id, Name, Email, AccountId,
             Account.Name, Account.RecordType.Name,
             Contact_Stage__c, Account_Stage__c,
             Hand_Raise__c, Hand_Raise_Date_Time__c, Hand_Raise_Comment__c,
             Is_Marketing_Qualified__c, Last_Rep_Communication_Date__c,
             Gong__Current_Flow_Name__c, Outreach_Current_Sequence_Name__c,
             Type_of_Hand_Raise__c, LeadSource, CreatedDate,
             Owner.Name, Owner.Email, Owner.UserRole.Name
      FROM Contact
      WHERE Hand_Raise__c = true
        AND Is_Marketing_Qualified__c = true
        AND Hand_Raise_Date_Time__c >= LAST_N_DAYS:30
        AND (NOT Account.Name LIKE '%test%')
        AND (NOT Account.Name LIKE '%uberall%')
        AND (NOT Email LIKE '%uberall%')
        AND (NOT Owner.Name LIKE '%Zamin%')
        AND Owner.IsActive = true
      LIMIT 500
    `.trim()

    const url = `${conn.instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`
    const resp = await axios.get<{ records: SfdcContactRecord[] }>(url, {
      headers: { Authorization: `Bearer ${conn.accessToken!}` },
      timeout: 20_000,
    })

    console.log(`[HandRaise] SFDC returned ${resp.data.records.length} raw records`)

    // JS-side filters to replicate report logic:
    // 1. "Followed Up? = No" — Last_Rep_Communication_Date__c is null OR before Hand_Raise_Date_Time__c
    // 2. Contact Stage != Disqualified (and != Closed per contact lifecycle)
    // 3. Account Stage != Customer
    // 4. Account RecordType = Partner Account Record OR Enterprise Account Record
    const VALID_RECORD_TYPES = new Set(['Partner Account Record', 'Enterprise Account Record'])

    const filtered = resp.data.records.filter((r) => {
      // Must not be followed up.
      // Last_Rep_Communication_Date__c is a bare date (midnight UTC), Hand_Raise_Date_Time__c is a
      // datetime — comparing them directly causes timezone false-positives. We use a 1-day buffer:
      // only exclude a record as "followed up" if the last rep comm is >= (hand raise date − 1 day).
      // i.e. if last comm is more than 1 day before the hand raise, it doesn't count as follow-up.
      const handRaiseDate = r.Hand_Raise_Date_Time__c ? new Date(r.Hand_Raise_Date_Time__c) : null
      const lastRepComm = r.Last_Rep_Communication_Date__c ? new Date(r.Last_Rep_Communication_Date__c) : null
      const threshold = handRaiseDate ? new Date(handRaiseDate.getTime() - 86_400_000) : null
      const followedUp = threshold && lastRepComm && lastRepComm >= threshold
      if (followedUp) return false

      // Contact stage must not be Disqualified or Closed
      const stage = r.Contact_Stage__c?.toLowerCase() ?? ''
      if (stage === 'disqualified' || stage === 'closed') return false

      // Account stage must not be Customer
      const accountStage = r.Account_Stage__c?.toLowerCase() ?? ''
      if (accountStage === 'customer') return false

      // Account record type must be Partner or Enterprise
      const recordType = r.Account?.RecordType?.Name ?? ''
      if (!VALID_RECORD_TYPES.has(recordType)) return false

      return true
    })

    console.log(`[HandRaise] After JS filtering: ${filtered.length} records`)

    // Sort by hand raise date descending
    filtered.sort((a, b) => {
      const dateA = a.Hand_Raise_Date_Time__c ?? ''
      const dateB = b.Hand_Raise_Date_Time__c ?? ''
      return dateB.localeCompare(dateA)
    })

    // Group by owner
    const groupMap = new Map<string, OwnerGroup>()

    for (const r of filtered) {
      const ownerKey = r.Owner?.Email ?? r.Owner?.Name ?? '__unknown__'

      if (!groupMap.has(ownerKey)) {
        groupMap.set(ownerKey, {
          ownerName: r.Owner?.Name ?? ownerKey,
          ownerEmail: r.Owner?.Email ?? null,
          ownerRole: r.Owner?.UserRole?.Name ?? null,
          contacts: [],
        })
      }

      groupMap.get(ownerKey)!.contacts.push({
        id: r.Id,
        name: r.Name,
        email: r.Email,
        accountId: r.AccountId,
        accountName: r.Account?.Name ?? null,
        accountRecordType: r.Account?.RecordType?.Name ?? null,
        contactStage: r.Contact_Stage__c,
        accountStage: r.Account_Stage__c,
        handRaiseDate: r.Hand_Raise_Date_Time__c,
        typeOfHandRaise: r.Type_of_Hand_Raise__c,
        comment: r.Hand_Raise_Comment__c,
        lastRepCommDate: r.Last_Rep_Communication_Date__c,
        currentFlowName: r.Gong__Current_Flow_Name__c ?? r.Outreach_Current_Sequence_Name__c ?? null,
        createdDate: r.CreatedDate,
        sfdcUrl: `${SFDC_BASE}/lightning/r/Contact/${r.Id}/view`,
      })
    }

    // Sort groups by contact count descending
    const groups: OwnerGroup[] = Array.from(groupMap.values()).sort(
      (a, b) => b.contacts.length - a.contacts.length
    )

    console.log(`[HandRaise] Returning ${groups.length} owner groups, ${filtered.length} total contacts`)
    res.json({ groups, total: filtered.length })
  } catch (err) {
    console.error('[HandRaise] /leads error:', err)
    res.status(500).json({ error: 'Failed to load hand raise contacts from Salesforce' })
  }
})

// POST /api/hand-raise/send-prompt
// Body: { ownerEmail, ownerName, contacts: ContactEntry[] }
router.post('/send-prompt', requireAdmin, async (req, res) => {
  const { ownerEmail, ownerName, contacts } = req.body as {
    ownerEmail?: string
    ownerName?: string
    contacts?: { name: string; accountName: string | null; handRaiseDate: string | null; comment: string | null; sfdcUrl: string }[]
  }

  if (!ownerEmail || !ownerName || !contacts?.length) {
    return res.status(400).json({ error: 'Missing required fields' })
  }

  // Look up Slack user ID from DB by email
  const user = await db.user.findFirst({
    where: { slackEmail: { equals: ownerEmail, mode: 'insensitive' } },
  })

  if (!user?.slackUserId) {
    return res.status(404).json({ error: `No Slack user found for ${ownerEmail}` })
  }

  try {
    const firstName = ownerName.split(' ')[0]
    const count = contacts.length
    const contactWord = count === 1 ? 'contact' : 'contacts'

    const fmtDate = (iso: string | null) => {
      if (!iso) return ''
      return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    }

    // Build contact list (max 10 to avoid Slack block limits)
    const listItems = contacts.slice(0, 10).map((c) => {
      const datePart = c.handRaiseDate ? ` on ${fmtDate(c.handRaiseDate)}` : ''
      const company = c.accountName ? ` (${c.accountName})` : ''
      const commentPart = c.comment ? `\n  _"${c.comment.slice(0, 120)}${c.comment.length > 120 ? '…' : ''}"_` : ''
      return `• <${c.sfdcUrl}|${c.name}>${company} raised their hand${datePart}${commentPart}`
    })

    if (contacts.length > 10) {
      listItems.push(`_…and ${contacts.length - 10} more_`)
    }

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '📣 Hand raise follow-up needed', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Hey ${firstName}! You have *${count} ${contactWord}* who raised their hand in the last 30 days with no sales follow-up recorded yet. Inbounds are automatically enrolled in a Gong flow — please ensure each contact is in their flow and actively execute on it.`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: listItems.join('\n'),
        },
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `_Sent by RevBot · Ensure each contact is enrolled in their Gong flow and actively follow up._` },
        ],
      },
    ]

    await sendDm(user.slackUserId, blocks as never, 'Hand raise follow-up needed')

    res.json({ ok: true })
  } catch (err) {
    console.error('[HandRaise] /send-prompt error:', err)
    res.status(500).json({ error: 'Failed to send Slack message' })
  }
})

export default router
