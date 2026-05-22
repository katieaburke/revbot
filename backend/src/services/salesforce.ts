import jsforce from 'jsforce'
import { config } from '../config'
import { db } from '../db'
import { encrypt, decrypt } from '../crypto'

export interface SfdcOpportunity {
  Id: string
  Name: string
  StageName: string
  CloseDate: string
  Type: string // 'New Business' | 'Renewal' | 'Amendment' | etc.
  Amount: number | null
  OwnerId: string
  Owner: { Id: string; Name: string; Email: string }
  CreatedDate: string
  LastActivityDate: string | null
  IsClosed: boolean
  IsWon: boolean
  // Stage entry date (needs custom field or formula in SFDC)
  StageEntryDate__c?: string
  // MEDDPICC custom fields
  MEDDPICC_Metrics__c?: string
  MEDDPICC_Economic_Buyer__c?: string
  MEDDPICC_Decision_Criteria__c?: string
  MEDDPICC_Decision_Process__c?: string
  MEDDPICC_Identify_Pain__c?: string
  MEDDPICC_Champion__c?: string
  MEDDPICC_Competition__c?: string
  // Segment
  Account?: { Id: string; Name: string; Segment__c?: string }
}

// Build a jsforce connection from stored user tokens, refreshing if needed
export async function getConnectionForUser(userId: string): Promise<jsforce.Connection> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } })

  if (!user.sfdcAccessToken || !user.sfdcInstanceUrl) {
    throw new Error(`User ${userId} has not connected Salesforce`)
  }

  const conn = new jsforce.Connection({
    oauth2: new jsforce.OAuth2({
      loginUrl: config.SFDC_LOGIN_URL,
      clientId: config.SFDC_CLIENT_ID,
      clientSecret: config.SFDC_CLIENT_SECRET,
      redirectUri: config.SFDC_REDIRECT_URI,
    }),
    instanceUrl: user.sfdcInstanceUrl,
    accessToken: decrypt(user.sfdcAccessToken),
    refreshToken: user.sfdcRefreshToken ? decrypt(user.sfdcRefreshToken) : undefined,
  })

  // Persist refreshed tokens automatically
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

// Service-account connection (used for reading all opps in scheduled jobs)
let _serviceConn: jsforce.Connection | null = null

export async function getServiceConnection(): Promise<jsforce.Connection> {
  if (_serviceConn) return _serviceConn

  // Use the first RevOps user's connection as service account, or dedicated creds
  const revOpsUser = await db.user.findFirst({
    where: { isRevOps: true, sfdcAccessToken: { not: null } },
  })

  if (!revOpsUser) throw new Error('No RevOps SFDC connection found — please connect Salesforce')

  _serviceConn = await getConnectionForUser(revOpsUser.id)
  return _serviceConn
}

// Build the OAuth URL to redirect a user to
export function getSfdcAuthUrl(statePayload: string): string {
  const oauth2 = new jsforce.OAuth2({
    loginUrl: config.SFDC_LOGIN_URL,
    clientId: config.SFDC_CLIENT_ID,
    clientSecret: config.SFDC_CLIENT_SECRET,
    redirectUri: config.SFDC_REDIRECT_URI,
  })
  return oauth2.getAuthorizationUrl({ scope: 'api refresh_token', state: statePayload })
}

// Exchange auth code for tokens and persist against the user
export async function handleSfdcCallback(code: string, userId: string): Promise<void> {
  const conn = new jsforce.Connection({
    oauth2: new jsforce.OAuth2({
      loginUrl: config.SFDC_LOGIN_URL,
      clientId: config.SFDC_CLIENT_ID,
      clientSecret: config.SFDC_CLIENT_SECRET,
      redirectUri: config.SFDC_REDIRECT_URI,
    }),
  })

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

// Fetch all open opportunities with MEDDPICC and owner info
export async function fetchOpenOpportunities(): Promise<SfdcOpportunity[]> {
  const conn = await getServiceConnection()

  const result = await conn.query<SfdcOpportunity>(`
    SELECT
      Id, Name, StageName, CloseDate, Type, Amount,
      OwnerId, Owner.Id, Owner.Name, Owner.Email,
      CreatedDate, LastActivityDate,
      IsClosed, IsWon,
      StageEntryDate__c,
      MEDDPICC_Metrics__c,
      MEDDPICC_Economic_Buyer__c,
      MEDDPICC_Decision_Criteria__c,
      MEDDPICC_Decision_Process__c,
      MEDDPICC_Identify_Pain__c,
      MEDDPICC_Champion__c,
      MEDDPICC_Competition__c,
      Account.Id, Account.Name, Account.Segment__c
    FROM Opportunity
    WHERE IsClosed = false
    ORDER BY CloseDate ASC
  `)

  return result.records
}

// Update a specific opportunity field as a given user
export async function updateOpportunity(
  userId: string,
  opportunityId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const conn = await getConnectionForUser(userId)
  await conn.sobject('Opportunity').update({ Id: opportunityId, ...fields })

  // Log activity note so it's visible in SFDC audit trail
  await conn.sobject('Task').create({
    WhatId: opportunityId,
    Subject: 'Updated via Pipeline Nudge',
    Description: `Fields updated: ${Object.keys(fields).join(', ')}`,
    Status: 'Completed',
    ActivityDate: new Date().toISOString().split('T')[0],
  })
}

// Update close date
export async function updateCloseDate(userId: string, oppId: string, newDate: string): Promise<void> {
  return updateOpportunity(userId, oppId, { CloseDate: newDate })
}

// Update MEDDPICC field(s)
export async function updateMeddpiccFields(
  userId: string,
  oppId: string,
  fields: Partial<Record<string, string>>
): Promise<void> {
  return updateOpportunity(userId, oppId, fields)
}

// Update stage
export async function updateStage(userId: string, oppId: string, newStage: string): Promise<void> {
  return updateOpportunity(userId, oppId, { StageName: newStage })
}
