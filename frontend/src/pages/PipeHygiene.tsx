import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import { api } from '../lib/api'
import {
  Play, RefreshCw, AlertCircle, Clock, CheckCircle, FlaskConical,
  ChevronDown, ChevronUp, ExternalLink, Trash2, MessageSquare, X, Send,
  Briefcase, UserCheck, BellOff, Users, Check,
} from 'lucide-react'
import clsx from 'clsx'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Summary {
  total: number
  sent: number
  snoozed: number
  resolved: number
  byType: { alertType: string; _count: { id: number } }[]
}

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

interface ResolvedItem {
  opportunityId: string
  opportunityName: string
  alertType: string
  resolveReason: 'opp_closed' | 'flag_cleared'
  ownerEmail?: string
  managerEmail?: string | null
}

interface DryRunResult {
  timestamp?: string
  totalOpportunities: number
  wouldSend: DryRunAlert[]
  wouldSkip: DryRunAlert[]
  unreachable: DryRunAlert[]
  resolved: ResolvedItem[]
  stallRulesActive: number
  meddpiccStagesActive: number
}

interface AppSettings {
  sfdcInstanceUrl?: string
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

interface ResolvedGroup {
  opportunityId: string
  opportunityName: string
  items: ResolvedItem[]
}

function groupResolvedByOpp(items: ResolvedItem[]): ResolvedGroup[] {
  const map = new Map<string, ResolvedGroup>()
  for (const item of items) {
    if (!map.has(item.opportunityId)) {
      map.set(item.opportunityId, { opportunityId: item.opportunityId, opportunityName: item.opportunityName, items: [] })
    }
    map.get(item.opportunityId)!.items.push(item)
  }
  return Array.from(map.values())
}

function uniqueVals(groups: OppGroup[], key: keyof OppGroup): string[] {
  return Array.from(new Set(groups.map((g) => g[key] as string | null).filter(Boolean) as string[])).sort()
}

function compareCount(count: number, op: string, val: number): boolean {
  switch (op) {
    case '>=': return count >= val
    case '<=': return count <= val
    case '=':  return count === val
    case '>':  return count > val
    case '<':  return count < val
    default:   return true
  }
}

type OppCount = { rep: number; manager: number; lastSentRep?: string; lastSentMgr?: string; snoozedRepUntil?: string; snoozedMgrUntil?: string }

type Filters = {
  channel: string; fn: string; region: string; owner: string; flagType: string
  dealType: string
  nameOp: string; nameText: string
  repOp: string; repVal: string; mgrOp: string; mgrVal: string
}

const EMPTY_FILTERS: Filters = {
  channel: '', fn: '', region: '', owner: '', flagType: '',
  dealType: '',
  nameOp: 'contains', nameText: '',
  repOp: '', repVal: '', mgrOp: '', mgrVal: '',
}

function applyFilters(groups: OppGroup[], filters: Filters, oppCounts: Record<string, OppCount>): OppGroup[] {
  return groups.filter((g) => {
    if (filters.channel && g.salesChannel !== filters.channel) return false
    if (filters.fn && g.salesFunction !== filters.fn) return false
    if (filters.region && g.salesRegion !== filters.region) return false
    if (filters.owner && g.ownerEmail !== filters.owner) return false
    if (filters.flagType && !g.alerts.some((a) => filters.flagType.split(',').includes(a.alertType))) return false
    if (filters.dealType && g.opportunityType !== filters.dealType) return false
    if (filters.nameText) {
      const hay = g.opportunityName.toLowerCase()
      const needle = filters.nameText.toLowerCase()
      const contains = hay.includes(needle)
      if (filters.nameOp === 'contains' && !contains) return false
      if (filters.nameOp === 'excludes' && contains) return false
    }
    const counts = oppCounts[g.opportunityId] ?? { rep: 0, manager: 0 }
    if (filters.repOp && filters.repVal !== '') {
      if (!compareCount(counts.rep, filters.repOp, parseInt(filters.repVal))) return false
    }
    if (filters.mgrOp && filters.mgrVal !== '') {
      if (!compareCount(counts.manager, filters.mgrOp, parseInt(filters.mgrVal))) return false
    }
    return true
  })
}

// Summary-level labels (one per alert type row)
const alertTypeLabel: Record<string, string> = {
  PAST_DUE_INITIAL:    'Past Due Close Date',
  PAST_DUE_AMENDMENT:  'Past Due Close Date',
  PAST_DUE_RENEWAL:    'Past Due Booking Date',
  STALLED:             'Zombie Pipeline',
  MEDDPICC_MISSING:    'Missing MEDDPICC / BANT',
  NEXT_STEP_MISSING:   'Missing Next Step',
  CLOSE_DATE_RISK:     'Close Date Risk',
  STAGE_MISMATCH:      'Stage Mismatch',
}

const alertTypeDotColor: Record<string, string> = {
  PAST_DUE_INITIAL:   'bg-red-400',
  PAST_DUE_AMENDMENT: 'bg-red-400',
  PAST_DUE_RENEWAL:   'bg-red-400',
  STALLED:            'bg-yellow-400',
  MEDDPICC_MISSING:   'bg-purple-400',
  NEXT_STEP_MISSING:  'bg-teal-400',
  STAGE_MISMATCH:     'bg-violet-400',
}

// Per-alert tags — may return multiple tags from one alert (e.g. Missing MEDDPICC + Missing BANT)
const MEDDPICC_KEYS = new Set(['metrics','economicBuyer','decisionCriteria','decisionProcess','identifyPain','champion','competition','paperProcess'])
const BANT_KEYS     = new Set(['budget','authority','need','timing'])

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

// ── PipeHygiene ───────────────────────────────────────────────────────────────

export function PipeHygiene() {
  const qc = useQueryClient()
  const location = useLocation()
  const initialTab = new URLSearchParams(location.search).get('tab')

  const [dryRunOverride, setDryRunOverride] = useState<DryRunResult | null>(null)
  const [dryRunError, setDryRunError] = useState<string | null>(null)
  const [expandedSection, setExpandedSection] = useState<'wouldSend' | 'cooldown' | 'snoozed_owner' | 'snoozed_revops' | 'unreachable' | 'resolved' | null>(() => {
    switch (initialTab) {
      case 'cooldown': return 'cooldown'
      case 'snoozedRevops': return 'snoozed_revops'
      case 'snoozedOwner': return 'snoozed_owner'
      case 'resolved': return 'resolved'
      default: return 'wouldSend'
    }
  })
  const [snoozeOpenOppId, setSnoozeOpenOppId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [draftOpp, setDraftOpp] = useState<OppGroup | null>(null)
  const [draftSent, setDraftSent] = useState<string | null>(null)
  const [managerDraftOpp, setManagerDraftOpp] = useState<OppGroup | null>(null)
  const [managerDraftSent, setManagerDraftSent] = useState<string | null>(null)
  const [managerNotifiedOppId, setManagerNotifiedOppId] = useState<string | null>(null)
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [showManagerSummaryModal, setShowManagerSummaryModal] = useState(false)
  const [selectedManagers, setSelectedManagers] = useState<Set<string>>(new Set())
  const [summaryResults, setSummaryResults] = useState<{ managerEmail: string; ok: boolean; error?: string }[] | null>(null)

  const { data: summary, isLoading } = useQuery<Summary>({
    queryKey: ['summary'],
    queryFn: () => api.get('/notifications/summary').then((r) => r.data),
    refetchInterval: 30_000,
  })

  const { data: settings } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: () => api.get('/config/settings').then((r) => r.data),
  })

  const { data: lastDryRun } = useQuery<DryRunResult | null>({
    queryKey: ['last-dry-run'],
    queryFn: () => api.get('/notifications/last-dry-run').then((r) => r.data),
  })

  // Prefer the result of the most recent in-session run; fall back to persisted last run
  const dryRunResult = dryRunOverride ?? lastDryRun ?? null

  // Fetch per-opp sent counts whenever dry run result changes
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

  // Move an opp from wouldSend → wouldSkip in the current dry run result
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

