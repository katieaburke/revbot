import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import {
  Play, RefreshCw, AlertCircle, Clock, CheckCircle, FlaskConical,
  ChevronDown, ChevronUp, ExternalLink, Trash2, MessageSquare, X, Send,
  Briefcase, Building2,
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
  wouldSkip: boolean
  skipReason?: string
  details: Record<string, unknown>
}

interface DryRunResult {
  totalOpportunities: number
  wouldSend: DryRunAlert[]
  wouldSkip: DryRunAlert[]
  unreachable: DryRunAlert[]
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
        alerts: [],
      })
    }
    map.get(a.opportunityId)!.alerts.push(a)
  }
  return Array.from(map.values())
}

function uniqueVals(groups: OppGroup[], key: keyof OppGroup): string[] {
  return Array.from(new Set(groups.map((g) => g[key] as string | null).filter(Boolean) as string[])).sort()
}

function applyFilters(groups: OppGroup[], filters: { channel: string; fn: string; region: string; owner: string }): OppGroup[] {
  return groups.filter((g) =>
    (!filters.channel || g.salesChannel === filters.channel) &&
    (!filters.fn || g.salesFunction === filters.fn) &&
    (!filters.region || g.salesRegion === filters.region) &&
    (!filters.owner || g.ownerEmail === filters.owner)
  )
}

