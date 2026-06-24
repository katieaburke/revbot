import * as jsforce from 'jsforce'
import { config } from '../config'
import { db } from '../db'
import { encrypt, decrypt } from '../crypto'
import { randomBytes, createHash } from 'crypto'

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

export async function fetchOpenOpportunities(): Promise<SfdcOpportunity[]> {
  const conn = await getServiceConnection()
  let result = await conn.query<SfdcOpportunity>(`
    SELECT
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
    ORDER BY CloseDate ASC
  `)
  const records = [...result.records]
  while (!result.done && result.nextRecordsUrl) {
    result = await conn.queryMore<SfdcOpportunity>(result.nextRecordsUrl)
    records.push(...result.records)
  }
  console.log(`[SFDC] Fetched ${records.length} open opportunities`)
  return records
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
    Subject: 'Updated via Beacon',
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