  const notifyManager = useMutation({
    mutationFn: (g: OppGroup) => api.post('/notifications/notify-manager', {
      opportunityId: g.opportunityId,
      opportunityName: g.opportunityName,
      ownerName: g.ownerName ?? g.ownerEmail,
      ownerEmail: g.ownerEmail,
      ownerSlackId: g.alerts[0]?.ownerSlackId ?? null,
      managerSlackId: g.managerSlackId,
      alerts: g.alerts.map((a) => ({ alertType: a.alertType, details: a.details })),
    }),
    onSuccess: (_data, g) => {
      setManagerNotifiedOppId(g.opportunityId)
      setManagerDraftSent(g.opportunityId)
      setTimeout(() => setManagerNotifiedOppId(null), 4000)
      qc.invalidateQueries({ queryKey: ['opp-counts'] })
      moveOppToSkipped(g.opportunityId, 'Manager notified', 'cooldown')
    },
  })

  const sendDraft = useMutation({
    mutationFn: (g: OppGroup) => api.post('/notifications/send-draft', {
      opportunityId: g.opportunityId,
      opportunityName: g.opportunityName,
      ownerSlackId: g.alerts[0]?.ownerSlackId,
      ownerEmail: g.ownerEmail,
      alerts: g.alerts.map((a) => ({ alertType: a.alertType, details: a.details })),
    }),
    onSuccess: (_data, g) => {
      setDraftSent(g.opportunityId)
      qc.invalidateQueries({ queryKey: ['opp-counts'] })
      moveOppToSkipped(g.opportunityId, 'Recently notified', 'cooldown')
    },
  })

  const revopsSnooze = useMutation({
    mutationFn: ({ g, snoozeUntil }: { g: OppGroup; snoozeUntil: Date }) =>
      api.post('/notifications/revops-snooze', {
        opportunityId: g.opportunityId,
        opportunityName: g.opportunityName,
        alertTypes: g.alerts.map((a) => a.alertType),
        ownerSlackId: g.alerts[0]?.ownerSlackId ?? null,
        ownerEmail: g.ownerEmail,
        snoozeUntil: snoozeUntil.toISOString(),
      }).then((r) => r.data as { snoozedUntil: string }),
    onSuccess: (data, { g }) => {
      setSnoozeOpenOppId(null)
      const until = new Date(data.snoozedUntil).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      moveOppToSkipped(g.opportunityId, `RevOps snoozed until ${until}`, 'snoozed_revops')
      qc.invalidateQueries({ queryKey: ['opp-counts'] })
    },
  })

  const deleteOpp = useMutation({
    mutationFn: (id: string) => api.delete(`/notifications/sfdc-opportunity/${id}`),
    onSuccess: (_data, id) => {
      setDeletingId(null)
      setConfirmDeleteId(null)
      if (dryRunResult) {
        setDryRunOverride({
          ...dryRunResult,
          wouldSend: dryRunResult.wouldSend.filter((a) => a.opportunityId !== id),
          wouldSkip: dryRunResult.wouldSkip.filter((a) => a.opportunityId !== id),
          unreachable: dryRunResult.unreachable.filter((a) => a.opportunityId !== id),
        })
      }
    },
    onError: () => setDeletingId(null),
  })

  // Manager summary query — only fires when modal is open
  const { data: managerSummaryData, isLoading: managerSummaryLoading } = useQuery<{
    managers: Array<{
      managerEmail: string
      managerName: string | null
      totalOpen: number
      totalPending: number
      reps: Array<{ ownerEmail: string; ownerName: string | null; openCount: number; pendingCount: number }>
    }>
  }>({
    queryKey: ['manager-summary-data'],
    queryFn: () => api.get('/notifications/manager-summary-data').then((r) => r.data),
    enabled: showManagerSummaryModal,
  })

  const sendManagerSummary = useMutation({
    mutationFn: (emails: string[]) =>
      api.post('/notifications/send-manager-summary', { managerEmails: emails }).then((r) => r.data as { results: { managerEmail: string; ok: boolean; error?: string }[] }),
    onSuccess: (data) => setSummaryResults(data.results),
  })

  function sfdcLink(oppId: string) {
    return sfdcBase ? `${sfdcBase}/lightning/r/Opportunity/${oppId}/view` : null
  }

  function handleDelete(id: string) {
    if (confirmDeleteId === id) {
      setDeletingId(id)
      deleteOpp.mutate(id)
    } else {
      setConfirmDeleteId(id)
      setTimeout(() => setConfirmDeleteId(null), 3000)
    }
  }

  const oppSummaryByType = summary?.byType.filter((t) =>
    ['PAST_DUE_INITIAL', 'PAST_DUE_AMENDMENT', 'PAST_DUE_RENEWAL', 'STALLED', 'MEDDPICC_MISSING', 'NEXT_STEP_MISSING', 'CLOSE_DATE_RISK'].includes(t.alertType)
  ) ?? []