// Summary-level labels (one per alert type row)
const alertTypeLabel: Record<string, string> = {
  PAST_DUE_INITIAL:    'Past Due Close Date',
  PAST_DUE_AMENDMENT:  'Past Due Close Date',
  PAST_DUE_RENEWAL:    'Past Due Booking Date',
  STALLED:             'Zombie Pipeline',
  MEDDPICC_MISSING:    'Missing MEDDPICC / BANT',
  NEXT_STEP_MISSING:   'Missing Next Step',
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
    case 'STALLED':
      return [{ label: 'Zombie Pipeline', color: 'text-yellow-700 bg-yellow-50' }]
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

// ── Dashboard ─────────────────────────────────────────────────────────────────

export function Dashboard() {
  const qc = useQueryClient()
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null)
  const [dryRunError, setDryRunError] = useState<string | null>(null)
  const [expandedSection, setExpandedSection] = useState<'wouldSend' | 'wouldSkip' | 'unreachable' | null>('wouldSend')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [draftOpp, setDraftOpp] = useState<OppGroup | null>(null)
  const [draftSent, setDraftSent] = useState<string | null>(null)
  const [filters, setFilters] = useState({ channel: '', fn: '', region: '', owner: '' })

  const { data: summary, isLoading } = useQuery<Summary>({
    queryKey: ['summary'],
    queryFn: () => api.get('/notifications/summary').then((r) => r.data),
    refetchInterval: 30_000,
  })

  const { data: settings } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: () => api.get('/config/settings').then((r) => r.data),
  })

  // Fetch per-opp sent counts whenever dry run result changes
  const allDryRunOppIds = useMemo(() => {
    if (!dryRunResult) return []
    const ids = new Set([
      ...dryRunResult.wouldSend.map((a) => a.opportunityId),
      ...dryRunResult.wouldSkip.map((a) => a.opportunityId),
      ...dryRunResult.unreachable.map((a) => a.opportunityId),
    ])
    return Array.from(ids)
  }, [dryRunResult])

  const { data: oppCounts = {} } = useQuery<Record<string, number>>({
    queryKey: ['opp-counts', allDryRunOppIds],
    queryFn: () =>
      allDryRunOppIds.length
        ? api.get(`/notifications/opp-counts?oppIds=${allDryRunOppIds.join(',')}`).then((r) => r.data)
        : Promise.resolve({}),
    enabled: allDryRunOppIds.length > 0,
  })

  const sfdcBase = settings?.sfdcInstanceUrl?.replace(/\/$/, '') ?? ''

  const runNow = useMutation({
    mutationFn: () => api.post('/notifications/run-now'),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ['summary'] }), 3000),
  })

  const dryRun = useMutation({
    mutationFn: () => api.post('/notifications/dry-run').then((r) => r.data as DryRunResult),
    onSuccess: (data) => { setDryRunResult(data); setDryRunError(null) },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? String(err)
      setDryRunError(msg)
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
    onSuccess: (_data, g) => setDraftSent(g.opportunityId),
  })

  const deleteOpp = useMutation({
    mutationFn: (id: string) => api.delete(`/notifications/sfdc-opportunity/${id}`),
    onSuccess: (_data, id) => {
      setDeletingId(null)
      setConfirmDeleteId(null)
      if (dryRunResult) {
        setDryRunResult({
          ...dryRunResult,
          wouldSend: dryRunResult.wouldSend.filter((a) => a.opportunityId !== id),
          wouldSkip: dryRunResult.wouldSkip.filter((a) => a.opportunityId !== id),
          unreachable: dryRunResult.unreachable.filter((a) => a.opportunityId !== id),
        })
      }
    },
    onError: () => setDeletingId(null),
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
          <h2 className="text-2xl font-semibold text-gray-900">Dashboard</h2>
          <p className="text-sm text-gray-500 mt-1">Pipeline and account health</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => { setDryRunResult(null); setDryRunError(null); dryRun.mutate() }}
            disabled={dryRun.isPending}
            className="flex items-center gap-2 px-4 py-2 border border-gray-200 bg-white text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
          >
            {dryRun.isPending ? <RefreshCw size={15} className="animate-spin" /> : <FlaskConical size={15} />}
            Dry run
          </button>
          <button
            onClick={() => runNow.mutate()}
            disabled={runNow.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50"
          >
            {runNow.isPending ? <RefreshCw size={15} className="animate-spin" /> : <Play size={15} />}
            Send alerts
          </button>
        </div>
      </div>

      {/* Dry run loading */}
      {dryRun.isPending && (
        <div className="mb-6 bg-blue-50 border border-blue-200 rounded-xl p-6 flex flex-col items-center gap-3 text-center">
          <RefreshCw size={28} className="animate-spin text-blue-500" />
          <div>
            <p className="font-medium text-blue-800">Running dry run...</p>
            <p className="text-sm text-blue-600 mt-0.5">Scanning live Salesforce + Gong data — this takes 30–60 seconds</p>
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
      {!isLoading && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <StatCard label="Pending alerts" value={summary?.sent ?? 0} icon={<AlertCircle size={18} className="text-red-500" />} />
          <StatCard label="Snoozed" value={summary?.snoozed ?? 0} icon={<Clock size={18} className="text-yellow-500" />} />
          <StatCard label="Resolved" value={summary?.resolved ?? 0} icon={<CheckCircle size={18} className="text-green-500" />} />
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
              </p>
            </div>
            <div className="flex gap-4 text-xs font-medium">
              <span className="text-green-700">{groupByOpp(dryRunResult.wouldSend).length} would send</span>
              <span className="text-gray-500">{groupByOpp(dryRunResult.wouldSkip).length} skipped</span>
              <span className="text-orange-600">{groupByOpp(dryRunResult.unreachable).length} unreachable</span>
            </div>
          </div>

          {dryRunResult.stallRulesActive === 0 && dryRunResult.meddpiccStagesActive === 0 && (
            <div className="px-6 py-3 bg-yellow-50 border-b border-yellow-100 text-xs text-yellow-800">
              ⚠️ No stall rules or MEDDPICC stages configured — go to Playbook to set them up.
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
            // unique owners: [{email, name}] sorted by name/email
            const ownerMap = new Map<string, string>()
            for (const g of allGroups) ownerMap.set(g.ownerEmail, g.ownerName ?? g.ownerEmail)
            const owners = Array.from(ownerMap.entries()).sort((a, b) => a[1].localeCompare(b[1]))

            const hasFilters = channels.length > 0 || fns.length > 0 || regions.length > 0 || owners.length > 1
            if (!hasFilters) return null
            const anyActive = filters.channel || filters.fn || filters.region || filters.owner
            return (
              <div className="px-6 py-3 border-b border-gray-100 flex items-center gap-3 flex-wrap bg-gray-50">
                <span className="text-xs font-medium text-gray-500">Filter</span>
                {owners.length > 1 && (
                  <select value={filters.owner} onChange={(e) => setFilters((f) => ({ ...f, owner: e.target.value }))} className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700">
                    <option value="">All owners</option>
                    {owners.map(([email, name]) => <option key={email} value={email}>{name}</option>)}
                  </select>
                )}
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
                  <button onClick={() => setFilters({ channel: '', fn: '', region: '', owner: '' })} className="text-xs text-gray-400 hover:text-gray-700 underline">Clear</button>
                )}
              </div>
            )
          })()}

          <OppSection
            title="Would send"
            groups={applyFilters(groupByOpp(dryRunResult.wouldSend), filters)}
            expanded={expandedSection === 'wouldSend'}
            onToggle={() => setExpandedSection(expandedSection === 'wouldSend' ? null : 'wouldSend')}
            emptyText="No alerts would be sent with current rules"
            badgeClass="bg-green-100 text-green-700"
            sfdcLink={sfdcLink}
            onDelete={handleDelete}
            onDraft={setDraftOpp}
            confirmDeleteId={confirmDeleteId}
            deletingId={deletingId}
            oppCounts={oppCounts}
          />

          {dryRunResult.unreachable.length > 0 && (
            <OppSection
              title="Owner not in Slack"
              groups={applyFilters(groupByOpp(dryRunResult.unreachable), filters)}
              expanded={expandedSection === 'unreachable'}
              onToggle={() => setExpandedSection(expandedSection === 'unreachable' ? null : 'unreachable')}
              emptyText=""
              badgeClass="bg-orange-100 text-orange-700"
              hint="Owner email doesn't match a Slack account"
              sfdcLink={sfdcLink}
              onDelete={handleDelete}
              onDraft={setDraftOpp}
              confirmDeleteId={confirmDeleteId}
              deletingId={deletingId}
              oppCounts={oppCounts}
            />
          )}

          {dryRunResult.wouldSkip.length > 0 && (
            <OppSection
              title="Skipped (cooldown / snoozed)"
              groups={applyFilters(groupByOpp(dryRunResult.wouldSkip), filters)}
              expanded={expandedSection === 'wouldSkip'}
              onToggle={() => setExpandedSection(expandedSection === 'wouldSkip' ? null : 'wouldSkip')}
              emptyText=""
              badgeClass="bg-gray-100 text-gray-500"
              sfdcLink={sfdcLink}
              onDelete={handleDelete}
              onDraft={setDraftOpp}
              confirmDeleteId={confirmDeleteId}
              deletingId={deletingId}
              oppCounts={oppCounts}
            />
          )}
        </div>
      )}

      {/* ── ACCOUNTS SECTION ──────────────────────────────────────────────── */}
      <SectionHeader icon={<Building2 size={16} />} title="Accounts" />

      <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-sm text-gray-400">
        <Building2 size={28} className="mx-auto mb-3 text-gray-300" />
        <p className="font-medium text-gray-500 mb-1">Account checks coming soon</p>
        <p className="text-xs">Add the signals you want to monitor for accounts in the Playbook.</p>
      </div>

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

