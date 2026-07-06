import axios from 'axios'
import { getServiceConnection } from './salesforce'
import { sendDm, resolveSlackUserId } from '../slack/bot'
import type { KnownBlock } from '@slack/web-api'

// ── Types ───────────────────────────────────────────────────────────────────────

export interface ChurnedAccount {
  id: string
  name: string
  billingCountry: string | null
  industry: string | null
  numberOfLocations: number | null
  cancellationEffectiveDate: string | null
  cancellationNoticeDate: string | null
  primaryCancellationReason: string | null
  ownerName: string
  ownerEmail: string | null
  ownerRole: string | null
}

export interface SalesRep {
  id: string
  name: string
  email: string
  role: string
  region: 'US-CAN' | 'EMEA' | 'Other'
}

// ── SFDC helpers ─────────────────────────────────────────────────────────────────

interface SfdcPage<T> { records: T[]; done: boolean; nextRecordsUrl?: string }

async function runSoql<T>(instanceUrl: string, accessToken: string, soql: string): Promise<T[]> {
  const records: T[] = []
  let nextPath: string | null = `/services/data/v59.0/query?q=${encodeURIComponent(soql)}`

  while (nextPath) {
    const resp: { data: SfdcPage<T> } = await axios.get<SfdcPage<T>>(
      `${instanceUrl}${nextPath}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 20_000 },
    )
    const page: SfdcPage<T> = resp.data
    records.push(...page.records)
    nextPath = page.done ? null : (page.nextRecordsUrl ?? null)
  }
  return records
}

// ── Fetch churned accounts ────────────────────────────────────────────────────────
// Report: "Churned customers owned by AM >6m"
// Criteria: contract ended >6 months ago, still owned by Existing Business rep, Direct Enterprise

export async function fetchChurnedAccounts(): Promise<ChurnedAccount[]> {
  const conn = await getServiceConnection()

  const soql = `
    SELECT Id, Name, BillingCountry, Industry, Number_of_locations__c,
           Cancelled_Contract_due_date__c, Cancellation_Notice_Date__c,
           Primary_Cancellation_Reason__c,
           Owner.Name, Owner.Email, Owner.UserRole.Name
    FROM Account
    WHERE Cancelled_Contract_due_date__c < N_MONTHS_AGO:6
    AND RecordType.DeveloperName = 'Enterprise_Account_Record'
    AND Type = 'Direct Enterprise'
    AND Owner.UserRole.Name LIKE '%Existing Business%'
    AND GEO_Studio_Customer_Only__c = false
    ORDER BY Cancelled_Contract_due_date__c DESC, Name ASC
  `

  interface RawAccount {
    Id: string
    Name: string
    BillingCountry?: string | null
    Industry?: string | null
    Number_of_locations__c?: number | null
    Cancelled_Contract_due_date__c?: string | null
    Cancellation_Notice_Date__c?: string | null
    Primary_Cancellation_Reason__c?: string | null
    Owner?: { Name?: string; Email?: string; UserRole?: { Name?: string } | null } | null
  }

  const records = await runSoql<RawAccount>(conn.instanceUrl, conn.accessToken!, soql)

  return records.map((r) => ({
    id: r.Id,
    name: r.Name,
    billingCountry: r.BillingCountry ?? null,
    industry: r.Industry ?? null,
    numberOfLocations: r.Number_of_locations__c ?? null,
    cancellationEffectiveDate: r.Cancelled_Contract_due_date__c ?? null,
    cancellationNoticeDate: r.Cancellation_Notice_Date__c ?? null,
    primaryCancellationReason: r.Primary_Cancellation_Reason__c ?? null,
    ownerName: r.Owner?.Name ?? '',
    ownerEmail: r.Owner?.Email ?? null,
    ownerRole: r.Owner?.UserRole?.Name ?? null,
  }))
}

// ── Fetch available sales reps ────────────────────────────────────────────────────
// Only AE/Sales reps (not BDRs) from New Business roles

export async function fetchSalesReps(): Promise<SalesRep[]> {
  const conn = await getServiceConnection()

  const soql = `
    SELECT Id, Name, Email, UserRole.Name
    FROM User
    WHERE IsActive = true
    AND UserRole.Name LIKE '%New Business%'
    AND UserRole.Name LIKE '%Sales%'
    AND UserRole.Name LIKE '%Rep%'
    AND (NOT UserRole.Name LIKE '%BDR%')
    ORDER BY Name ASC
  `

  interface RawUser {
    Id: string
    Name: string
    Email: string
    UserRole?: { Name?: string } | null
  }

  const records = await runSoql<RawUser>(conn.instanceUrl, conn.accessToken!, soql)

  return records.map((r) => {
    const role = r.UserRole?.Name ?? ''
    const region = role.includes('US-CAN') ? 'US-CAN' : role.includes('EMEA') ? 'EMEA' : 'Other'
    return { id: r.Id, name: r.Name, email: r.Email, role, region }
  })
}

// ── Reassign account in SFDC ─────────────────────────────────────────────────────

export async function updateAccountOwner(accountId: string, newOwnerId: string): Promise<void> {
  const conn = await getServiceConnection()

  await axios.patch(
    `${conn.instanceUrl}/services/data/v59.0/sobjects/Account/${accountId}`,
    { OwnerId: newOwnerId },
    { headers: { Authorization: `Bearer ${conn.accessToken!}`, 'Content-Type': 'application/json' }, timeout: 15_000 },
  )
}

// ── Slack notification to new owner ──────────────────────────────────────────────

export async function notifyNewOwner(
  account: ChurnedAccount,
  newOwnerName: string,
  newOwnerEmail: string,
  sfdcInstanceUrl: string,
): Promise<void> {
  const slackId = await resolveSlackUserId(newOwnerEmail)
  if (!slackId) {
    console.warn(`[ChurnedReassign] No Slack ID found for ${newOwnerEmail}`)
    return
  }

  const firstName = newOwnerName.split(' ')[0]
  const locStr = account.numberOfLocations != null ? ` with ${account.numberOfLocations.toLocaleString()} location${account.numberOfLocations !== 1 ? 's' : ''}` : ''
  const countryStr = account.billingCountry ? ` in ${account.billingCountry}` : ''
  const sfLink = `${sfdcInstanceUrl}/${account.id}`

  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Hi ${firstName}! 👋 A churned account has been added to your territory.`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Account*\n<${sfLink}|${account.name}>` },
        { type: 'mrkdwn', text: `*Locations*\n${account.numberOfLocations?.toLocaleString() ?? '—'}` },
        { type: 'mrkdwn', text: `*Industry*\n${account.industry ?? '—'}` },
        { type: 'mrkdwn', text: `*Country*\n${account.billingCountry ?? '—'}` },
        ...(account.primaryCancellationReason
          ? [{ type: 'mrkdwn' as const, text: `*Cancellation reason*\n${account.primaryCancellationReason}` }]
          : []),
        ...(account.cancellationEffectiveDate
          ? [{ type: 'mrkdwn' as const, text: `*Churned*\n${new Date(account.cancellationEffectiveDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` }]
          : []),
      ],
    },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'View in Salesforce', emoji: true },
        url: sfLink,
        style: 'primary',
      }],
    },
  ]

  await sendDm(
    slackId,
    blocks,
    `🔄 Churned account reassigned: ${account.name}${locStr}${countryStr}`,
  )

  console.log(`[ChurnedReassign] Notified ${newOwnerName} about ${account.name}`)
}
