import * as jsforce from 'jsforce'
import axios from 'axios'
import { config } from '../config'
import { db } from '../db'
import { encrypt, decrypt } from '../crypto'
import { randomBytes, createHash } from 'crypto'
import { cacheRedis as redis } from '../redis'

const SFDC_API_VERSION = '59.0'

// Run a SOQL query via direct REST API calls using axios.
// jsforce's HTTP layer has no per-request timeout and can hang indefinitely on Railway.
// axios gives us a hard socket-level timeout so we always fail fast.
interface SfdcQueryResponse<T> {
  records: T[]
  done: boolean
  nextRecordsUrl?: string
}

async function runSfdcSoql<T>(
  instanceUrl: string,
  accessToken: string,
  soql: string,
  timeoutMs = 15_000,
): Promise<T[]> {
  const records: T[] = []
  let nextPath: string | null = `/services/data/v${SFDC_API_VERSION}/query?q=${encodeURIComponent(soql)}`
  while (nextPath) {
    const resp = await axios.get<SfdcQueryResponse<T>>(
      `${instanceUrl}${nextPath}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: timeoutMs },
    )
    const page: SfdcQueryResponse<T> = resp.data
    records.push(...page.records)
    nextPath = page.done ? null : (page.nextRecordsUrl ?? null)
  }
  return records
}

const SFDC_OPP_CACHE_KEY = 'sfdc:open_opportunities'
const SFDC_OPP_CACHE_TTL = 5 * 60
const SFDC_ACCOUNT_CACHE_KEY = 'sfdc:prospect_accounts'
const SFDC_ACCOUNT_CACHE_TTL = 5 * 60

// In-memory cache — zero network latency, lives for the process lifetime
// Used as L1 (in-process), Redis as L2 (across restarts/deploys)
let _oppsMemCache: { data: SfdcOpportunity[]; expiresAt: number } | null = null
const _accountsMemCache = new Map<string, { data: SfdcAccount[]; expiresAt: number }>()

export interface SfdcOpportunity {
  Id: string
  Name: string
  StageName: string
  CloseDate: string
  Type: string
  Amount: number | null
  OwnerId: string
  Owner: { Id: string; Name: string; Email: string; Manager?: { Email: string | null; Name: string | null } | null }
  CreatedDate: string
  LastActivityDate: string | null
  IsClosed: boolean
  IsWon: boolean
  Stage_Duration_current__c?: number | null
  Stage_Change_Date__c?: string | null
  Opportunity_Age__c?: number | null
  Booking_Date__c?: string | null
  M_Metrics__c?: string | null
  E_Economic_buyer__c?: string | null
  DC_Decision_Criteria__c?: string | null
  DP_Decision_Process__c?: string | null
  I_Identify_Pain__c?: string | null
  Ch_Champion__c?: string | null
  Co_Competition_New__c?: string | null
  P_Paperwork__c?: string | null
  Budget_Details__c?: string | null
  Authority_Details__c?: string | null
  Need_Details__c?: string | null
  Timing_Details__c?: string | null
  Sales_Channel__c?: string | null
  Sales_Function__c?: string | null
  Sales_Region__c?: string | null
  NextStep?: string | null
  Next_Step_Date__c?: string | null
  Account?: { Id: string; Name: string }
}

function makeOAuth2() {
  return new jsforce.OAuth2({
    loginUrl: config.SFDC_LOGIN_URL,
    clientId: config.SFDC_CLIENT_ID,
    clientSecret: config.SFDC_CLIENT_SECRET,
    redirectUri: config.SFDC_REDIRECT_URI,
  })
}

export async function getConnectionForUser(userId: string): Promise<jsforce.Connection> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } })

  if (!user.sfdcAccessToken || !user.sfdcInstanceUrl) {
    throw new Error(`User ${userId} has not connected Salesforce`)
  }

  const conn = new jsforce.Connection({
    oauth2: makeOAuth2(),
    instanceUrl: user.sfdcInstanceUrl,
    accessToken: decrypt(user.sfdcAccessToken),
    refreshToken: user.sfdcRefreshToken ? decrypt(user.sfdcRefreshToken) : undefined,
  })

  conn.on('refresh', async (accessToken: string) => {
    await db.user.update({
      where: { id: userId },
      data: {
        sfdcAccessToken: encrypt(accessToken),
        sfdcTokenExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      },
    })
  })

  return conn
}

let _serviceConn: jsforce.Connection | null = null

export function invalidateSfdcCache(): void {
  _serviceConn = null
}

export async function getServiceConnection(): Promise<jsforce.Connection> {
  if (_serviceConn) return _serviceConn
  const revOpsUser = await db.user.findFirst({
    where: { isRevOps: true, sfdcAccessToken: { not: null } },
  })
  if (!revOpsUser) throw new Error('No RevOps SFDC connection found — please connect Salesforce')
  _serviceConn = await getConnectionForUser(revOpsUser.id)
  return _serviceConn
}

// Returns the Salesforce instance URL (e.g. https://uberall.lightning.force.com)
// Reads from the connected RevOps user in DB — no env var needed.
export async function getSfdcInstanceUrl(): Promise<string> {
  const revOpsUser = await db.user.findFirst({
    where: { isRevOps: true, sfdcInstanceUrl: { not: null } },
    select: { sfdcInstanceUrl: true },
  })
  return revOpsUser?.sfdcInstanceUrl ?? 'https://login.salesforce.com'
}

// PKCE helpers
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function getSfdcAuthUrl(statePayload: string, codeChallenge?: string): string {
  const params: Record<string, string> = { scope: 'api refresh_token', state: statePayload }
  if (codeChallenge) {
    params.code_challenge = codeChallenge
    params.code_challenge_method = 'S256'
  }
  return makeOAuth2().getAuthorizationUrl(params)
}

export async function handleSfdcCallback(code: string, userId: string, codeVerifier?: string): Promise<void> {
  const oauth2 = makeOAuth2()
  const conn = new jsforce.Connection({ oauth2 })
  if (codeVerifier) {
    // Exchange code manually with code_verifier
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.SFDC_CLIENT_ID,
      client_secret: config.SFDC_CLIENT_SECRET,
      redirect_uri: config.SFDC_REDIRECT_URI,
      code_verifier: codeVerifier,
    })
    const resp = await fetch(`${config.SFDC_LOGIN_URL}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    if (!resp.ok) {
      const err = await resp.text()
      throw new Error(`SFDC token exchange failed: ${err}`)
    }
    const tokens = await resp.json() as { access_token: string; refresh_token?: string; instance_url: string; id: string }
    const idParts = tokens.id.split('/')
    const sfdcUserId = idParts[idParts.length - 1]
    await db.user.update({
      where: { id: userId },
      data: {
        sfdcUserId,
        sfdcInstanceUrl: tokens.instance_url,
        sfdcAccessToken: encrypt(tokens.access_token),
        sfdcRefreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
        sfdcTokenExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        sfdcConnectedAt: new Date(),
      },
    })
    return
  }
  await conn.authorize(code)
  const identity = await conn.identity()

  await db.user.update({
    where: { id: userId },
    data: {
      sfdcUserId: identity.user_id,
      sfdcInstanceUrl: conn.instanceUrl,
      sfdcAccessToken: encrypt(conn.accessToken!),
      sfdcRefreshToken: conn.refreshToken ? encrypt(conn.refreshToken) : null,
      sfdcTokenExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      sfdcConnectedAt: new Date(),
    },
  })
}

export async function fetchOpenOpportunities(opts: { bustCache?: boolean } = {}): Promise<SfdcOpportunity[]> {
  const now = Date.now()
  if (!opts.bustCache) {
    // L1: in-memory (instant)
    if (_oppsMemCache && _oppsMemCache.expiresAt > now) {
      console.log(`[SFDC] Opps: memory cache hit (${_oppsMemCache.data.length} records)`)
      return _oppsMemCache.data
    }
    // L2: Redis (fast, survives restarts)
    const cached = await redis.get(SFDC_OPP_CACHE_KEY).catch(() => null)
    if (cached) {
      const opps = JSON.parse(cached) as SfdcOpportunity[]
      console.log(`[SFDC] Opps: Redis cache hit (${opps.length} records)`)
      _oppsMemCache = { data: opps, expiresAt: now + SFDC_OPP_CACHE_TTL * 1000 }
      return opps
    }
  } else {
    _oppsMemCache = null
  }

  const conn = await getServiceConnection()

  let records: SfdcOpportunity[]
  try {
    records = await runSfdcSoql<SfdcOpportunity>(
      conn.instanceUrl,
      conn.accessToken!,
      `SELECT
        Id, Name, StageName, CloseDate, Type, Amount,
        OwnerId, Owner.Id, Owner.Name, Owner.Email, Owner.Manager.Email, Owner.Manager.Name,
        CreatedDate, LastActivityDate, IsClosed, IsWon,
        Stage_Duration_current__c, Opportunity_Age__c, Booking_Date__c, Stage_Change_Date__c,
        M_Metrics__c, E_Economic_buyer__c,
        DC_Decision_Criteria__c, DP_Decision_Process__c,
        I_Identify_Pain__c, Ch_Champion__c, Co_Competition_New__c, P_Paperwork__c,
        Budget_Details__c, Authority_Details__c, Need_Details__c, Timing_Details__c,
        Sales_Channel__c, Sales_Function__c, Sales_Region__c,
        NextStep, Next_Step_Date__c,
        Account.Id, Account.Name
      FROM Opportunity
      WHERE IsClosed = false
      ORDER BY CloseDate ASC`,
    )
  } catch (err) {
    _serviceConn = null
    const status = (err as any)?.response?.status
    if (status === 401) throw new Error('Salesforce token expired — please reconnect Salesforce in settings')
    throw err
  }

  console.log(`[SFDC] Fetched ${records.length} open opportunities from API`)
  _oppsMemCache = { data: records, expiresAt: Date.now() + SFDC_OPP_CACHE_TTL * 1000 }
  await redis.set(SFDC_OPP_CACHE_KEY, JSON.stringify(records), 'EX', SFDC_OPP_CACHE_TTL).catch(() => undefined)
  return records
}

export async function invalidateSfdcOppCache(): Promise<void> {
  _oppsMemCache = null
  await redis.del(SFDC_OPP_CACHE_KEY).catch(() => undefined)
}

export async function updateOpportunity(
  userId: string,
  opportunityId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const conn = await getConnectionForUser(userId)
  await conn.sobject('Opportunity').update({ Id: opportunityId, ...fields })
  await conn.sobject('Task').create({
    WhatId: opportunityId,
    Subject: 'Updated via RevBot',
    Description: `Fields updated: ${Object.keys(fields).join(', ')}`,
    Status: 'Completed',
    ActivityDate: new Date().toISOString().split('T')[0],
  })
}

export async function updateCloseDate(userId: string, oppId: string, newDate: string): Promise<void> {
  return updateOpportunity(userId, oppId, { CloseDate: newDate })
}

export async function updateMeddpiccFields(
  userId: string,
  oppId: string,
  fields: Record<string, string>
): Promise<void> {
  return updateOpportunity(userId, oppId, fields)
}

export async function updateStage(userId: string, oppId: string, newStage: string): Promise<void> {
  return updateOpportunity(userId, oppId, { StageName: newStage })
}

export interface SfdcAccount {
  Id: string
  Name: string
  Account_Stage__c: string | null
  Prospecting_Status__c: string | null
  Prospecting_Pause_Reason__c: string | null
  Target_Prospecting_Date__c: string | null
  Date_to_Re_engage__c: string | null
  End_of_competitor_engagement__c: string | null
  Competitor__c: string | null
  Last_Rep_Communication_Date__c: string | null
  OwnerId: string
  Owner: { Id: string; Name: string; Email: string }
  RecordType?: { Name: string; DeveloperName: string } | null
  // BDR assigned (User lookup)
  BDR_Assigned__c?: string | null
  BDR_Assigned__r?: { Id: string; Name: string; Email: string } | null
  // Contacts subquery — includes Gong Engage Flow fields (synced by Gong → SFDC integration)
  Contacts?: {
    totalSize: number
    records: Array<{
      Id: string
      Email: string | null
      Name: string
      Gong__Actively_Being_in_a_Flow__c: boolean | null
      Gong__Current_Flow_Name__c: string | null
      Gong__Flow_Status__c: string | null
      Gong__Current_Flow_Task_Due_Date__c: string | null
      Gong__Active_Engage_Flow_Names__c: string | null
      Gong__Number_of_Active_Engage_Flows__c: number | null
      Gong__Engage_Flow_Owner__c: string | null
      Gong__Added_to_Flow_Date__c: string | null
    }>
  } | null
}

export async function fetchProspectAccounts(recordTypeDeveloperName = 'Enterprise_Account_Record', opts: { bustCache?: boolean } = {}): Promise<SfdcAccount[]> {
  const cacheKey = `${SFDC_ACCOUNT_CACHE_KEY}:${recordTypeDeveloperName}`
  const now = Date.now()
  if (!opts.bustCache) {
    // L1: in-memory
    const mem = _accountsMemCache.get(cacheKey)
    if (mem && mem.expiresAt > now) {
      console.log(`[SFDC] Accounts: memory cache hit (${mem.data.length} records)`)
      return mem.data
    }
    // L2: Redis
    const cached = await redis.get(cacheKey).catch(() => null)
    if (cached) {
      const accounts = JSON.parse(cached) as SfdcAccount[]
      console.log(`[SFDC] Accounts: Redis cache hit (${accounts.length} records)`)
      _accountsMemCache.set(cacheKey, { data: accounts, expiresAt: now + SFDC_ACCOUNT_CACHE_TTL * 1000 })
      return accounts
    }
  } else {
    _accountsMemCache.delete(cacheKey)
  }

  const conn = await getServiceConnection()
  const rtFilter = recordTypeDeveloperName ? `AND RecordType.DeveloperName = '${recordTypeDeveloperName}'` : ''

  let records: SfdcAccount[]
  try {
    records = await runSfdcSoql<SfdcAccount>(
      conn.instanceUrl,
      conn.accessToken!,
      `SELECT Id, Name, Account_Stage__c, Prospecting_Status__c, Prospecting_Pause_Reason__c,
             Target_Prospecting_Date__c, Date_to_Re_engage__c,
             End_of_competitor_engagement__c, Competitor__c, Last_Rep_Communication_Date__c,
             OwnerId, Owner.Id, Owner.Name, Owner.Email,
             BDR_Assigned__c, BDR_Assigned__r.Id, BDR_Assigned__r.Name, BDR_Assigned__r.Email,
             RecordType.Name, RecordType.DeveloperName,
             (SELECT Id, Email, Name,
                     Gong__Actively_Being_in_a_Flow__c, Gong__Current_Flow_Name__c,
                     Gong__Flow_Status__c, Gong__Current_Flow_Task_Due_Date__c,
                     Gong__Active_Engage_Flow_Names__c, Gong__Number_of_Active_Engage_Flows__c,
                     Gong__Engage_Flow_Owner__c, Gong__Added_to_Flow_Date__c
              FROM Contacts LIMIT 10)
      FROM Account
      WHERE Account_Stage__c = 'Prospect'
      AND Target_Prospecting_Date__c != null
      ${rtFilter}
      ORDER BY Name ASC`,
    )
  } catch (err) {
    _serviceConn = null
    const status = (err as any)?.response?.status
    if (status === 401) throw new Error('Salesforce token expired — please reconnect Salesforce in settings')
    throw err
  }

  console.log(`[SFDC] Fetched ${records.length} prospect accounts from API`)
  _accountsMemCache.set(cacheKey, { data: records, expiresAt: Date.now() + SFDC_ACCOUNT_CACHE_TTL * 1000 })
  await redis.set(cacheKey, JSON.stringify(records), 'EX', SFDC_ACCOUNT_CACHE_TTL).catch(() => undefined)
  return records
}

// Update editable prospecting fields on an Account record
export async function updateProspectAccount(
  accountId: string,
  fields: Partial<{
    Prospecting_Status__c: string | null
    Target_Prospecting_Date__c: string | null
    Prospecting_Pause_Reason__c: string | null
    Date_to_Re_engage__c: string | null
    Competitor__c: string | null
    End_of_competitor_engagement__c: string | null
  }>
): Promise<void> {
  const conn = await getServiceConnection()
  // Build update payload — include only fields that were explicitly passed
  const payload: Record<string, string | null> = { Id: accountId }
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) payload[k] = v ?? null
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await conn.sobject('Account').update(payload as any)
}
