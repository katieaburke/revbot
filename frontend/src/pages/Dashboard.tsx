import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import {
  AlertCircle, Clock, BellOff, CheckCircle, RefreshCw, Play, X,
  ExternalLink, ChevronDown, ArrowRight, Building2, Shield,
  MessageSquare, UserCheck,
} from 'lucide-react'
import clsx from 'clsx'

// ── Types ─────────────────────────────────────────────────────────────────────

type SkipType = 'cooldown' | 'snoozed_owner' | 'snoozed_revops'

interface DryRunAlert {
  alertType: string
  opportunityId: string
  opportunityName: string
  accountName: string | null
  opportunityType: string | null
  salesChannel: string | null
  salesFunction: string | null
  salesRegion: string | null
  ownerEmail: string
  ownerName: string | null
  ownerSlackId: string | null
  managerEmail: string | null
  managerName: string | null
  managerSlackId: string | null
  wouldSkip: boolean
  skipReason?: string
  skipType?: SkipType
  details: Record<string, unknown>
}

interface DryRunResult {
  timestamp?: string
  totalOpportunities: number
  wouldSend: DryRunAlert[]
  wouldSkip: DryRunAlert[]
  unreachable: DryRunAlert[]
  resolved: Array<{
    opportunityId: string
    opportunityName: string
    alertType: string
    resolveReason: 'opp_closed' | 'flag_cleared'
    ownerEmail?: string
    managerEmail?: string | null
  }>
  stallRulesActive: number
  meddpiccStagesActive: number
}

interface OppGroup {
  opportunityId: string
  opportunityName: string
  accountName: string | null
  opportunityType: string | null
  salesChannel: string | null
  salesFunction: string | null
  salesRegion: string | null
  ownerEmail: string
  ownerName: string | null
  managerEmail: string | null
  managerName: string | null
  managerSlackId: string | null
  alerts: DryRunAlert[]
}

type OppCount = {
  rep: number
  manager: number
  lastSentRep?: string
  lastSentMgr?: string
  snoozedRepUntil?: string
  snoozedMgrUntil?: string
}

interface AppSettings {
  sfdcInstanceUrl?: string
}

interface ProspectingFlag {
  flagType: string
}

