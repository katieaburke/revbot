import { Router } from 'express'
import axios from 'axios'
import { db } from '../db'
import { verifyRepToken, generateRepToken } from '../lib/repToken'
import { requireAdmin } from '../middleware/adminAuth'
import { getServiceConnection } from '../services/salesforce'
import { stageApiToLabel } from '../utils/stageMapping'
import { recheckForRep } from '../jobs/alertOrchestrator'
import { isAccountExecutive, isExistingBusiness } from '../lib/repRoles'
import {
  fetchTerritoryAccounts,
  applyDisposition,
  getAccountPicklists,
  resolveTerritoryFilters,
  DISPOSITIONS,
  NO_ICP_SUB_REASONS,
  type Disposition,
  type NoIcpSubReason,
} from '../services/territoryCleanup'

const router = Router()

const SFDC_BASE = 'https://uberall.lightning.force.com'

// Fetch live opp metadata from SFDC for a list of opp IDs.
// Returns { map, sfdcOk } — sfdcOk=false means the call failed and we should not act on missing IDs.
async function fetchOppMeta(oppIds: string[]): Promise<{
  map: Map<string, {
    amount: number | null
    closeDate: string | null
    stage: string | null
    nextStep: string | null
    nextStepDate: string | null
    isClosed: boolean
    oppType: string | null
    netAcv: number | null
    nextContractEndDate: string | null
    nextRenewalDate: string | null
    hasAutoRenewal: boolean | null
  }>
  sfdcOk: boolean
}> {
  const map = new Map()
  if (!oppIds.length) return { map, sfdcOk: true }
  try {
    const conn = await getServiceConnection()
    const ids = oppIds.map((id) => `'${id}'`).join(',')
    // Use SFDC's native IsClosed boolean — reliable for Closed Won AND Closed Lost regardless of custom stage names
    // Net_MCV__c = "Net ACV" field; Account fields used for renewal $0 ACV flow
    const soql = `SELECT Id, Amount, CloseDate, StageName, NextStep, Next_Step_Date__c, IsClosed, Type, Net_MCV__c, Account.Next_Contract_End_Date__c, Account.Next_Renewal_Date__c, Account.Has_Auto_Renewal_on_next_Renewal_Opp__c FROM Opportunity WHERE Id IN (${ids})`
    const url = `${conn.instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`
    const resp = await axios.get<{ records: {
      Id: string
      Amount: number | null
      CloseDate: string | null
      StageName: string
      NextStep: string | null
      Next_Step_Date__c: string | null
      IsClosed: boolean
      Type: string | null
      Net_MCV__c: number | null
      Account: {
        Next_Contract_End_Date__c: string | null
        Next_Renewal_Date__c: string | null
        Has_Auto_Renewal_on_next_Renewal_Opp__c: boolean | null
      } | null
    }[] }>(
      url, { headers: { Authorization: `Bearer ${conn.accessToken!}` }, timeout: 15_000 }
    )
    for (const r of resp.data.records) {
      map.set(r.Id, {
        amount: r.Amount ?? null,
        closeDate: r.CloseDate ?? null,
        stage: stageApiToLabel(r.StageName),
        nextStep: r.NextStep ?? null,
        nextStepDate: r.Next_Step_Date__c ?? null,
        isClosed: r.IsClosed ?? false,
        oppType: r.Type ?? null,
        netAcv: r.Net_MCV__c ?? null,
        nextContractEndDate: r.Account?.Next_Contract_End_Date__c ?? null,
        nextRenewalDate: r.Account?.Next_Renewal_Date__c ?? null,
        hasAutoRenewal: r.Account?.Has_Auto_Renewal_on_next_Renewal_Opp__c ?? null,
      })
    }
    return { map, sfdcOk: true }
  } catch (err) {
    console.warn('[RepPortal] Could not fetch live opp meta from SFDC:', err)
    return { map, sfdcOk: false }
  }
}

