import { Router } from 'express'
import axios from 'axios'
import { requireAdmin } from '../middleware/adminAuth'
import { getServiceConnection } from '../services/salesforce'

const router = Router()

const SFDC_BASE = 'https://uberall.lightning.force.com'

interface SfdcLeadRecord {
  Id: string
  Name: string
  Company: string | null
  Email: string | null
  Status: string | null
  LeadSource: string | null
  Hand_Raise_Date_Time__c: string | null
  Type_of_Hand_Raise__c: string | null
  Hand_Raise_Comment__c: string | null
  LastActivityDate: string | null
  CreatedDate: string
  Owner: {
    Name: string
    Email: string | null
    UserRole: { Name: string | null } | null
  }
}

interface LeadEntry {
  id: string
  name: string
  company: string | null
  email: string | null
  status: string | null
  leadSource: string | null
  handRaiseDate: string | null
  typeOfHandRaise: string | null
  comment: string | null
  createdDate: string
  sfdcUrl: string
}

interface OwnerGroup {
  ownerName: string
  ownerEmail: string | null
  ownerRole: string | null
  leads: LeadEntry[]
}

// GET /api/hand-raise/leads
router.get('/leads', requireAdmin, async (_req, res) => {
  try {
    const conn = await getServiceConnection()

    const soql = `
      SELECT Id, Name, Company, Email, Status, LeadSource,
             Hand_Raise_Date_Time__c, Type_of_Hand_Raise__c, Hand_Raise_Comment__c,
             LastActivityDate, CreatedDate,
             Owner.Name, Owner.Email, Owner.UserRole.Name
      FROM Lead
      WHERE Hand_Raise__c = true
        AND IsConverted = false
        AND LastActivityDate = null
        AND Status != 'Closed'
        AND Status != 'Closed/Disqualified'
        AND Owner.IsActive = true
      ORDER BY Hand_Raise_Date_Time__c DESC
      LIMIT 500
    `.trim()

    let records: SfdcLeadRecord[]

    try {
      const url = `${conn.instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`
      const resp = await axios.get<{ records: SfdcLeadRecord[] }>(url, {
        headers: { Authorization: `Bearer ${conn.accessToken!}` },
        timeout: 20_000,
      })
      records = resp.data.records
    } catch (orderByErr) {
      // Salesforce REST API sometimes can't ORDER BY relationship fields — retry without ORDER BY
      console.warn('[HandRaise] ORDER BY failed, retrying without ORDER BY:', orderByErr)

      const soqlNoOrder = soql.replace(/\s*ORDER BY Hand_Raise_Date_Time__c DESC/, '')
      const url = `${conn.instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soqlNoOrder)}`
      const resp = await axios.get<{ records: SfdcLeadRecord[] }>(url, {
        headers: { Authorization: `Bearer ${conn.accessToken!}` },
        timeout: 20_000,
      })
      records = resp.data.records.slice().sort((a, b) => {
        const dateA = a.Hand_Raise_Date_Time__c ?? ''
        const dateB = b.Hand_Raise_Date_Time__c ?? ''
        return dateB.localeCompare(dateA)
      })
    }

    console.log(`[HandRaise] SFDC returned ${records.length} records`)

    // Group records by owner
    const groupMap = new Map<string, OwnerGroup>()

    for (const r of records) {
      const ownerKey = r.Owner?.Email ?? r.Owner?.Name ?? '__unknown__'

      if (!groupMap.has(ownerKey)) {
        groupMap.set(ownerKey, {
          ownerName: r.Owner?.Name ?? ownerKey,
          ownerEmail: r.Owner?.Email ?? null,
          ownerRole: r.Owner?.UserRole?.Name ?? null,
          leads: [],
        })
      }

      const group = groupMap.get(ownerKey)!
      group.leads.push({
        id: r.Id,
        name: r.Name,
        company: r.Company,
        email: r.Email,
        status: r.Status,
        leadSource: r.LeadSource,
        handRaiseDate: r.Hand_Raise_Date_Time__c,
        typeOfHandRaise: r.Type_of_Hand_Raise__c,
        comment: r.Hand_Raise_Comment__c,
        createdDate: r.CreatedDate,
        sfdcUrl: `${SFDC_BASE}/lightning/r/Lead/${r.Id}/view`,
      })
    }

    // Sort groups by lead count descending
    const groups: OwnerGroup[] = Array.from(groupMap.values()).sort(
      (a, b) => b.leads.length - a.leads.length
    )

    console.log(`[HandRaise] Returning ${groups.length} owner groups`)
    res.json({ groups, total: records.length })
  } catch (err) {
    console.error('[HandRaise] /leads error:', err)
    res.status(500).json({ error: 'Failed to load hand raise leads from Salesforce' })
  }
})

export default router