interface HygieneResult {
  totalAccounts: number
  flags: ProspectingFlag[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function groupByOpp(alerts: DryRunAlert[]): OppGroup[] {
  const map = new Map<string, OppGroup>()
  for (const a of alerts) {
    if (!map.has(a.opportunityId)) {
      map.set(a.opportunityId, {
        opportunityId: a.opportunityId,
        opportunityName: a.opportunityName,
        accountName: a.accountName,
        opportunityType: a.opportunityType,
        salesChannel: a.salesChannel,
        salesFunction: a.salesFunction,
        salesRegion: a.salesRegion,
        ownerEmail: a.ownerEmail,
        ownerName: a.ownerName,
        managerEmail: a.managerEmail,
        managerName: a.managerName,
        managerSlackId: a.managerSlackId,
        alerts: [],
      })
    }
    map.get(a.opportunityId)!.alerts.push(a)
  }
  return Array.from(map.values())
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

const SNOOZE_OPTIONS = [
  { label: '3 days', days: 3 },
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
  { label: '1 month', days: 30 },
]

const MEDDPICC_KEYS = new Set(['metrics', 'economicBuyer', 'decisionCriteria', 'decisionProcess', 'identifyPain', 'champion', 'competition', 'paperProcess'])
const BANT_KEYS = new Set(['budget', 'authority', 'need', 'timing'])

function getAlertTags(alert: DryRunAlert): { label: string; color: string }[] {
  switch (alert.alertType) {
    case 'PAST_DUE_INITIAL':
    case 'PAST_DUE_AMENDMENT':
      return [{ label: 'Past Due Close Date', color: 'text-red-600 bg-red-50' }]
    case 'PAST_DUE_RENEWAL':
      return [{ label: 'Past Due Booking Date', color: 'text-red-600 bg-red-50' }]
    case 'STALLED': {
      const nsd = alert.details.nextStepDate as string | null | undefined
      const daysOverdue = nsd
        ? Math.floor((Date.now() - new Date(nsd).getTime()) / 86_400_000)
        : null
      const label = daysOverdue !== null && daysOverdue > 0
        ? `Zombie Pipeline (next step ${daysOverdue}d past due)`
        : 'Zombie Pipeline'
      return [{ label, color: 'text-yellow-700 bg-yellow-50' }]
    }
    case 'CLOSE_DATE_RISK':
      return [{ label: 'Close Date Risk', color: 'text-rose-600 bg-rose-50' }]
    case 'STAGE_MISMATCH':
      return [{ label: 'Stage Mismatch', color: 'text-violet-600 bg-violet-50' }]
    case 'NEXT_STEP_MISSING': {
      const issues = (alert.details.issues as string[] | undefined) ?? []
      const tags: { label: string; color: string }[] = []
      if (issues.includes('past_date'))
        tags.push({ label: 'Past Due Next Step', color: 'text-orange-600 bg-orange-50' })
      if (issues.includes('missing_text'))
        tags.push({ label: 'Missing Next Step', color: 'text-teal-600 bg-teal-50' })
      if (issues.includes('missing_date'))
        tags.push({ label: 'Missing Next Step Date', color: 'text-sky-600 bg-sky-50' })
      return tags.length ? tags : [{ label: 'Missing Next Step', color: 'text-teal-600 bg-teal-50' }]
    }
    case 'MEDDPICC_MISSING': {
      const missing = (alert.details.missingFields as string[] | undefined) ?? []
      const tags: { label: string; color: string }[] = []
      if (missing.some((f) => MEDDPICC_KEYS.has(f)))
        tags.push({ label: 'Missing MEDDPICC', color: 'text-purple-600 bg-purple-50' })
      if (missing.some((f) => BANT_KEYS.has(f)))
        tags.push({ label: 'Missing BANT', color: 'text-violet-600 bg-violet-50' })
      return tags.length ? tags : [{ label: 'Missing MEDDPICC / BANT', color: 'text-purple-600 bg-purple-50' }]
    }
    default:
      return [{ label: alert.alertType, color: 'bg-gray-100 text-gray-600' }]
  }
}

type DrawerCategory = 'wouldSend' | 'cooldown' | 'snoozedRevops' | 'snoozedOwner' | 'resolved'

// ── Dashboard ─────────────────────────────────────────────────────────────────

export function Dashboard() {
  const qc = useQueryClient()
  const navigate = useNavigate()

  const [dryRunOverride, setDryRunOverride] = useState<DryRunResult | null>(null)
  const [dryRunError, setDryRunError] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<DrawerCategory | null>(null)

  // Drawer-level action state
  const [snoozeOpenOppId, setSnoozeOpenOppId] = useState<string | null>(null)
  const [sentOppIds, setSentOppIds] = useState<Set<string>>(new Set())
  const [managerSentOppIds, setManagerSentOppIds] = useState<Set<string>>(new Set())

  const { data: lastDryRun } = useQuery<DryRunResult | null>({
    queryKey: ['last-dry-run'],
    queryFn: () => api.get('/notifications/last-dry-run').then((r) => r.data),
  })

  const { data: settings } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: () => api.get('/config/settings').then((r) => r.data),
  })

  // Read prospecting from cache only — do not auto-fetch
  const prospectingData = qc.getQueryData<HygieneResult>(['prospecting-hygiene'])

  const dryRunResult = dryRunOverride ?? lastDryRun ?? null

  const allDryRunOppIds = useMemo(() => {
    if (!dryRunResult) return []
    const ids = new Set([
      ...dryRunResult.wouldSend.map((a) => a.opportunityId),
      ...dryRunResult.wouldSkip.map((a) => a.opportunityId),
      ...dryRunResult.unreachable.map((a) => a.opportunityId),
      ...(dryRunResult.resolved ?? []).map((r) => r.opportunityId),
    ])
    return Array.from(ids)
  }, [dryRunResult])

  const { data: oppCounts = {} } = useQuery<Record<string, OppCount>>({
    queryKey: ['opp-counts', allDryRunOppIds],
    queryFn: () =>
      allDryRunOppIds.length
        ? api.get(`/notifications/opp-counts?oppIds=${allDryRunOppIds.join(',')}`).then((r) => r.data)
        : Promise.resolve({}),
    enabled: allDryRunOppIds.length > 0,
  })

  const sfdcBase = settings?.sfdcInstanceUrl?.replace(/\/$/, '') ?? ''

  function moveOppToSkipped(oppId: string, skipReason: string, skipType?: SkipType) {
    setDryRunOverride((prev) => {
      const base = prev ?? lastDryRun
      if (!base) return prev
      const moving = base.wouldSend
        .filter((a) => a.opportunityId === oppId)
        .map((a) => ({ ...a, wouldSkip: true, skipReason, skipType: skipType ?? a.skipType }))
      if (!moving.length) return prev
      return {
        ...base,
        wouldSend: base.wouldSend.filter((a) => a.opportunityId !== oppId),
        wouldSkip: [...base.wouldSkip, ...moving],
      }
    })
  }

  const dryRun = useMutation({
    mutationFn: () => api.post('/notifications/dry-run').then((r) => r.data as DryRunResult),
    onSuccess: (data) => {
      setDryRunOverride(data)
      setDryRunError(null)
      qc.invalidateQueries({ queryKey: ['last-dry-run'] })
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? String(err)
      setDryRunError(msg)
    },
  })

  const sendDraft = useMutation({
    mutationFn: (g: OppGroup) =>
      api.post('/notifications/send-draft', {
        opportunityId: g.opportunityId,
        opportunityName: g.opportunityName,
        ownerSlackId: g.alerts[0]?.ownerSlackId,
        ownerEmail: g.ownerEmail,
        alerts: g.alerts.map((a) => ({ alertType: a.alertType, details: a.details })),
      }),
    onSuccess: (_data, g) => {
      setSentOppIds((prev) => new Set([...prev, g.opportunityId]))
      qc.invalidateQueries({ queryKey: ['opp-counts'] })
      moveOppToSkipped(g.opportunityId, 'Recently notified', 'cooldown')
    },
  })

  const revopsSnooze = useMutation({
    mutationFn: ({ g, snoozeUntil }: { g: OppGroup; snoozeUntil: Date }) =>
      api
        .post('/notifications/revops-snooze', {
          opportunityId: g.opportunityId,
          opportunityName: g.opportunityName,
          alertTypes: g.alerts.map((a) => a.alertType),
          ownerSlackId: g.alerts[0]?.ownerSlackId ?? null,
          ownerEmail: g.ownerEmail,
          snoozeUntil: snoozeUntil.toISOString(),
        })
        .then((r) => r.data as { snoozedUntil: string }),
    onSuccess: (data, { g }) => {
      setSnoozeOpenOppId(null)
      const until = new Date(data.snoozedUntil).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      moveOppToSkipped(g.opportunityId, `RevOps snoozed until ${until}`, 'snoozed_revops')
      qc.invalidateQueries({ queryKey: ['opp-counts'] })
    },
  })

  const notifyManager = useMutation({
    mutationFn: (g: OppGroup) =>
      api.post('/notifications/notify-manager', {
        opportunityId: g.opportunityId,
        opportunityName: g.opportunityName,
        ownerName: g.ownerName ?? g.ownerEmail,
        ownerEmail: g.ownerEmail,
        ownerSlackId: g.alerts[0]?.ownerSlackId ?? null,
        managerSlackId: g.managerSlackId,
        alerts: g.alerts.map((a) => ({ alertType: a.alertType, details: a.details })),
      }),
    onSuccess: (_data, g) => {
      setManagerSentOppIds((prev) => new Set([...prev, g.opportunityId]))
      qc.invalidateQueries({ queryKey: ['opp-counts'] })
      moveOppToSkipped(g.opportunityId, 'Manager notified', 'cooldown')
    },
  })

  // ── Derived counts ──────────────────────────────────────────────────────────

  const wouldSendGroups = dryRunResult ? groupByOpp(dryRunResult.wouldSend) : []
  const cooldownGroups = dryRunResult
    ? groupByOpp(dryRunResult.wouldSkip.filter((a) => a.skipType === 'cooldown' || !a.skipType))
    : []
  const snoozedRevopsGroups = dryRunResult
    ? groupByOpp(dryRunResult.wouldSkip.filter((a) => a.skipType === 'snoozed_revops'))
    : []
  const snoozedOwnerGroups = dryRunResult
    ? groupByOpp(dryRunResult.wouldSkip.filter((a) => a.skipType === 'snoozed_owner'))
    : []
  const resolvedCount = dryRunResult ? (dryRunResult.resolved ?? []).length : 0

  // Prospecting counts from cache
  const staleAccountCount = prospectingData
    ? prospectingData.flags.filter((f) => f.flagType === 'STALE').length
    : null
  const shouldProspectCount = prospectingData
    ? prospectingData.flags.filter((f) => f.flagType === 'SHOULD_PROSPECT').length
    : null

  // ── Drawer groups ───────────────────────────────────────────────────────────

  function getDrawerGroups(): OppGroup[] {
    if (!dryRunResult) return []
    switch (drawer) {
      case 'wouldSend':
        return groupByOpp(dryRunResult.wouldSend)
      case 'cooldown':
        return groupByOpp(dryRunResult.wouldSkip.filter((a) => a.skipType === 'cooldown' || !a.skipType))
      case 'snoozedRevops':
        return groupByOpp(dryRunResult.wouldSkip.filter((a) => a.skipType === 'snoozed_revops'))
      case 'snoozedOwner':
        return groupByOpp(dryRunResult.wouldSkip.filter((a) => a.skipType === 'snoozed_owner'))
      case 'resolved':
        return []
      default:
        return []
    }
  }

  function getDrawerTitle(): string {
    switch (drawer) {
      case 'wouldSend': return 'Would Send'
      case 'cooldown': return 'In Cooldown'
      case 'snoozedRevops': return 'Snoozed (RevOps)'
      case 'snoozedOwner': return 'Snoozed (Rep)'
      case 'resolved': return 'Resolved'
      default: return ''
    }
  }

  function getDrawerCount(): number {
    switch (drawer) {
      case 'wouldSend': return wouldSendGroups.length
      case 'cooldown': return cooldownGroups.length
      case 'snoozedRevops': return snoozedRevopsGroups.length
      case 'snoozedOwner': return snoozedOwnerGroups.length
      case 'resolved': return resolvedCount
      default: return 0
    }
  }

  function fmtDate(iso: string | undefined | null) {
    if (!iso) return ''
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  const drawerGroups = getDrawerGroups()

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="p-8 max-w-5xl">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Beacon</h1>
            <p className="text-sm text-gray-500 mt-1">RevOps command center</p>
          </div>
          <div className="flex items-center gap-3">
            {lastDryRun?.timestamp && (
              <span className="text-xs text-gray-400">
                Last scan:{' '}
                {new Date(lastDryRun.timestamp).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            )}
            <button
              onClick={() => { setDryRunError(null); dryRun.mutate() }}
              disabled={dryRun.isPending}
              className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50"
            >
              {dryRun.isPending ? <RefreshCw size={15} className="animate-spin" /> : <Play size={15} />}
              Run Scan
            </button>
          </div>
        </div>

        {/* Dry run loading banner */}
        {dryRun.isPending && (
          <div className="mb-6 bg-blue-50 border border-blue-200 rounded-xl p-5 flex items-center gap-4">
            <RefreshCw size={22} className="animate-spin text-blue-500 flex-shrink-0" />
            <div>
              <p className="font-medium text-blue-800 text-sm">Scanning pipeline...</p>
              <p className="text-xs text-blue-600 mt-0.5">Pulling live Salesforce + Gong data — this takes 30–60 seconds</p>
            </div>
            <div className="flex-1 bg-blue-100 rounded-full h-1.5 overflow-hidden">
              <div className="h-1.5 bg-blue-400 rounded-full animate-pulse w-2/3" />
            </div>
          </div>
        )}

        {dryRunError && (
          <div className="mb-6 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            <strong>Scan failed:</strong> {dryRunError}
          </div>
        )}

        {/* ── Pipeline Hygiene ────────────────────────────────────────────── */}
        <SectionLabel title="Pipeline Hygiene" />

        {dryRunResult ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-4 mb-8">
            <MetricCard
              label="Would Send"
              value={wouldSendGroups.length}
              icon={<AlertCircle size={20} />}
              iconClass="text-red-500"
              onClick={() => setDrawer('wouldSend')}
              active={drawer === 'wouldSend'}
            />
            <MetricCard
              label="In Cooldown"
              value={cooldownGroups.length}
              icon={<Clock size={20} />}
              iconClass="text-blue-400"
              onClick={() => setDrawer('cooldown')}
              active={drawer === 'cooldown'}
            />
            <MetricCard
              label="Snoozed (RevOps)"
              value={snoozedRevopsGroups.length}
              icon={<BellOff size={20} />}
              iconClass="text-amber-500"
              onClick={() => setDrawer('snoozedRevops')}
              active={drawer === 'snoozedRevops'}
            />
            <MetricCard
              label="Snoozed (Rep)"
              value={snoozedOwnerGroups.length}
              icon={<BellOff size={20} />}
              iconClass="text-yellow-500"
              onClick={() => setDrawer('snoozedOwner')}
              active={drawer === 'snoozedOwner'}
            />
            <MetricCard
              label="Resolved"
              value={resolvedCount}
              icon={<CheckCircle size={20} />}
              iconClass="text-emerald-500"
              onClick={() => setDrawer('resolved')}
              active={drawer === 'resolved'}
            />
          </div>
        ) : (
          <div className="mt-4 mb-8 bg-white rounded-2xl border border-gray-200 p-8 text-center">
            <Play size={28} className="mx-auto mb-3 text-gray-300" />
            <p className="font-medium text-gray-500 mb-1">Run a scan to see pipeline health</p>
            <p className="text-xs text-gray-400">Click "Run Scan" above to pull live data from Salesforce</p>
          </div>
        )}

        {/* ── Prospecting Management ──────────────────────────────────────── */}
        <SectionLabel title="Prospecting Management" />

        <div className="grid grid-cols-3 gap-3 mt-4 mb-8">
          <MetricCard
            label="Stale Accounts"
            value={staleAccountCount}
            icon={<Building2 size={20} />}
            iconClass="text-orange-400"
          />
          <MetricCard
            label="Should Be Prospecting"
            value={shouldProspectCount}
            icon={<AlertCircle size={20} />}
            iconClass="text-red-400"
          />
          <LinkCard
            label="View details"
            to="/playbook/accounts"
            description="Prospecting hygiene"
          />
        </div>

        {/* ── Territory Management ────────────────────────────────────────── */}
        <SectionLabel title="Territory Management" />

        <div className="grid grid-cols-3 gap-3 mt-4 mb-8">
          <NavigateCard
            label="New Logos"
            description="Route to Success"
            to="/playbook/territory/newlogos"
            navigate={navigate}
          />
          <NavigateCard
            label="Churned Accounts"
            description="Route to Sales"
            to="/playbook/territory/churned"
            navigate={navigate}
          />
        </div>

        {/* ── Risk & Termination ──────────────────────────────────────────── */}
        <SectionLabel title="Risk & Termination" />

        <div className="mt-4 mb-8 bg-white rounded-2xl border border-gray-200 p-6 flex items-center gap-4">
          <Shield size={22} className="text-gray-300 flex-shrink-0" />
          <p className="text-sm text-gray-400">
            Coming soon — configure risk signals in{' '}
            <Link to="/playbook/accounts" className="text-brand-600 hover:underline">
              Playbook
            </Link>
          </p>
        </div>
      </div>

      {/* ── Drawer backdrop ─────────────────────────────────────────────────── */}
      {drawer && (
        <div
          className="fixed inset-0 bg-black/20 z-30"
          onClick={() => { setDrawer(null); setSnoozeOpenOppId(null) }}
        />
      )}

      {/* ── Drawer ──────────────────────────────────────────────────────────── */}
      {drawer && (
        <div className="fixed right-0 top-0 h-full w-[520px] bg-white shadow-2xl z-40 flex flex-col">
          {/* Drawer header */}
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-gray-900">{getDrawerTitle()}</h2>
              <span className="text-sm text-gray-400 font-medium">{getDrawerCount()}</span>
            </div>
            <div className="flex items-center gap-3">
              <Link
                to="/pipe-hygiene"
                className="text-xs text-brand-600 hover:text-brand-700 flex items-center gap-1"
              >
                Open in Pipe Hygiene <ArrowRight size={12} />
              </Link>
              <button
                onClick={() => { setDrawer(null); setSnoozeOpenOppId(null) }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X size={18} />
              </button>
            </div>
          </div>

          {/* Drawer body */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
            {drawer === 'resolved' && (
              <div className="text-sm text-gray-400 text-center py-8">
                {resolvedCount > 0
                  ? `${resolvedCount} flag${resolvedCount !== 1 ? 's' : ''} resolved this scan — opp closed or flag cleared.`
                  : 'No resolved items this scan.'}
              </div>
            )}

            {drawer !== 'resolved' && drawerGroups.length === 0 && (
              <div className="text-sm text-gray-400 text-center py-8">No items in this category.</div>
            )}

            {drawer !== 'resolved' && drawerGroups.map((g) => {
              const link = sfdcBase ? `${sfdcBase}/lightning/r/Opportunity/${g.opportunityId}/view` : null
              const isSent = sentOppIds.has(g.opportunityId)
              const isMgrSent = managerSentOppIds.has(g.opportunityId)
              const counts = oppCounts[g.opportunityId] ?? { rep: 0, manager: 0 }

              return (
                <div key={g.opportunityId} className="bg-white border border-gray-100 rounded-xl px-4 py-3 hover:bg-gray-50">
                  {/* Opp name + link */}
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="min-w-0">
                      {link ? (
                        <a
                          href={link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-medium text-gray-900 hover:text-brand-600 flex items-center gap-1"
                        >
                          <span className="truncate">{g.opportunityName}</span>
                          <ExternalLink size={11} className="text-gray-400 flex-shrink-0" />
                        </a>
                      ) : (
                        <span className="text-sm font-medium text-gray-900">{g.opportunityName}</span>
                      )}
                      <p className="text-xs text-gray-500 mt-0.5">
                        {g.accountName && <span>{g.accountName} · </span>}
                        <span>{g.ownerName ?? g.ownerEmail}</span>
                        {g.managerName && <span className="text-gray-400"> · mgr: {g.managerName}</span>}
                      </p>
                    </div>
                    {/* Sent count badges */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {counts.rep > 0 && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 font-medium">
                          rep {counts.rep}×
                        </span>
                      )}
                      {counts.manager > 0 && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-600 font-medium">
                          mgr {counts.manager}×
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Alert tags */}
                  <div className="flex items-center gap-1 flex-wrap mb-2">
                    {g.alerts.flatMap((a, i) =>
                      getAlertTags(a).map((tag, j) => (
                        <span key={`${i}-${j}`} className={clsx('text-xs font-medium px-1.5 py-0.5 rounded', tag.color)}>
                          {tag.label}
                        </span>
                      ))
                    )}
                  </div>

                  {/* STALLED next step */}
                  {g.alerts.some((a) => a.alertType === 'STALLED') && (() => {
                    const sa = g.alerts.find((a) => a.alertType === 'STALLED')
                    const ns = sa?.details.nextStep as string | null | undefined
                    const nsd = sa?.details.nextStepDate as string | null | undefined
                    if (!ns && !nsd) return null
                    return (
                      <div className="flex items-start gap-1.5 text-xs text-gray-500 mb-2">
                        <span className="font-medium text-gray-400 shrink-0">Next step:</span>
                        {nsd && <span className="font-medium text-gray-600">{fmtDate(nsd)}</span>}
                        {ns && (
                          <span className="text-gray-400 truncate" title={ns}>
                            · {ns.length > 70 ? ns.slice(0, 70) + '…' : ns}
                          </span>
                        )}
                      </div>
                    )
                  })()}

                  {/* Actions */}
                  <div className="flex items-center gap-1 flex-wrap">
                    {isSent ? (
                      <span className="text-xs text-green-600 font-medium flex items-center gap-1">
                        <CheckCircle size={11} /> Sent
                      </span>
                    ) : (
                      <button
                        onClick={() => sendDraft.mutate(g)}
                        disabled={sendDraft.isPending}
                        className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-brand-600 hover:bg-brand-50"
                      >
                        <MessageSquare size={11} />
                        Send to rep
                      </button>
                    )}

                    {g.managerSlackId && (
                      isMgrSent ? (
                        <span className="text-xs text-green-600 font-medium flex items-center gap-1">
                          <CheckCircle size={11} /> Sent to mgr
                        </span>
                      ) : (
                        <button
                          onClick={() => notifyManager.mutate(g)}
                          disabled={notifyManager.isPending}
                          className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-gray-500 hover:text-gray-800 hover:bg-gray-100"
                          title={`Send to manager (${g.managerName ?? g.managerEmail})`}
                        >
                          <UserCheck size={11} />
                          Send to manager
                        </button>
                      )
                    )}

                    {/* Snooze (only for wouldSend drawer) */}
                    {drawer === 'wouldSend' && (
                      <div className="relative">
                        <button
                          onClick={() =>
                            setSnoozeOpenOppId(snoozeOpenOppId === g.opportunityId ? null : g.opportunityId)
                          }
                          disabled={revopsSnooze.isPending}
                          className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-gray-500 hover:text-amber-700 hover:bg-amber-50"
                        >
                          <BellOff size={11} />
                          Snooze
                          <ChevronDown size={10} />
                        </button>

                        {snoozeOpenOppId === g.opportunityId && (() => {
                          const sa = g.alerts.find((a) => a.alertType === 'STALLED')
                          const nsd = sa?.details.nextStepDate as string | null | undefined
                          const nextStepFuture = nsd && new Date(nsd) > new Date() ? new Date(nsd) : null
                          return (
                            <SnoozeDropdown
                              onSnooze={(until) => {
                                revopsSnooze.mutate({ g, snoozeUntil: until })
                              }}
                              nextStepFuture={nextStepFuture}
                              fmtDate={fmtDate}
                            />
                          )
                        })()}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionLabel({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-3 mb-0">
      <span className="text-xs font-semibold uppercase tracking-widest text-gray-400">{title}</span>
      <div className="flex-1 border-b border-gray-200" />
    </div>
  )
}

function MetricCard({
  label,
  value,
  icon,
  iconClass,
  onClick,
  active,
}: {
  label: string
  value: number | null
  icon: React.ReactNode
  iconClass: string
  onClick?: () => void
  active?: boolean
}) {
  return (
    <div
      className={clsx(
        'bg-white rounded-2xl border border-gray-200 p-5 transition-all',
        onClick && 'cursor-pointer hover:border-brand-300 hover:shadow-sm',
        active && 'border-brand-400 ring-2 ring-brand-200',
      )}
      onClick={onClick}
    >
      <div className={clsx('mb-2', iconClass)}>{icon}</div>
      <div className="text-3xl font-bold text-gray-900">{value !== null ? value : '—'}</div>
      <div className="text-xs text-gray-500 mt-1">{label}</div>
    </div>
  )
}

function LinkCard({ label, to, description }: { label: string; to: string; description: string }) {
  return (
    <Link
      to={to}
      className="bg-white rounded-2xl border border-gray-200 p-5 flex flex-col justify-between hover:border-brand-300 hover:shadow-sm transition-all group"
    >
      <div className="text-xs text-gray-500 mb-1">{description}</div>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-900 group-hover:text-brand-600">{label}</span>
        <ArrowRight size={15} className="text-gray-400 group-hover:text-brand-500" />
      </div>
    </Link>
  )
}

function NavigateCard({
  label,
  description,
  to,
  navigate,
}: {
  label: string
  description: string
  to: string
  navigate: ReturnType<typeof useNavigate>
}) {
  return (
    <div
      className="bg-white rounded-2xl border border-gray-200 p-5 flex flex-col justify-between cursor-pointer hover:border-brand-300 hover:shadow-sm transition-all group"
      onClick={() => navigate(to)}
    >
      <div className="text-xs text-gray-500 mb-1">{description}</div>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-900 group-hover:text-brand-600">{label}</span>
        <ArrowRight size={15} className="text-gray-400 group-hover:text-brand-500" />
      </div>
    </div>
  )
}

function SnoozeDropdown({
  onSnooze,
  nextStepFuture,
  fmtDate,
}: {
  onSnooze: (until: Date) => void
  nextStepFuture: Date | null
  fmtDate: (iso: string | undefined | null) => string
}) {
  const [customDate, setCustomDate] = useState('')

  return (
    <div className="absolute right-0 top-7 z-20 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[180px]">
      <p className="px-3 py-1 text-xs font-medium text-gray-400 uppercase tracking-wide">Snooze until</p>
      {SNOOZE_OPTIONS.map((opt) => (
        <button
          key={opt.days}
          onClick={() => onSnooze(addDays(new Date(), opt.days))}
          className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-amber-50 hover:text-amber-800"
        >
          {opt.label}
          <span className="ml-1 text-gray-400">{fmtDate(addDays(new Date(), opt.days).toISOString())}</span>
        </button>
      ))}
      {nextStepFuture && (
        <button
          onClick={() => onSnooze(addDays(nextStepFuture, 7))}
          className="w-full text-left px-3 py-1.5 text-xs text-blue-700 hover:bg-blue-50 border-t border-gray-100 mt-1 pt-2"
        >
          1 wk after next step
          <span className="ml-1 text-blue-400">{fmtDate(addDays(nextStepFuture, 7).toISOString())}</span>
        </button>
      )}
      <div className="border-t border-gray-100 mt-1 pt-1 px-3 pb-2">
        <p className="text-xs text-gray-400 mb-1">Custom date</p>
        <div className="flex items-center gap-1">
          <input
            type="date"
            value={customDate}
            min={new Date().toISOString().split('T')[0]}
            onChange={(e) => setCustomDate(e.target.value)}
            className="text-xs border border-gray-200 rounded px-1.5 py-1 flex-1 min-w-0"
          />
          <button
            disabled={!customDate}
            onClick={() => {
              const d = new Date(customDate + 'T12:00:00')
              onSnooze(d)
            }}
            className="px-2 py-1 text-xs bg-amber-500 text-white rounded disabled:opacity-40 hover:bg-amber-600"
          >
            Set
          </button>
        </div>
      </div>
    </div>
  )
}