// GET /api/rep/me?token=xxx
router.get('/me', async (req, res) => {
  const { token } = req.query as { token?: string }
  if (!token) return res.status(400).json({ error: 'Missing token' })

  try {
    const { slackUserId } = verifyRepToken(token)
    const user = await db.user.findUnique({ where: { slackUserId } })
    if (!user) return res.status(404).json({ error: 'User not found' })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await (db as any).notification.findMany({
      where: { ownerId: user.id, status: { in: ['SENT', 'SNOOZED'] } },
      orderBy: { sentAt: 'desc' },
      select: { id: true, opportunityId: true, opportunityName: true, alertType: true, alertDetails: true, status: true, sentAt: true, snoozedUntil: true },
    })

    // Deduplicate: one notification per opportunityId+alertType, newest first
    const seen = new Set<string>()
    const deduped = (raw as { id: string; opportunityId: string; opportunityName: string; alertType: string; alertDetails: unknown; status: string; sentAt: Date | null; snoozedUntil: Date | null }[])
      .filter((n) => {
        const key = `${n.opportunityId}|${n.alertType}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

    // Load pending flags first so we can include their opp IDs in the SFDC meta fetch
    let rawPending: { opportunityId: string; opportunityName: string; alertType: string; ownerEmail: string; details: Record<string, unknown> }[] = []
    try {
      const setting = await db.appSetting.findUnique({ where: { key: 'lastDryRunFullResults' } })
      if (setting?.value) {
        const dryRun = JSON.parse(setting.value) as { wouldSend: typeof rawPending }
        const repEmail = user.slackEmail?.toLowerCase()
        if (repEmail) {
          rawPending = (dryRun.wouldSend ?? []).filter((a) => a.ownerEmail?.toLowerCase() === repEmail)
        }
      }
    } catch { /* non-fatal */ }

    // Fetch rep's Salesforce UserRole.Name. Non-fatal for the Pipeline tab, but
    // it decides tab visibility, so track whether the lookup actually succeeded.
    const roleLookup = user.slackEmail
      ? await fetchRepRole(user.slackEmail)
      : ({ ok: true, role: null } as const)
    const repRole = roleLookup.ok ? roleLookup.role : null
    const roleLookupFailed = !roleLookup.ok

    // Fetch live opp data from SFDC for ALL opp IDs (notifications + pending)
    // Using SFDC's native IsClosed field — reliable across custom stage names
    const dedupedOppIds = [...new Set(deduped.map((n) => n.opportunityId))]
    const pendingOppIds = [...new Set(rawPending.map((a) => a.opportunityId))]
    const allOppIds = [...new Set([...dedupedOppIds, ...pendingOppIds])]
    const { map: oppMeta, sfdcOk } = await fetchOppMeta(allOppIds)

    // Identify closed opp IDs:
    // - Opps explicitly marked IsClosed=true in SFDC
    // - Opps completely absent from SFDC (deleted) — only when SFDC call succeeded
    const closedOppIds = new Set<string>()
    for (const id of allOppIds) {
      const meta = oppMeta.get(id)
      if (meta?.isClosed) {
        closedOppIds.add(id)
      } else if (sfdcOk && !meta) {
        // Not returned by SFDC at all — opp was deleted or otherwise gone
        closedOppIds.add(id)
      }
    }

    // Auto-resolve DB notifications for closed/deleted opps
    if (closedOppIds.size > 0) {
      const closedArr = [...closedOppIds]
      await db.notification.updateMany({
        where: { opportunityId: { in: closedArr }, ownerId: user.id, status: { in: ['SENT', 'SNOOZED'] } },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      })
      console.log(`[RepPortal] Auto-resolved notifications for ${closedOppIds.size} closed/deleted opps for user ${user.id}`)
    }

    // Filter out closed opps from DB notifications
    const openDeduped = deduped.filter((n) => !closedOppIds.has(n.opportunityId))

    const notifications = openDeduped.map((n) => {
      const meta = oppMeta.get(n.opportunityId)
      const details = (n.alertDetails as Record<string, unknown>) ?? {}
      return {
        ...n,
        alertDetails: {
          ...details,
          // Overlay with live SFDC data (always current)
          ...(meta ?? {}),
        },
        sfdcUrl: `${SFDC_BASE}/lightning/r/Opportunity/${n.opportunityId}/view`,
        sentAt: n.sentAt?.toISOString() ?? null,
        snoozedUntil: n.snoozedUntil?.toISOString() ?? null,
      }
    })

    // Build pending — filtered to exclude closed opps and already-active notification keys
    const notifOppAlertKeys = new Set(notifications.filter(n => n.status === 'SENT').map(n => `${n.opportunityId}|${n.alertType}`))
    const pending = rawPending
      .filter((a) => !closedOppIds.has(a.opportunityId) && !notifOppAlertKeys.has(`${a.opportunityId}|${a.alertType}`))
      .slice(0, 10)

    res.json({
      rep: {
        name: user.slackName ?? user.slackEmail ?? 'Rep',
        email: user.slackEmail,
        repRole,
        // Tab visibility is decided server-side so the role-parsing rules live in
        // exactly one place. Territory Cleanup is New Business AEs only;
        // Whitespace is existing-customer roles only (AM / CSM / Partner AM).
        showTerritoryCleanup: isAccountExecutive(repRole),
        showWhitespace: isExistingBusiness(repRole),
        // True when Salesforce couldn't be reached, so the portal can say "tabs
        // are missing because we couldn't check your role" rather than implying
        // the rep isn't allowed in.
        roleLookupFailed,
      },
      notifications,
      pending,
    })
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired link — ask RevBot for a fresh one' })
  }
})

// POST /api/rep/snooze
// Body: { token, notificationId, days } OR { token, notificationId, snoozeUntil: ISO string }
router.post('/snooze', async (req, res) => {
  const { token, notificationId, days, snoozeUntil } = req.body as {
    token?: string; notificationId?: string; days?: number; snoozeUntil?: string
  }
  if (!token || !notificationId || (!days && !snoozeUntil)) return res.status(400).json({ error: 'Missing fields' })

  try {
    const { slackUserId } = verifyRepToken(token)
    const user = await db.user.findUnique({ where: { slackUserId } })
    if (!user) return res.status(404).json({ error: 'User not found' })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notif = await (db as any).notification.findFirst({
      where: { id: notificationId, ownerId: user.id, status: { in: ['SENT', 'SNOOZED'] } },
    })
    if (!notif) return res.status(404).json({ error: 'Notification not found' })

    const snoozedUntil = snoozeUntil
      ? new Date(snoozeUntil)
      : new Date(Date.now() + (days ?? 7) * 24 * 60 * 60 * 1000)

    await db.notification.update({
      where: { id: notificationId },
      data: { status: 'SNOOZED', snoozedUntil },
    })

    res.json({ ok: true, snoozedUntil: snoozedUntil.toISOString() })
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired link' })
  }
})

// POST /api/rep/update-close-date
router.post('/update-close-date', async (req, res) => {
  const { token, opportunityId, closeDate } = req.body as {
    token?: string; opportunityId?: string; closeDate?: string
  }
  if (!token || !opportunityId || !closeDate) return res.status(400).json({ error: 'Missing fields' })

  try {
    const { slackUserId } = verifyRepToken(token)
    const user = await db.user.findUnique({ where: { slackUserId } })
    if (!user) return res.status(404).json({ error: 'User not found' })

    const conn = await getServiceConnection()
    await conn.sobject('Opportunity').update({ Id: opportunityId, CloseDate: closeDate })

    await db.notification.updateMany({
      where: { opportunityId, ownerId: user.id, status: { in: ['SENT', 'SNOOZED'] } },
      data: { status: 'RESOLVED', resolvedAt: new Date(), sfdcUpdatedAt: new Date(), sfdcUpdateFields: { CloseDate: closeDate } as never },
    })

    res.json({ ok: true })
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired link' })
  }
})

// POST /api/rep/update-next-step
router.post('/update-next-step', async (req, res) => {
  const { token, opportunityId, nextStep, nextStepDate } = req.body as {
    token?: string; opportunityId?: string; nextStep?: string; nextStepDate?: string
  }
  if (!token || !opportunityId) return res.status(400).json({ error: 'Missing fields' })

  try {
    const { slackUserId } = verifyRepToken(token)
    const user = await db.user.findUnique({ where: { slackUserId } })
    if (!user) return res.status(404).json({ error: 'User not found' })

    const fields: Record<string, unknown> = {}
    if (nextStep?.trim()) fields.NextStep = nextStep.trim()
    if (nextStepDate) fields.Next_Step_Date__c = nextStepDate

    if (!Object.keys(fields).length) return res.status(400).json({ error: 'Provide nextStep or nextStepDate' })

    const conn = await getServiceConnection()
    await conn.sobject('Opportunity').update({ Id: opportunityId, ...fields })

    await db.notification.updateMany({
      where: { opportunityId, ownerId: user.id, alertType: 'NEXT_STEP_MISSING', status: { in: ['SENT', 'SNOOZED'] } },
      data: { status: 'RESOLVED', resolvedAt: new Date(), sfdcUpdatedAt: new Date(), sfdcUpdateFields: fields as never },
    })

    res.json({ ok: true })
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired link' })
  }
})

// POST /api/rep/recheck — re-evaluate alerts for this rep using cached data
router.post('/recheck', async (req, res) => {
  const { token } = req.body as { token?: string }
  if (!token) return res.status(400).json({ error: 'Missing token' })

  try {
    const { slackUserId } = verifyRepToken(token)
    const user = await db.user.findUnique({ where: { slackUserId } })
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (!user.slackEmail) return res.status(400).json({ error: 'No email on record' })

    const result = await recheckForRep(user.slackEmail)
    res.json(result)
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired link' })
  }
})

// GET /api/rep/whitespace?token=...
router.get('/whitespace', async (req, res) => {
  const { token } = req.query as { token?: string }
  if (!token) return res.status(400).json({ error: 'Missing token' })

  try {
    const { slackUserId } = verifyRepToken(token)
    const user = await db.user.findUnique({ where: { slackUserId } })
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (!user.slackEmail) return res.status(400).json({ error: 'No email on record' })

    // Whitespace is for reps who own existing customers. New Business roles are
    // excluded — the query below filters out accounts they own anyway, so they'd
    // only ever see an empty list.
    const wsLookup = await fetchRepRole(user.slackEmail)
    if (!wsLookup.ok) {
      const { status, body } = roleUnavailable(wsLookup.error)
      return res.status(status).json(body)
    }
    if (!isExistingBusiness(wsLookup.role)) {
      return res.status(403).json({
        error: 'Whitespace is only available to reps with existing business accounts',
        repRole: wsLookup.role,
      })
    }

    const repEmail = user.slackEmail

    const conn = await getServiceConnection()
    const soql = `
      SELECT Id, Name, Product_Coverage_Name__c, Account__c, Account__r.Name,
             Account__r.Next_Contract_End_Date__c,
             Current_Status__c, Fit_Use_Case__c, Current_Locations_Covered__c,
             Total_Locations_Fit__c, ARR_Potential__c, Priority__c, Price_per_location__c
      FROM Product_Coverage__c
      WHERE Current_Status__c = 'Has'
        AND (Total_Locations_Fit__c = null OR Total_Locations_Fit__c = 0)
        AND Account__r.RecordType.Name = 'Enterprise Account Record'
        AND Price_per_location__c > 0
        AND (NOT Account__r.Owner.UserRole.Name LIKE '%partner%')
        AND (NOT Account__r.Owner.UserRole.Name LIKE '%new business%')
        AND (NOT Product_Coverage_Name__c LIKE '%pull api%')
        AND (NOT Product_Coverage_Name__c LIKE '%services%')
        AND (NOT Product_Coverage_Name__c LIKE '%minimum commit%')
        AND (NOT Product_Coverage_Name__c LIKE '%package%')
        AND (NOT Product_Coverage_Name__c LIKE '%standalone%')
        AND (NOT Product_Coverage_Name__c LIKE '%fee%')
        AND (NOT Product_Coverage_Name__c LIKE '%bundle%')
        AND (NOT Product_Coverage_Name__c LIKE '%additional%')
        AND Account__r.Owner.Email = '${repEmail}'
      ORDER BY Account__r.Name ASC
    `.trim()

    const url = `${conn.instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`
    const resp = await axios.get<{
      records: {
        Id: string
        Name: string
        Product_Coverage_Name__c: string | null
        Account__c: string
        Account__r: { Name: string; Next_Contract_End_Date__c: string | null } | null
        Current_Status__c: string | null
        Fit_Use_Case__c: string | null
        Current_Locations_Covered__c: number | null
        Total_Locations_Fit__c: number | null
        ARR_Potential__c: number | null
        Priority__c: string | null
      }[]
    }>(url, { headers: { Authorization: `Bearer ${conn.accessToken!}` }, timeout: 15_000 })

    const accountMap = new Map<string, { accountId: string; accountName: string; lines: unknown[] }>()

    for (const r of resp.data.records) {
      const accountId = r.Account__c
      const accountName = r.Account__r?.Name ?? accountId

      if (!accountMap.has(accountId)) {
        accountMap.set(accountId, { accountId, accountName, lines: [] })
      }

      accountMap.get(accountId)!.lines.push({
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
      })
    }

    const records = Array.from(accountMap.values())
    res.json({ records })
  } catch (err) {
    console.error('[RepPortal] /whitespace GET error:', err)
    res.status(401).json({ error: 'Invalid or expired link — ask RevBot for a fresh one' })
  }
})

// PATCH /api/rep/whitespace/:id
router.patch('/whitespace/:id', async (req, res) => {
  const { id } = req.params
  const { token, totalLocationsFit } = req.body as { token?: string; totalLocationsFit?: number }

  if (!token) return res.status(400).json({ error: 'Missing token' })
  if (totalLocationsFit === undefined || totalLocationsFit === null) {
    return res.status(400).json({ error: 'totalLocationsFit is required' })
  }

  try {
    const { slackUserId } = verifyRepToken(token)
    const user = await db.user.findUnique({ where: { slackUserId } })
    if (!user) return res.status(404).json({ error: 'User not found' })

    // Same gate as the GET — this one writes to Salesforce, so it matters more.
    if (!user.slackEmail) return res.status(400).json({ error: 'No email on record' })
    const wsLookup = await fetchRepRole(user.slackEmail)
    if (!wsLookup.ok) {
      const { status, body } = roleUnavailable(wsLookup.error)
      return res.status(status).json(body)
    }
    if (!isExistingBusiness(wsLookup.role)) {
      return res.status(403).json({
        error: 'Whitespace is only available to reps with existing business accounts',
        repRole: wsLookup.role,
      })
    }

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
    console.error('[RepPortal] /whitespace PATCH error:', err)
    res.status(401).json({ error: 'Invalid or expired link' })
  }
})

// ── Admin: generate a magic link for any rep (by email or slackUserId) ───────
// POST /api/rep/admin/generate-link  — requires admin JWT

// ─── Territory Cleanup ───────────────────────────────────────────────────────

/**
 * Look up a rep's SFDC UserRole.Name.
 *
 * Role now decides which tabs a rep sees, so "Salesforce was unreachable" and
 * "this rep genuinely has no/another role" must not collapse into the same
 * answer. Swallowing the error would silently strip tabs from legitimate users
 * whenever the SFDC token expires — which looks identical to a permissions
 * problem and is miserable to debug.
 */
type RepRoleLookup =
  | { ok: true; role: string | null }
  | { ok: false; error: string }

async function fetchRepRole(email: string): Promise<RepRoleLookup> {
  try {
    const conn = await getServiceConnection()
    const soql = `SELECT UserRole.Name FROM User WHERE Email = '${email.replace(/'/g, "\\'")}' LIMIT 1`
    const url = `${conn.instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`
    const resp = await axios.get<{ records: { UserRole: { Name: string } | null }[] }>(
      url, { headers: { Authorization: `Bearer ${conn.accessToken!}` }, timeout: 10_000 }
    )
    return { ok: true, role: resp.data.records[0]?.UserRole?.Name ?? null }
  } catch (err) {
    const message = (err as Error).message
    console.error(`[RepPortal] role lookup failed for ${email}:`, message)
    return { ok: false, error: `Could not verify your Salesforce role: ${message}` }
  }
}

/** 503, not 403 — the rep may well be authorised; we just couldn't check. */
function roleUnavailable(error: string) {
  return { status: 503, body: { error, roleLookupFailed: true } }
}

type AeRepResult =
  | { ok: true; user: { id: string; slackEmail: string }; repRole: string | null }
  | { ok: false; status: number; body: Record<string, unknown> }

/** Resolve + authorise a rep for the Territory Cleanup tab (AEs only). */
async function resolveAeRep(token: string | undefined): Promise<AeRepResult> {
  if (!token) return { ok: false, status: 400, body: { error: 'Missing token' } }

  let slackUserId: string
  try {
    ({ slackUserId } = verifyRepToken(token))
  } catch {
    return { ok: false, status: 401, body: { error: 'Invalid or expired link — ask RevBot for a fresh one' } }
  }

  const user = await db.user.findUnique({ where: { slackUserId } })
  if (!user) return { ok: false, status: 404, body: { error: 'User not found' } }
  if (!user.slackEmail) return { ok: false, status: 400, body: { error: 'No email on record' } }

  const lookup = await fetchRepRole(user.slackEmail)
  if (!lookup.ok) return { ok: false, ...roleUnavailable(lookup.error) }

  if (!isAccountExecutive(lookup.role)) {
    return {
      ok: false,
      status: 403,
      body: { error: 'Territory Cleanup is only available to New Business AEs', repRole: lookup.role },
    }
  }

  return { ok: true, user: { id: user.id, slackEmail: user.slackEmail }, repRole: lookup.role }
}

// GET /api/rep/territory-cleanup?token=xxx
// The rep's Prospect accounts with no rep communication this year, minus any
// they've already dispositioned.
router.get('/territory-cleanup', async (req, res) => {
  const resolved = await resolveAeRep((req.query as { token?: string }).token)
  if (!resolved.ok) return res.status(resolved.status).json(resolved.body)
  const { user } = resolved

  // Filters come from the UI. Anything unparseable falls back to the default
  // rather than erroring, so a stale bookmarked URL still returns a usable queue.
  const q = req.query as Record<string, string | undefined>
  const num = (v: string | undefined): number | null => {
    if (v === undefined || v.trim() === '') return null
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  const filters = {
    lastCommBefore: q.lastCommBefore?.trim() || null,
    includeBlankLastComm: q.includeBlankLastComm !== 'false',
    minLocations: num(q.minLocations),
    maxLocations: num(q.maxLocations),
  }

  try {
    const [accounts, validated, picklists] = await Promise.all([
      fetchTerritoryAccounts(user.slackEmail, filters),
      db.territoryValidation.findMany({
        where: { repId: user.id },
        select: { accountId: true },
      }),
      getAccountPicklists(),
    ])

    const validatedIds = new Set(validated.map((v) => v.accountId))
    const pending = accounts.filter((a) => !validatedIds.has(a.accountId))

    res.json({
      accounts: pending.map((a) => ({
        ...a,
        sfdcUrl: `${SFDC_BASE}/lightning/r/Account/${a.accountId}/view`,
      })),
      // Both counts are within the current filter, not the whole territory.
      totalInTerritory: accounts.length,
      alreadyValidated: accounts.length - pending.length,
      picklists,
      // Echo what was actually applied so the UI can show the effective date when
      // the rep hasn't picked one.
      appliedFilters: resolveTerritoryFilters(filters),
    })
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.error('[TerritoryCleanup] GET failed:', message)
    res.status(500).json({ error: message })
  }
})

// POST /api/rep/territory-cleanup/disposition
router.post('/territory-cleanup/disposition', async (req, res) => {
  const body = req.body as {
    token?: string
    accountId?: string
    accountName?: string
    disposition?: string
    subReason?: string | null
    feedback?: string | null
    industry?: string | null
    subIndustry?: string | null
    parentId?: string | null
    numberOfLocations?: number | null
    icpIppFitRating?: string | null
    operatingModel?: string | null
  }

  const resolved = await resolveAeRep(body.token)
  if (!resolved.ok) return res.status(resolved.status).json(resolved.body)
  const { user } = resolved

  if (!body.accountId) return res.status(400).json({ error: 'Missing accountId' })
  if (!DISPOSITIONS.includes(body.disposition as Disposition)) {
    return res.status(400).json({ error: `Invalid disposition. Expected one of: ${DISPOSITIONS.join(', ')}` })
  }
  const disposition = body.disposition as Disposition

  let subReason: NoIcpSubReason | null = null
  if (disposition === 'NO_ICP') {
    if (!NO_ICP_SUB_REASONS.includes(body.subReason as NoIcpSubReason)) {
      return res.status(400).json({ error: `NO_ICP requires a subReason: ${NO_ICP_SUB_REASONS.join(', ')}` })
    }
    subReason = body.subReason as NoIcpSubReason
  }

  // "Other" is meaningless without an explanation.
  if (disposition === 'OTHER' && !body.feedback?.trim()) {
    return res.status(400).json({ error: 'Please add a note explaining the reason' })
  }

  // Keeping an account means validating its operating model. Checked against the
  // live picklist rather than a hardcoded list so the two can't drift apart.
  let operatingModel: string | null = null
  if (disposition === 'GOOD_LEAVE_IN_TERRITORY') {
    const picked = body.operatingModel?.trim()
    if (!picked) {
      return res.status(400).json({ error: 'Please confirm the operating model' })
    }
    const { operatingModel: allowed } = await getAccountPicklists()
    if (!allowed.includes(picked)) {
      return res.status(400).json({
        error: `Invalid operating model. Expected one of: ${allowed.join(', ')}`,
      })
    }
    operatingModel = picked
  }

  try {
    const result = await applyDisposition(
      body.accountId,
      body.accountName ?? body.accountId,
      { id: user.id, email: user.slackEmail },
      {
        disposition,
        subReason,
        feedback: body.feedback ?? null,
        industry: body.industry ?? null,
        subIndustry: body.subIndustry ?? null,
        parentId: body.parentId ?? null,
        numberOfLocations: body.numberOfLocations ?? null,
        icpIppFitRating: body.icpIppFitRating ?? null,
        operatingModel,
      },
    )

    // The validation is recorded either way; surface the SFDC failure so the rep
    // knows their answer was saved but Salesforce wasn't updated.
    if (!result.ok) {
      return res.status(502).json({ error: `Saved your answer, but the Salesforce update failed: ${result.error}`, fields: result.fields })
    }
    res.json({ ok: true, fields: result.fields })
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.error('[TerritoryCleanup] disposition failed:', message)
    res.status(500).json({ error: message })
  }
})

router.post('/admin/generate-link', requireAdmin, async (req, res) => {
  const { email, slackUserId } = req.body as { email?: string; slackUserId?: string }
  if (!email && !slackUserId) return res.status(400).json({ error: 'Provide email or slackUserId' })

  const user = await db.user.findFirst({
    where: email ? { slackEmail: email } : { slackUserId: slackUserId! },
  })
  if (!user) return res.status(404).json({ error: 'User not found' })
  if (!user.slackUserId) return res.status(400).json({ error: 'User has no Slack ID on record' })

  const token = generateRepToken(user.slackUserId)

  res.json({ token, name: user.slackName ?? user.slackEmail, expiresIn: '30d' })
})

export default router