  return (
    <div className="p-8 max-w-5xl">

      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">Pipe Hygiene</h2>
          <p className="text-sm text-gray-500 mt-1">Active flags and send queue</p>
        </div>
        <div className="flex items-center gap-3">
          {lastDryRun?.timestamp && (
            <span className="text-xs text-gray-400">
              Last successful run:{' '}
              {new Date(lastDryRun.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button
            onClick={() => { setShowManagerSummaryModal(true); setSummaryResults(null); setSelectedManagers(new Set()) }}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50"
          >
            <Users size={15} />
            Manager Summary
          </button>
          <button
            onClick={() => { setDryRunError(null); dryRun.mutate() }}
            disabled={dryRun.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50"
          >
            {dryRun.isPending ? <RefreshCw size={15} className="animate-spin" /> : <Play size={15} />}
            Run
          </button>
        </div>
      </div>

      {/* Dry run loading */}
      {dryRun.isPending && (
        <div className="mb-6 bg-blue-50 border border-blue-200 rounded-xl p-6 flex flex-col items-center gap-3 text-center">
          <RefreshCw size={28} className="animate-spin text-blue-500" />
          <div>
            <p className="font-medium text-blue-800">Scanning pipeline...</p>
            <p className="text-sm text-blue-600 mt-0.5">Pulling live Salesforce + Gong data — this takes 30–60 seconds</p>
          </div>
          <div className="w-full bg-blue-100 rounded-full h-1.5 overflow-hidden mt-1">
            <div className="h-1.5 bg-blue-400 rounded-full animate-pulse w-2/3" />
          </div>
        </div>
      )}

      {/* Dry run error */}
      {dryRunError && (
        <div className="mb-6 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <strong>Dry run failed:</strong> {dryRunError}
        </div>
      )}

      {/* ── OPPORTUNITIES SECTION ─────────────────────────────────────────── */}
      <SectionHeader icon={<Briefcase size={16} />} title="Opportunities" />

      {/* Stat cards */}
      {!isLoading && dryRunResult && (() => {
        const wouldSendGroups = groupByOpp(dryRunResult.wouldSend)
        const newSendGroups = wouldSendGroups.filter(g => {
          const c = oppCounts[g.opportunityId]
          return !c || (c.rep === 0 && c.manager === 0)
        })
        const resendGroups = wouldSendGroups.filter(g => {
          const c = oppCounts[g.opportunityId]
          return c && (c.rep > 0 || c.manager > 0)
        })
        const cooldownGroups = groupByOpp(dryRunResult.wouldSkip.filter(a => a.skipType === 'cooldown' || !a.skipType))
        const snoozedOwnerGroups = groupByOpp(dryRunResult.wouldSkip.filter(a => a.skipType === 'snoozed_owner'))
        const snoozedRevopsGroups = groupByOpp(dryRunResult.wouldSkip.filter(a => a.skipType === 'snoozed_revops'))
        const resolvedCount = (dryRunResult.resolved ?? []).filter((r) =>
          !filters.owner || !r.ownerEmail || r.ownerEmail === filters.owner
        ).length
        return (
          <div className="grid grid-cols-3 gap-4 mb-6">
            <StatCard label="Would Send" value={newSendGroups.length} icon={<AlertCircle size={18} className="text-red-500" />} hint="New flags, not yet notified" />
            <StatCard label="In Cooldown" value={cooldownGroups.length} icon={<Clock size={18} className="text-blue-400" />} hint="Sent, within cooldown window" />
            <StatCard label="Cooldown Expired" value={resendGroups.length} icon={<RefreshCw size={18} className="text-orange-400" />} hint="Sent before, window passed — would re-send" />
            <StatCard label="Snoozed by Rep" value={snoozedOwnerGroups.length} icon={<BellOff size={18} className="text-yellow-500" />} hint="Rep snoozed via Slack" />
            <StatCard label="Snoozed by RevOps" value={snoozedRevopsGroups.length} icon={<BellOff size={18} className="text-amber-500" />} hint="Manually snoozed from dashboard" />
            <StatCard label="Resolved" value={resolvedCount} icon={<CheckCircle size={18} className="text-green-500" />} hint="Auto-updates each scan" />
          </div>
        )
      })()}
      {!isLoading && !dryRunResult && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <StatCard label="Pending alerts" value={summary?.sent ?? 0} icon={<AlertCircle size={18} className="text-red-500" />} />
          <StatCard label="Snoozed" value={summary?.snoozed ?? 0} icon={<Clock size={18} className="text-yellow-500" />} />
          <StatCard label="Resolved" value={summary?.resolved ?? 0} icon={<CheckCircle size={18} className="text-green-500" />} hint="Auto-updates each scan" />
        </div>
      )}

      {/* Active alerts by type */}
      {!isLoading && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-6">
          <div className="px-6 py-4 border-b border-gray-100">
            <h3 className="font-medium text-gray-900 text-sm">Active alerts by type</h3>
          </div>
          <div className="divide-y divide-gray-100">
            {oppSummaryByType.length === 0 && (
              <div className="px-6 py-6 text-center text-sm text-gray-400">No active alerts</div>
            )}
            {oppSummaryByType.map((t) => (
              <div key={t.alertType} className="flex items-center justify-between px-6 py-3">
                <div className="flex items-center gap-2">
                  <span className={clsx('w-2 h-2 rounded-full', alertTypeDotColor[t.alertType] ?? 'bg-gray-300')} />
                  <span className="text-sm text-gray-700">{alertTypeLabel[t.alertType] ?? t.alertType}</span>
                </div>
                <span className="text-sm font-semibold text-gray-900">{t._count.id}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Dry run results — Opportunities */}
      {dryRunResult && (
        <div className="mb-8 bg-white rounded-xl border border-blue-200 overflow-hidden">
          <div className="px-6 py-4 bg-blue-50 border-b border-blue-100 flex items-center justify-between flex-wrap gap-3">
            <div>
              <h3 className="font-semibold text-blue-900 flex items-center gap-2 text-sm">
                <FlaskConical size={15} /> Dry Run — Opportunities
              </h3>
              <p className="text-xs text-blue-700 mt-0.5">
                {dryRunResult.totalOpportunities} open opps scanned · nothing sent to Slack
                {dryRunResult.timestamp && (
                  <span className="ml-2 text-blue-500">
                    · {new Date(dryRunResult.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </p>
            </div>
            <div className="flex gap-4 text-xs font-medium flex-wrap">
              <span className="text-green-700">{groupByOpp(dryRunResult.wouldSend).length} would send</span>
              <span className="text-gray-500">{groupByOpp(dryRunResult.wouldSkip.filter(a => a.skipType === 'cooldown')).length} cooldown</span>
              <span className="text-amber-600">{groupByOpp(dryRunResult.wouldSkip.filter(a => a.skipType === 'snoozed_revops')).length} snoozed (RevOps)</span>
              <span className="text-amber-600">{groupByOpp(dryRunResult.wouldSkip.filter(a => a.skipType === 'snoozed_owner')).length} snoozed (owner)</span>
              <span className="text-orange-600">{groupByOpp(dryRunResult.unreachable).length} unreachable</span>
              {(dryRunResult.resolved ?? []).filter((r) => !filters.owner || !r.ownerEmail || r.ownerEmail === filters.owner).length > 0 && (
                <span className="text-emerald-600">{groupResolvedByOpp((dryRunResult.resolved ?? []).filter((r) => !filters.owner || !r.ownerEmail || r.ownerEmail === filters.owner)).length} resolved</span>
              )}
            </div>
          </div>

          {dryRunResult.stallRulesActive === 0 && dryRunResult.meddpiccStagesActive === 0 && (
            <div className="px-6 py-3 bg-yellow-50 border-b border-yellow-100 text-xs text-yellow-800">
              No stall rules or MEDDPICC stages configured — go to Playbook to set them up.
            </div>
          )}

          {/* Filters + opp-counts */}
          {(() => {
            const allGroups = [
              ...groupByOpp(dryRunResult.wouldSend),
              ...groupByOpp(dryRunResult.wouldSkip),
              ...groupByOpp(dryRunResult.unreachable),
            ]
            const channels = uniqueVals(allGroups, 'salesChannel')
            const fns = uniqueVals(allGroups, 'salesFunction')
            const regions = uniqueVals(allGroups, 'salesRegion')
            const dealTypes = uniqueVals(allGroups, 'opportunityType')
            // unique owners: [{email, name}] sorted by name/email
            const ownerMap = new Map<string, string>()
            for (const g of allGroups) ownerMap.set(g.ownerEmail, g.ownerName ?? g.ownerEmail)
            const owners = Array.from(ownerMap.entries()).sort((a, b) => a[1].localeCompare(b[1]))

            // Collect unique flag labels (deduplicated) — e.g. PAST_DUE_INITIAL + PAST_DUE_AMENDMENT both = "Past Due Close Date"
            const flagLabelToTypes = new Map<string, string[]>()
            for (const g of allGroups) {
              for (const a of g.alerts) {
                const label = alertTypeLabel[a.alertType] ?? a.alertType
                if (!flagLabelToTypes.has(label)) flagLabelToTypes.set(label, [])
                if (!flagLabelToTypes.get(label)!.includes(a.alertType)) flagLabelToTypes.get(label)!.push(a.alertType)
              }
            }
            const flagOptions = Array.from(flagLabelToTypes.entries()).sort((a, b) => a[0].localeCompare(b[0]))

            const hasFilters = channels.length > 0 || fns.length > 0 || regions.length > 0 || dealTypes.length > 1 || owners.length > 1 || flagOptions.length > 1
            if (!hasFilters) return null
            const anyActive = filters.channel || filters.fn || filters.region || filters.owner || filters.flagType || filters.dealType || filters.nameText || filters.repOp || filters.mgrOp
            return (
              <div className="px-6 py-3 border-b border-gray-100 flex items-center gap-3 flex-wrap bg-gray-50">
                <span className="text-xs font-medium text-gray-500">Filter</span>
                {flagOptions.length > 1 && (
                  <select value={filters.flagType} onChange={(e) => setFilters((f) => ({ ...f, flagType: e.target.value }))} className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700">
                    <option value="">All flag types</option>
                    {flagOptions.map(([label, types]) => <option key={label} value={types.join(',')}>{label}</option>)}
                  </select>
                )}
                {dealTypes.length > 1 && (
                  <select value={filters.dealType} onChange={(e) => setFilters((f) => ({ ...f, dealType: e.target.value }))} className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700">
                    <option value="">All deal types</option>
                    {dealTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                )}
                {owners.length > 1 && (
                  <select value={filters.owner} onChange={(e) => {
                    const owner = e.target.value
                    setFilters((f) => ({ ...f, owner }))
                    // Auto-expand the first section that has items for this owner
                    if (owner && dryRunResult) {
                      const newFilters = { ...filters, owner }
                      const hasWouldSend = applyFilters(groupByOpp(dryRunResult.wouldSend), newFilters, oppCounts).length > 0
                      const hasCooldown = applyFilters(groupByOpp(dryRunResult.wouldSkip.filter(a => a.skipType === 'cooldown' || !a.skipType)), newFilters, oppCounts).length > 0
                      if (hasWouldSend) setExpandedSection('wouldSend')
                      else if (hasCooldown) setExpandedSection('cooldown')
                    }
                  }} className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700">
                    <option value="">All owners</option>
                    {owners.map(([email, name]) => <option key={email} value={email}>{name}</option>)}
                  </select>
                )}
                <div className="flex items-center gap-1">
                  <span className="text-xs text-gray-500 shrink-0">Opp name</span>
                  <select value={filters.nameOp} onChange={(e) => setFilters((f) => ({ ...f, nameOp: e.target.value }))} className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700">
                    <option value="contains">contains</option>
                    <option value="excludes">excludes</option>
                  </select>
                  <input
                    type="text"
                    value={filters.nameText}
                    onChange={(e) => setFilters((f) => ({ ...f, nameText: e.target.value }))}
                    placeholder="search…"
                    className="w-28 text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700"
                  />
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-gray-500 shrink-0">Rep sends</span>
                  <select value={filters.repOp} onChange={(e) => setFilters((f) => ({ ...f, repOp: e.target.value, repVal: f.repVal || '0' }))} className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700">
                    <option value="">any</option>
                    <option value="=">=</option>
                    <option value=">=">≥</option>
                    <option value="<=">≤</option>
                    <option value=">">{'>'}</option>
                    <option value="<">{'<'}</option>
                  </select>
                  {filters.repOp && (
                    <input
                      type="number" min="0"
                      value={filters.repVal}
                      onChange={(e) => setFilters((f) => ({ ...f, repVal: e.target.value }))}
                      className="w-12 text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700 text-center"
                    />
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-gray-500 shrink-0">Mgr sends</span>
                  <select value={filters.mgrOp} onChange={(e) => setFilters((f) => ({ ...f, mgrOp: e.target.value, mgrVal: f.mgrVal || '0' }))} className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700">
                    <option value="">any</option>
                    <option value="=">=</option>
                    <option value=">=">≥</option>
                    <option value="<=">≤</option>
                    <option value=">">{'>'}</option>
                    <option value="<">{'<'}</option>
                  </select>
                  {filters.mgrOp && (
                    <input
                      type="number" min="0"
                      value={filters.mgrVal}
                      onChange={(e) => setFilters((f) => ({ ...f, mgrVal: e.target.value }))}
                      className="w-12 text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700 text-center"
                    />
                  )}
                </div>
                {channels.length > 0 && (
                  <select value={filters.channel} onChange={(e) => setFilters((f) => ({ ...f, channel: e.target.value }))} className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700">
                    <option value="">All channels</option>
                    {channels.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                )}
                {fns.length > 0 && (
                  <select value={filters.fn} onChange={(e) => setFilters((f) => ({ ...f, fn: e.target.value }))} className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700">
                    <option value="">All functions</option>
                    {fns.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                )}
                {regions.length > 0 && (
                  <select value={filters.region} onChange={(e) => setFilters((f) => ({ ...f, region: e.target.value }))} className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700">
                    <option value="">All regions</option>
                    {regions.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                )}
                {anyActive && (
                  <button onClick={() => setFilters(EMPTY_FILTERS)} className="text-xs text-gray-400 hover:text-gray-700 underline">Clear</button>
                )}
              </div>
            )
          })()}

          <OppSection
            title="Would send"
            groups={applyFilters(groupByOpp(dryRunResult.wouldSend), filters, oppCounts)}
            expanded={expandedSection === 'wouldSend'}
            onToggle={() => setExpandedSection(expandedSection === 'wouldSend' ? null : 'wouldSend')}
            emptyText="No alerts would be sent with current rules"
            badgeClass="bg-green-100 text-green-700"
            sfdcLink={sfdcLink}
            onDelete={handleDelete}
            onDraft={setDraftOpp}
            onManagerDraft={setManagerDraftOpp}
            managerNotifiedOppId={managerNotifiedOppId}
            confirmDeleteId={confirmDeleteId}
            deletingId={deletingId}
            oppCounts={oppCounts}
            onSnooze={(g, until) => revopsSnooze.mutate({ g, snoozeUntil: until })}
            snoozeOpenOppId={snoozeOpenOppId}
            setSnoozeOpenOppId={setSnoozeOpenOppId}
            snoozePending={revopsSnooze.isPending}
          />

          {dryRunResult.unreachable.length > 0 && (
            <OppSection
              title="Owner not in Slack"
              groups={applyFilters(groupByOpp(dryRunResult.unreachable), filters, oppCounts)}
              expanded={expandedSection === 'unreachable'}
              onToggle={() => setExpandedSection(expandedSection === 'unreachable' ? null : 'unreachable')}
              emptyText=""
              badgeClass="bg-orange-100 text-orange-700"
              hint="Owner email doesn't match a Slack account"
              sfdcLink={sfdcLink}
              onDelete={handleDelete}
              onDraft={setDraftOpp}
              onManagerDraft={setManagerDraftOpp}
              managerNotifiedOppId={managerNotifiedOppId}
              confirmDeleteId={confirmDeleteId}
              deletingId={deletingId}
              oppCounts={oppCounts}
            />
          )}

          {dryRunResult.wouldSkip.some(a => a.skipType === 'snoozed_revops') && (
            <OppSection
              title="Snoozed by RevOps"
              groups={applyFilters(groupByOpp(dryRunResult.wouldSkip.filter(a => a.skipType === 'snoozed_revops')), filters, oppCounts)}
              expanded={expandedSection === 'snoozed_revops'}
              onToggle={() => setExpandedSection(expandedSection === 'snoozed_revops' ? null : 'snoozed_revops')}
              emptyText=""
              badgeClass="bg-amber-100 text-amber-700"
              hint="Manually snoozed from this dashboard"
              sfdcLink={sfdcLink}
              onDelete={handleDelete}
              onDraft={setDraftOpp}
              onManagerDraft={setManagerDraftOpp}
              managerNotifiedOppId={managerNotifiedOppId}
              confirmDeleteId={confirmDeleteId}
              deletingId={deletingId}
              oppCounts={oppCounts}
            />
          )}

          {dryRunResult.wouldSkip.some(a => a.skipType === 'snoozed_owner') && (
            <OppSection
              title="Snoozed by owner"
              groups={applyFilters(groupByOpp(dryRunResult.wouldSkip.filter(a => a.skipType === 'snoozed_owner')), filters, oppCounts)}
              expanded={expandedSection === 'snoozed_owner'}
              onToggle={() => setExpandedSection(expandedSection === 'snoozed_owner' ? null : 'snoozed_owner')}
              emptyText=""
              badgeClass="bg-amber-100 text-amber-700"
              hint="Rep snoozed via Slack"
              sfdcLink={sfdcLink}
              onDelete={handleDelete}
              onDraft={setDraftOpp}
              onManagerDraft={setManagerDraftOpp}
              managerNotifiedOppId={managerNotifiedOppId}
              confirmDeleteId={confirmDeleteId}
              deletingId={deletingId}
              oppCounts={oppCounts}
            />
          )}

          {dryRunResult.wouldSkip.some(a => a.skipType === 'cooldown' || !a.skipType) && (
            <OppSection
              title="Cooldown"
              groups={applyFilters(groupByOpp(dryRunResult.wouldSkip.filter(a => a.skipType === 'cooldown' || !a.skipType)), filters, oppCounts)}
              expanded={expandedSection === 'cooldown'}
              onToggle={() => setExpandedSection(expandedSection === 'cooldown' ? null : 'cooldown')}
              emptyText=""
              badgeClass="bg-gray-100 text-gray-500"
              hint="Notification sent, not yet resolved, within cooldown window"
              sfdcLink={sfdcLink}
              onDelete={handleDelete}
              onDraft={setDraftOpp}
              onManagerDraft={setManagerDraftOpp}
              managerNotifiedOppId={managerNotifiedOppId}
              confirmDeleteId={confirmDeleteId}
              deletingId={deletingId}
              oppCounts={oppCounts}
            />
          )}

          {(dryRunResult.resolved ?? []).length > 0 && (() => {
            const filteredResolved = (dryRunResult.resolved ?? []).filter((r) => {
              if (filters.owner && r.ownerEmail && r.ownerEmail !== filters.owner) return false
              return true
            })
            return filteredResolved.length > 0 ? (
              <ResolvedSection
                groups={groupResolvedByOpp(filteredResolved)}
                expanded={expandedSection === 'resolved'}
                onToggle={() => setExpandedSection(expandedSection === 'resolved' ? null : 'resolved')}
                sfdcLink={sfdcLink}
              />
            ) : null
          })()}
        </div>
      )}

      {/* Draft modal */}
      {draftOpp && (
        <DraftModal
          opp={draftOpp}
          sfdcBase={sfdcBase}
          sending={sendDraft.isPending}
          sent={draftSent === draftOpp.opportunityId}
          onSend={() => sendDraft.mutate(draftOpp)}
          onClose={() => { setDraftOpp(null); setDraftSent(null); sendDraft.reset() }}
        />
      )}

      {managerDraftOpp && (
        <ManagerDraftModal
          opp={managerDraftOpp}
          sfdcBase={sfdcBase}
          sending={notifyManager.isPending}
          sent={managerDraftSent === managerDraftOpp.opportunityId}
          onSend={() => notifyManager.mutate(managerDraftOpp)}
          onClose={() => { setManagerDraftOpp(null); setManagerDraftSent(null); notifyManager.reset() }}
        />
      )}

      {/* ── MANAGER SUMMARY MODAL ─────────────────────────────────────────── */}
      {showManagerSummaryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Send Manager Summary</h2>
                <p className="text-xs text-gray-500 mt-0.5">Select leaders to send a Slack DM with their team's open + queued flags</p>
              </div>
              <button onClick={() => { setShowManagerSummaryModal(false); setSummaryResults(null) }} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 px-6 py-4 space-y-3">
              {managerSummaryLoading && (
                <div className="flex items-center justify-center py-12 text-gray-400 text-sm gap-2">
                  <RefreshCw size={16} className="animate-spin" />
                  Loading manager data…
                </div>
              )}

              {!managerSummaryLoading && managerSummaryData?.managers.map((mgr) => {
                const isSelected = selectedManagers.has(mgr.managerEmail)
                const sent = summaryResults?.find((r) => r.managerEmail === mgr.managerEmail)
                return (
                  <div
                    key={mgr.managerEmail}
                    className={clsx(
                      'rounded-xl border p-4 transition-colors',
                      !sent && 'cursor-pointer',
                      isSelected && !sent ? 'border-brand-400 bg-brand-50' : !sent ? 'border-gray-200 hover:border-gray-300' : '',
                      sent?.ok ? 'border-green-300 bg-green-50' : '',
                      sent && !sent.ok ? 'border-red-300 bg-red-50' : '',
                    )}
                    onClick={() => {
                      if (sent) return
                      setSelectedManagers((prev) => {
                        const next = new Set(prev)
                        if (next.has(mgr.managerEmail)) next.delete(mgr.managerEmail)
                        else next.add(mgr.managerEmail)
                        return next
                      })
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        {!sent && (
                          <div className={clsx(
                            'w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center',
                            isSelected ? 'bg-brand-600 border-brand-600' : 'border-gray-300'
                          )}>
                            {isSelected && <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                          </div>
                        )}
                        {sent?.ok && <CheckCircle size={16} className="text-green-500 flex-shrink-0" />}
                        {sent && !sent.ok && <X size={16} className="text-red-500 flex-shrink-0" />}
                        <span className="font-medium text-sm text-gray-900 truncate">{mgr.managerName ?? mgr.managerEmail}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs flex-shrink-0">
                        {mgr.totalOpen > 0 && <span className="text-orange-600 font-medium">{mgr.totalOpen} sent & open</span>}
                        {mgr.totalPending > 0 && <span className="text-blue-600 font-medium">{mgr.totalPending} queued</span>}
                      </div>
                    </div>

                    {sent?.error && <p className="mt-1 text-xs text-red-600 pl-6">{sent.error}</p>}

                    {mgr.reps.filter((r) => r.openCount > 0 || r.pendingCount > 0).length > 0 && (
                      <div className="mt-3 space-y-1 pl-6 border-t border-gray-100 pt-3">
                        {mgr.reps.filter((r) => r.openCount > 0 || r.pendingCount > 0).map((rep) => (
                          <div key={rep.ownerEmail} className="flex items-center justify-between text-xs text-gray-600">
                            <span>{rep.ownerName ?? rep.ownerEmail}</span>
                            <div className="flex gap-3">
                              {rep.openCount > 0 && <span className="text-orange-500">{rep.openCount} open</span>}
                              {rep.pendingCount > 0 && <span className="text-blue-500">{rep.pendingCount} queued</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}

              {!managerSummaryLoading && (managerSummaryData?.managers.length ?? 0) === 0 && (
                <p className="text-sm text-gray-400 text-center py-8">No manager data found — run a scan first.</p>
              )}
            </div>

            <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-3">
              <p className="text-xs text-gray-400">
                {summaryResults
                  ? `Sent to ${summaryResults.filter((r) => r.ok).length} of ${summaryResults.length} managers`
                  : selectedManagers.size > 0
                    ? `${selectedManagers.size} manager${selectedManagers.size !== 1 ? 's' : ''} selected`
                    : 'Click a manager to select'}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => { setShowManagerSummaryModal(false); setSummaryResults(null) }}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-200 rounded-lg hover:bg-gray-50"
                >
                  {summaryResults ? 'Close' : 'Cancel'}
                </button>
                {!summaryResults && (
                  <button
                    onClick={() => sendManagerSummary.mutate(Array.from(selectedManagers))}
                    disabled={selectedManagers.size === 0 || sendManagerSummary.isPending}
                    className="flex items-center gap-2 px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-40"
                  >
                    {sendManagerSummary.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />}
                    Send to {selectedManagers.size > 0 ? `${selectedManagers.size} ` : ''}{selectedManagers.size === 1 ? 'manager' : 'managers'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <div className="text-gray-400">{icon}</div>
      <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">{title}</h3>
      <div className="flex-1 h-px bg-gray-200 ml-1" />
    </div>
  )
}

// ── OppSection ────────────────────────────────────────────────────────────────

function addDays(d: Date, n: number): Date {
  const r = new Date(d); r.setDate(r.getDate() + n); return r
}

const SNOOZE_OPTIONS = [
  { label: '3 days', days: 3 },
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
  { label: '1 month', days: 30 },
]

function fmtSkipReason(skipType: SkipType | undefined, reason: string): string {
  if (skipType === 'cooldown') {
    const m = reason.match(/Sent (\d+ business days?) ago/)
    return m ? `${m[1]} ago` : reason
  }
  if (skipType === 'snoozed_owner' || skipType === 'snoozed_revops') {
    const m = reason.match(/until (.+)/)
    if (m) {
      return `until ${m[1].replace(/, \d{4}$/, '')}`
    }
  }
  return reason
}

function OppSection({ title, groups, expanded, onToggle, emptyText, badgeClass, hint, sfdcLink, onDelete, onDraft, onManagerDraft, managerNotifiedOppId, confirmDeleteId, deletingId, oppCounts, onSnooze, snoozeOpenOppId, setSnoozeOpenOppId, snoozePending }: {
  title: string
  groups: OppGroup[]
  expanded: boolean
  onToggle: () => void
  emptyText: string
  badgeClass: string
  hint?: string
  sfdcLink: (id: string) => string | null
  onDelete: (id: string) => void
  onDraft: (g: OppGroup) => void
  onManagerDraft: (g: OppGroup) => void
  managerNotifiedOppId: string | null
  confirmDeleteId: string | null
  deletingId: string | null
  oppCounts: Record<string, OppCount>
  onSnooze?: (g: OppGroup, until: Date) => void
  snoozeOpenOppId?: string | null
  setSnoozeOpenOppId?: (id: string | null) => void
  snoozePending?: boolean
}) {
  const [customDate, setCustomDate] = useState<Record<string, string>>({})

  function fmtDate(iso: string | undefined | null) {
    if (!iso) return ''
    const d = new Date(iso)
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  return (
    <div className="border-b border-gray-100 last:border-0">
      <button onClick={onToggle} className="w-full flex items-center justify-between px-6 py-3 hover:bg-gray-50 text-left">
        <div className="flex items-center gap-3">
          <span className={clsx('text-xs font-semibold px-2 py-0.5 rounded-full', badgeClass)}>{groups.length}</span>
          <span className="text-sm font-medium text-gray-800">{title}</span>
          {hint && <span className="text-xs text-gray-400">{hint}</span>}
        </div>
        {expanded ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
      </button>

      {expanded && (
        <div className="px-6 pb-4">
          {groups.length === 0 ? (
            <p className="text-sm text-gray-400 py-2">{emptyText}</p>
          ) : (
            <div className="space-y-2">
              {groups.map((g) => {
                const link = sfdcLink(g.opportunityId)
                const isConfirming = confirmDeleteId === g.opportunityId
                const isDeleting = deletingId === g.opportunityId
                const counts = oppCounts[g.opportunityId] ?? { rep: 0, manager: 0 }
                const managerNotified = managerNotifiedOppId === g.opportunityId
                const skipType = g.alerts.find(a => a.skipType)?.skipType
                const skipReason = g.alerts.find(a => a.skipReason)?.skipReason
                const skipBadge = skipType === 'cooldown'
                  ? { icon: '⏱', label: 'Cooldown', cls: 'bg-gray-100 text-gray-600' }
                  : skipType === 'snoozed_owner'
                  ? { icon: '😴', label: 'Rep snoozed', cls: 'bg-amber-50 text-amber-700' }
                  : skipType === 'snoozed_revops'
                  ? { icon: '🔕', label: 'RevOps snoozed', cls: 'bg-indigo-50 text-indigo-700' }
                  : null
                return (
                  <div key={g.opportunityId} className="flex items-start justify-between py-2.5 px-3 rounded-lg border border-gray-100 hover:bg-gray-50">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                        {link ? (
                          <a href={link} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-gray-900 hover:text-brand-600 flex items-center gap-1">
                            {g.opportunityName}
                            <ExternalLink size={11} className="text-gray-400" />
                          </a>
                        ) : (
                          <span className="text-sm font-medium text-gray-900">{g.opportunityName}</span>
                        )}
                        {g.opportunityType && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">{g.opportunityType}</span>
                        )}
                        {skipBadge && (
                          <span className={clsx('text-xs px-1.5 py-0.5 rounded-full font-medium', skipBadge.cls)} title={skipReason}>
                            {skipBadge.icon} {skipBadge.label}{skipReason ? ` · ${fmtSkipReason(skipType, skipReason)}` : ''}
                          </span>
                        )}
                        {counts.rep > 0 && (
                          <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 font-medium" title={`Rep notified ${counts.rep} time${counts.rep === 1 ? '' : 's'}${counts.lastSentRep ? ` · last ${fmtDate(counts.lastSentRep)}` : ''}`}>
                            rep {counts.rep}×{counts.lastSentRep && <span className="ml-1 opacity-70">· {fmtDate(counts.lastSentRep)}</span>}
                          </span>
                        )}
                        {counts.snoozedRepUntil && (
                          <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600 font-medium" title={`Rep snoozed until ${new Date(counts.snoozedRepUntil).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`}>
                            😴 rep snoozed · {fmtDate(counts.snoozedRepUntil)}
                          </span>
                        )}
                        {counts.manager > 0 && (
                          <span className="text-xs px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-600 font-medium" title={`Manager notified ${counts.manager} time${counts.manager === 1 ? '' : 's'}${counts.lastSentMgr ? ` · last ${fmtDate(counts.lastSentMgr)}` : ''}`}>
                            mgr {counts.manager}×{counts.lastSentMgr && <span className="ml-1 opacity-70">· {fmtDate(counts.lastSentMgr)}</span>}
                          </span>
                        )}
                        {counts.snoozedMgrUntil && (
                          <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600 font-medium" title={`Manager snoozed until ${new Date(counts.snoozedMgrUntil).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`}>
                            😴 mgr snoozed · {fmtDate(counts.snoozedMgrUntil)}
                          </span>
                        )}
                      </div>
                      {g.accountName && <p className="text-xs text-gray-500 mb-1">{g.accountName}</p>}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {g.alerts.flatMap((a, i) =>
                          getAlertTags(a).map((tag, j) => (
                            <span key={`${i}-${j}`} className={clsx('text-xs font-medium px-1.5 py-0.5 rounded', tag.color)}>
                              {tag.label}
                            </span>
                          ))
                        )}
                      </div>
                      {/* Next step info — only for Zombie Pipeline (STALLED) alerts */}
                      {g.alerts.some((a) => a.alertType === 'STALLED') && (() => {
                        const sa = g.alerts.find((a) => a.alertType === 'STALLED')
                        const ns = sa?.details.nextStep as string | null | undefined
                        const nsd = sa?.details.nextStepDate as string | null | undefined
                        if (!ns && !nsd) return null
                        return (
                          <div className="mt-1.5 flex items-start gap-1.5 text-xs text-gray-500">
                            <span className="font-medium text-gray-400 shrink-0">Next step:</span>
                            {nsd && <span className="font-medium text-gray-600">{fmtDate(nsd)}</span>}
                            {ns && <span className="text-gray-400 truncate max-w-xs" title={ns}>· {ns.length > 90 ? ns.slice(0, 90) + '…' : ns}</span>}
                          </div>
                        )
                      })()}
                      <p className="text-xs text-gray-400 mt-1">
                        {g.ownerName ?? g.ownerEmail}
                        {g.managerName && <span className="ml-1 text-gray-300">· mgr: {g.managerName}</span>}
                      </p>
                    </div>
                    <div className="ml-3 flex-shrink-0 flex items-center gap-1">
                      <button onClick={() => onDraft(g)} className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-brand-600 hover:bg-brand-50" title="Send message to rep">
                        <MessageSquare size={11} /> Send to rep
                      </button>
                      {g.managerSlackId && (
                        <button
                          onClick={() => onManagerDraft(g)}
                          className={clsx('flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors',
                            managerNotified ? 'text-green-600 bg-green-50' : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100'
                          )}
                          title={`Send to manager (${g.managerName ?? g.managerEmail})`}
                        >
                          <UserCheck size={11} />
                          {managerNotified ? 'Sent to mgr' : 'Send to manager'}
                        </button>
                      )}
                      {onSnooze && setSnoozeOpenOppId && (
                        <div className="relative">
                          <button
                            onClick={() => {
                              setSnoozeOpenOppId(snoozeOpenOppId === g.opportunityId ? null : g.opportunityId)
                              setCustomDate((prev) => ({ ...prev, [g.opportunityId]: '' }))
                            }}
                            disabled={snoozePending}
                            className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-gray-500 hover:text-amber-700 hover:bg-amber-50 transition-colors"
                            title="Snooze this opp (no message sent)"
                          >
                            <BellOff size={11} /> Snooze
                          </button>
                          {snoozeOpenOppId === g.opportunityId && (() => {
                            const sa = g.alerts.find((a) => a.alertType === 'STALLED')
                            const nsd = sa?.details.nextStepDate as string | null | undefined
                            const nextStepFuture = nsd && new Date(nsd) > new Date() ? new Date(nsd) : null
                            return (
                              <div className="absolute right-0 top-7 z-20 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[170px]">
                                <p className="px-3 py-1 text-xs font-medium text-gray-400 uppercase tracking-wide">Snooze until</p>
                                {SNOOZE_OPTIONS.map((opt) => (
                                  <button
                                    key={opt.days}
                                    onClick={() => { onSnooze(g, addDays(new Date(), opt.days)); setSnoozeOpenOppId(null) }}
                                    className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-amber-50 hover:text-amber-800"
                                  >
                                    {opt.label}
                                    <span className="ml-1 text-gray-400">{fmtDate(addDays(new Date(), opt.days).toISOString())}</span>
                                  </button>
                                ))}
                                {nextStepFuture && (
                                  <button
                                    onClick={() => { onSnooze(g, addDays(nextStepFuture, 7)); setSnoozeOpenOppId(null) }}
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
                                      value={customDate[g.opportunityId] ?? ''}
                                      min={new Date().toISOString().split('T')[0]}
                                      onChange={(e) => setCustomDate((prev) => ({ ...prev, [g.opportunityId]: e.target.value }))}
                                      className="text-xs border border-gray-200 rounded px-1.5 py-1 flex-1 min-w-0"
                                    />
                                    <button
                                      disabled={!customDate[g.opportunityId]}
                                      onClick={() => {
                                        const d = new Date(customDate[g.opportunityId] + 'T12:00:00')
                                        onSnooze(g, d)
                                        setSnoozeOpenOppId(null)
                                      }}
                                      className="px-2 py-1 text-xs bg-amber-500 text-white rounded disabled:opacity-40 hover:bg-amber-600"
                                    >
                                      Set
                                    </button>
                                  </div>
                                </div>
                              </div>
                            )
                          })()}
                        </div>
                      )}
                      <button
                        onClick={() => onDelete(g.opportunityId)}
                        disabled={isDeleting}
                        className={clsx('flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors',
                          isConfirming ? 'bg-red-500 text-white hover:bg-red-600' : 'text-gray-400 hover:text-red-500 hover:bg-red-50'
                        )}
                        title={isConfirming ? 'Click again to confirm' : 'Delete from Salesforce'}
                      >
                        {isDeleting ? <RefreshCw size={11} className="animate-spin" /> : <Trash2 size={11} />}
                        {isConfirming && <span>Confirm</span>}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── ResolvedSection ───────────────────────────────────────────────────────────

function ResolvedSection({ groups, expanded, onToggle, sfdcLink }: {
  groups: ResolvedGroup[]
  expanded: boolean
  onToggle: () => void
  sfdcLink: (id: string) => string | null
}) {
  return (
    <div className="border-b border-gray-100 last:border-0">
      <button onClick={onToggle} className="w-full flex items-center justify-between px-6 py-3 hover:bg-gray-50 text-left">
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">{groups.length}</span>
          <span className="text-sm font-medium text-gray-800">Resolved this scan</span>
          <span className="text-xs text-gray-400">Flags cleared or opp closed since last run</span>
        </div>
        {expanded ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
      </button>

      {expanded && (
        <div className="px-6 pb-4">
          <div className="space-y-2">
            {groups.map((g) => {
              const link = sfdcLink(g.opportunityId)
              const closedCount = g.items.filter((i) => i.resolveReason === 'opp_closed').length
              const clearedCount = g.items.filter((i) => i.resolveReason === 'flag_cleared').length
              return (
                <div key={g.opportunityId} className="flex items-start justify-between py-2.5 px-3 rounded-lg border border-emerald-100 bg-emerald-50/40">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                      {link ? (
                        <a href={link} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-gray-900 hover:text-brand-600 flex items-center gap-1">
                          {g.opportunityName}
                          <ExternalLink size={11} className="text-gray-400" />
                        </a>
                      ) : (
                        <span className="text-sm font-medium text-gray-900">{g.opportunityName}</span>
                      )}
                      {closedCount > 0 && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium">
                          Opp closed ({closedCount} alert{closedCount !== 1 ? 's' : ''})
                        </span>
                      )}
                      {clearedCount > 0 && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-teal-100 text-teal-700 font-medium">
                          Flag cleared ({clearedCount} alert{clearedCount !== 1 ? 's' : ''})
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {g.items.map((item, i) => (
                        <span key={i} className="text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
                          {alertTypeLabel[item.alertType] ?? item.alertType}
                        </span>
                      ))}
                    </div>
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

// ── Button preview helpers ────────────────────────────────────────────────────

function getRepButtons(alerts: DryRunAlert[]): string[] {
  const buttons: string[] = []
  const seen = new Set<string>()
  for (const a of alerts) {
    let primary: string[] = []
    if (a.alertType === 'PAST_DUE_INITIAL' || a.alertType === 'PAST_DUE_AMENDMENT') {
      primary = ['Update Close Date']
    } else if (a.alertType === 'PAST_DUE_RENEWAL') {
      primary = []
    } else if (a.alertType === 'STALLED') {
      primary = ['Update Stage', 'Update Close Date']
    } else if (a.alertType === 'MEDDPICC_MISSING') {
      primary = ['Update Now']
    } else if (a.alertType === 'NEXT_STEP_MISSING') {
      primary = ['Update Next Step']
    } else if (a.alertType === 'CLOSE_DATE_RISK') {
      primary = ['Update Close Date', 'Update Stage']
    } else if (a.alertType === 'STAGE_MISMATCH') {
      primary = ['Open in Salesforce']
    }
    for (const b of primary) {
      if (!seen.has(b)) { seen.add(b); buttons.push(b) }
    }
  }
  buttons.push('Snooze', 'Need Help?')
  return buttons
}

// ── Draft modal ───────────────────────────────────────────────────────────────

const MEDDPICC_FIELD_LABELS: Record<string, string> = {
  metrics: 'Metrics', economicBuyer: 'Economic Buyer', decisionCriteria: 'Decision Criteria',
  decisionProcess: 'Decision Process', paperProcess: 'Paper Process', identifyPain: 'Identify Pain',
  champion: 'Champion', competition: 'Competition', budget: 'Budget', authority: 'Authority',
  need: 'Need', timing: 'Timing',
}

function formatPreview(opp: OppGroup): string {
  const lines: string[] = []
  for (const a of opp.alerts) {
    const d = a.details
    if (a.alertType === 'MEDDPICC_MISSING') {
      const fields = (d.missingFields as string[] | undefined) ?? []
      lines.push(`Missing MEDDPICC/BANT: ${fields.map((f) => MEDDPICC_FIELD_LABELS[f] ?? f).join(', ')}`)
    } else if (a.alertType === 'STALLED') {
      const reasons = (d.triggeredBy as Array<{ type: string; days?: number; threshold?: number; phrases?: string[] }> | undefined) ?? []
      for (const r of reasons) {
        if (r.type === 'deal_age') lines.push(`Deal open for ${r.days} days (threshold: ${r.threshold}d)`)
        else if (r.type === 'stage_duration') lines.push(`In current stage for ${r.days} days (threshold: ${r.threshold}d)`)
        else if (r.type === 'gong_inactivity') lines.push(`No Gong activity in ${r.days} days`)
        else if (r.type === 'single_threaded') lines.push(`Single-threaded deal`)
        else if (r.type === 'red_flag') lines.push(`Gong risk phrases detected`)
      }
      lines.push(`This opportunity may be at the right stage with a longer sales cycle — if everything is on track, just snooze to your next step date.`)
    } else if (a.alertType === 'PAST_DUE_RENEWAL') {
      lines.push(`Renewal past due: booking date was ${d.bookingDate} (${d.daysOverdue} days ago)`)
    } else if (a.alertType === 'PAST_DUE_INITIAL' || a.alertType === 'PAST_DUE_AMENDMENT') {
      const label = a.alertType === 'PAST_DUE_AMENDMENT' ? 'Amendment' : 'Opportunity'
      lines.push(`${label} past due: close date was ${d.bookingDate} (${d.daysOverdue} days ago)`)
    } else if (a.alertType === 'NEXT_STEP_MISSING') {
      const issues = (d.issues as string[] | undefined) ?? []
      for (const issue of issues) {
        if (issue === 'missing_text') lines.push(`Next step description is blank`)
        if (issue === 'missing_date') lines.push(`Next step date is not set`)
        if (issue === 'past_date') lines.push(`Next step date (${d.nextStepDate ?? 'unknown'}) is in the past`)
      }
    } else if (a.alertType === 'CLOSE_DATE_RISK') {
      const days = d.daysUntilClose as number
      const daysText = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`
      lines.push(`Close date is ${daysText} (${d.closeDate}) but deal is still in ${d.stage}`)
    } else if (a.alertType === 'STAGE_MISMATCH') {
      const keywords = (d.matchedKeywords as string[] | undefined) ?? []
      lines.push(`Potential stage mismatch — next step mentions "${keywords.join('", "')}" but deal is in ${d.stage}`)
      lines.push(`Is the stage up to date? Please advance in Salesforce if the deal has progressed.`)
    }
  }
  return lines.join('\n')
}

interface OppMeta {
  netAcv: number | null
  oppType: string | null
  nextContractEndDate: string | null
  nextRenewalDate: string | null
  hasAutoRenewal: boolean | null
}

function fmtDate(iso: string | null) {
  if (!iso) return null
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T12:00:00') : new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtLong(d: Date) {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

function DraftModal({ opp, sfdcBase, sending, sent, onSend, onClose }: {
  opp: OppGroup
  sfdcBase: string
  sending: boolean
  sent: boolean
  onSend: () => void
  onClose: () => void
}) {
  const preview = formatPreview(opp)
  const link = sfdcBase ? `${sfdcBase}/lightning/r/Opportunity/${opp.opportunityId}/view` : null
  const buttons = getRepButtons(opp.alerts)
  const isRenewal = opp.opportunityType === 'Renewal'

  // Fetch renewal contract details on-demand for Renewal opps
  const { data: oppMeta } = useQuery<OppMeta | null>({
    queryKey: ['opp-meta', opp.opportunityId],
    queryFn: () => api.get(`/notifications/opp-meta?id=${opp.opportunityId}`).then((r) => r.data),
    enabled: isRenewal,
    staleTime: 5 * 60 * 1000,
  })

  const updateNextStep = useMutation({
    mutationFn: ({ nextStep, nextStepDate }: { nextStep: string; nextStepDate: string }) =>
      api.post('/notifications/update-opp-next-step', { opportunityId: opp.opportunityId, nextStep, nextStepDate }),
  })

  const isRenewalZeroAcv = isRenewal && oppMeta != null && oppMeta.netAcv === 0
  const { nextContractEndDate, nextRenewalDate, hasAutoRenewal } = oppMeta ?? {}

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900">Send to rep</h3>
          <button onClick={onClose}><X size={18} className="text-gray-400" /></button>
        </div>
        <div className="mb-4 text-sm text-gray-500">
          Sending to: <span className="font-medium text-gray-700">{opp.ownerEmail}</span>
        </div>
        <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 mb-4">
          <p className="text-xs font-medium text-gray-400 uppercase mb-2">Slack message preview</p>
          <p className="text-sm font-medium text-gray-900 mb-1">
            Action needed on{' '}
            {link ? (
              <a href={link} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline inline-flex items-center gap-0.5">
                {opp.opportunityName} <ExternalLink size={10} />
              </a>
            ) : opp.opportunityName}
          </p>
          {opp.accountName && <p className="text-xs text-gray-500 mb-2">{opp.accountName}</p>}
          <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans">{preview}</pre>
          <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-gray-200">
            {buttons.map((b) => (
              <span key={b} className="px-2.5 py-1 rounded border border-gray-300 text-xs font-medium text-gray-600 bg-white">
                {b}
              </span>
            ))}
          </div>
        </div>

        {/* Renewal $0 ACV: contract details + generate next step */}
        {isRenewalZeroAcv && (
          <div className="mb-4 rounded-xl border border-gray-200 p-4 space-y-2.5">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Contract details</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {nextContractEndDate && (
                <span className="text-xs text-gray-500">
                  <span className="font-medium text-gray-700">Contract End</span>{' '}{fmtDate(nextContractEndDate)}
                </span>
              )}
              {nextRenewalDate && (
                <span className="text-xs text-gray-500">
                  <span className="font-medium text-gray-700">Cancellation Deadline</span>{' '}{fmtDate(nextRenewalDate)}
                </span>
              )}
              {hasAutoRenewal != null && (
                <span className="text-xs text-gray-500">
                  <span className="font-medium text-gray-700">Auto-Renewal</span>{' '}
                  <span className={hasAutoRenewal ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>
                    {hasAutoRenewal ? 'Yes' : 'No'}
                  </span>
                </span>
              )}
            </div>
            {hasAutoRenewal && nextContractEndDate && (
              updateNextStep.isSuccess ? (
                <div className="flex items-center gap-1.5 text-xs text-green-700 font-medium">
                  <CheckCircle size={12} /> Next step updated in Salesforce
                </div>
              ) : (
                <button
                  disabled={updateNextStep.isPending}
                  onClick={() => {
                    const contractEnd = new Date(nextContractEndDate)
                    const startDate = new Date(contractEnd)
                    startDate.setDate(startDate.getDate() + 1)
                    const text = `Contract will auto-renew on ${fmtLong(contractEnd)} and start on ${fmtLong(startDate)}`
                    updateNextStep.mutate({ nextStep: text, nextStepDate: nextContractEndDate })
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-40"
                >
                  {updateNextStep.isPending
                    ? <><RefreshCw size={11} className="animate-spin" /> Updating...</>
                    : <><Check size={11} /> No Price Increase — Generate Next Step</>}
                </button>
              )
            )}
          </div>
        )}

        {sent ? (
          <div className="flex items-center gap-2 px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
            <CheckCircle size={15} /> Message sent to {opp.ownerEmail}
          </div>
        ) : (
          <div className="flex gap-3 justify-end">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
            <button onClick={onSend} disabled={sending} className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white text-sm font-medium rounded-lg hover:bg-brand-600 disabled:opacity-50">
              {sending ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />}
              {sending ? 'Sending...' : 'Send to rep'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Manager draft modal ───────────────────────────────────────────────────────

function ManagerDraftModal({ opp, sfdcBase, sending, sent, onSend, onClose }: {
  opp: OppGroup
  sfdcBase: string
  sending: boolean
  sent: boolean
  onSend: () => void
  onClose: () => void
}) {
  const preview = formatPreview(opp)
  const link = sfdcBase ? `${sfdcBase}/lightning/r/Opportunity/${opp.opportunityId}/view` : null

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900">Send to manager</h3>
          <button onClick={onClose}><X size={18} className="text-gray-400" /></button>
        </div>
        <div className="mb-4 text-sm text-gray-500">
          Sending to: <span className="font-medium text-gray-700">{opp.managerName ?? opp.managerEmail ?? 'Manager'}</span>
          <span className="text-gray-400 ml-1">re: {opp.ownerName ?? opp.ownerEmail}'s deal</span>
        </div>
        <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 mb-4">
          <p className="text-xs font-medium text-gray-400 uppercase mb-2">Slack message preview</p>
          <p className="text-sm font-medium text-gray-900 mb-1">
            FYI —{' '}
            {link ? (
              <a href={link} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline inline-flex items-center gap-0.5">
                {opp.opportunityName} <ExternalLink size={10} />
              </a>
            ) : opp.opportunityName}{' '}
            needs attention
          </p>
          {opp.accountName && <p className="text-xs text-gray-500 mb-2">{opp.accountName}</p>}
          <p className="text-xs text-gray-500 mb-2">{opp.ownerName ?? opp.ownerEmail}'s deal has been flagged:</p>
          <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans">{preview}</pre>
          <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-gray-200">
            <span className="px-2.5 py-1 rounded border border-gray-300 text-xs font-medium text-gray-600 bg-white">
              Open in Salesforce
            </span>
          </div>
        </div>
        {sent ? (
          <div className="flex items-center gap-2 px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
            <CheckCircle size={15} /> Message sent to {opp.managerName ?? opp.managerEmail}
          </div>
        ) : (
          <div className="flex gap-3 justify-end">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
            <button onClick={onSend} disabled={sending} className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white text-sm font-medium rounded-lg hover:bg-brand-600 disabled:opacity-50">
              {sending ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />}
              {sending ? 'Sending...' : 'Send to manager'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, icon, hint }: { label: string; value: number; icon: React.ReactNode; hint?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 px-6 py-5 flex items-center gap-4">
      <div className="p-2 bg-gray-50 rounded-lg">{icon}</div>
      <div>
        <div className="text-2xl font-bold text-gray-900">{value}</div>
        <div className="text-xs text-gray-500 mt-0.5">{label}</div>
        {hint && <div className="text-xs text-gray-400 mt-0.5">{hint}</div>}
      </div>
    </div>
  )
}