function OppSection({ title, groups, expanded, onToggle, emptyText, badgeClass, hint, sfdcLink, onDelete, onDraft, confirmDeleteId, deletingId, oppCounts }: {
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
  confirmDeleteId: string | null
  deletingId: string | null
  oppCounts: Record<string, number>
}) {
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
                const sentCount = oppCounts[g.opportunityId] ?? 0
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
                        {sentCount > 0 && (
                          <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 font-medium" title={`${sentCount} alert${sentCount === 1 ? '' : 's'} sent`}>
                            {sentCount} sent
                          </span>
                        )}
                      </div>
                      {g.accountName && <p className="text-xs text-gray-500 mb-1">{g.accountName}</p>}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {g.alerts.flatMap((a, i) =>
                          getAlertTags(a).map((tag, j) => (
                            <span key={`${i}-${j}`} className={clsx('text-xs font-medium px-1.5 py-0.5 rounded', tag.color)}>
                              {tag.label}
                              {j === 0 && a.skipReason && ` — ${a.skipReason}`}
                            </span>
                          ))
                        )}
                      </div>
                      <p className="text-xs text-gray-400 mt-1">{g.ownerName ?? g.ownerEmail}</p>
                    </div>
                    <div className="ml-3 flex-shrink-0 flex items-center gap-1">
                      <button onClick={() => onDraft(g)} className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-brand-600 hover:bg-brand-50" title="Draft message to rep">
                        <MessageSquare size={11} /> Draft
                      </button>
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

// ── Draft modal ───────────────────────────────────────────────────────────────

function formatPreview(opp: OppGroup): string {
  const lines: string[] = []
  for (const a of opp.alerts) {
    const d = a.details
    if (a.alertType === 'MEDDPICC_MISSING') {
      const fields = (d.missingFields as string[] | undefined) ?? []
      const labels: Record<string, string> = {
        metrics: 'Metrics', economicBuyer: 'Economic Buyer', decisionCriteria: 'Decision Criteria',
        decisionProcess: 'Decision Process', paperProcess: 'Paper Process', identifyPain: 'Identify Pain',
        champion: 'Champion', competition: 'Competition', budget: 'Budget', authority: 'Authority',
        need: 'Need', timing: 'Timing',
      }
      lines.push(`📋 Missing fields: ${fields.map((f) => labels[f] ?? f).join(', ')}`)
    } else if (a.alertType === 'STALLED') {
      const reasons = (d.triggeredBy as Array<{ type: string; days?: number; threshold?: number }> | undefined) ?? []
      for (const r of reasons) {
        if (r.type === 'deal_age') lines.push(`🔴 Deal open for ${r.days} days (threshold: ${r.threshold}d)`)
        else if (r.type === 'stage_duration') lines.push(`🔴 In current stage for ${r.days} days (threshold: ${r.threshold}d)`)
        else if (r.type === 'gong_inactivity') lines.push(`🔴 No Gong activity in ${r.days} days`)
        else if (r.type === 'single_threaded') lines.push(`⚠️ Single-threaded deal`)
        else if (r.type === 'red_flag') lines.push(`🚩 Gong risk phrases detected`)
      }
    } else if (a.alertType.startsWith('PAST_DUE')) {
      lines.push(`📅 Past due: booking date was ${d.bookingDate} (${d.daysOverdue} days ago)`)
    }
  }
  return lines.join('\n')
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

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-gray-900">Draft message to rep</h3>
          <button onClick={onClose}><X size={18} className="text-gray-400" /></button>
        </div>
        <div className="mb-4 text-sm text-gray-500">
          Sending to: <span className="font-medium text-gray-700">{opp.ownerEmail}</span>
        </div>
        <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 mb-4">
          <p className="text-xs font-medium text-gray-400 uppercase mb-2">Slack message preview</p>
          <p className="text-sm font-medium text-gray-900 mb-1">
            👋 Action needed on{' '}
            {link ? (
              <a href={link} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline inline-flex items-center gap-0.5">
                {opp.opportunityName} <ExternalLink size={10} />
              </a>
            ) : opp.opportunityName}
          </p>
          {opp.accountName && <p className="text-xs text-gray-500 mb-2">{opp.accountName}</p>}
          <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans">{preview}</pre>
        </div>
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

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 px-6 py-5 flex items-center gap-4">
      <div className="p-2 bg-gray-50 rounded-lg">{icon}</div>
      <div>
        <div className="text-2xl font-bold text-gray-900">{value}</div>
        <div className="text-xs text-gray-500 mt-0.5">{label}</div>
      </div>
    </div>
  )
}
