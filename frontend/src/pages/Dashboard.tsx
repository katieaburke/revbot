import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { Play, RefreshCw, AlertCircle, Clock, CheckCircle, FlaskConical, ChevronDown, ChevronUp, Users } from 'lucide-react'
import clsx from 'clsx'

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
  ownerEmail: string
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

const alertTypeLabel: Record<string, string> = {
  PAST_DUE_INITIAL: 'Past Due — New Business',
  PAST_DUE_AMENDMENT: 'Past Due — Amendment',
  PAST_DUE_RENEWAL: 'Past Due — Renewal',
  STALLED: 'Stalled',
  MEDDPICC_MISSING: 'Missing MEDDPICC',
}

const alertTypeColor: Record<string, string> = {
  PAST_DUE_INITIAL: 'text-red-600 bg-red-50',
  PAST_DUE_AMENDMENT: 'text-red-600 bg-red-50',
  PAST_DUE_RENEWAL: 'text-orange-600 bg-orange-50',
  STALLED: 'text-yellow-700 bg-yellow-50',
  MEDDPICC_MISSING: 'text-purple-600 bg-purple-50',
}

export function Dashboard() {
  const qc = useQueryClient()
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null)
  const [expandedSection, setExpandedSection] = useState<'wouldSend' | 'wouldSkip' | 'unreachable' | null>('wouldSend')

  const { data: summary, isLoading } = useQuery<Summary>({
    queryKey: ['summary'],
    queryFn: () => api.get('/notifications/summary').then((r) => r.data),
    refetchInterval: 30_000,
  })

  const runNow = useMutation({
    mutationFn: () => api.post('/notifications/run-now'),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ['summary'] }), 3000),
  })

  const dryRun = useMutation({
    mutationFn: () => api.post('/notifications/dry-run').then((r) => r.data as DryRunResult),
    onSuccess: (data) => setDryRunResult(data),
  })

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">Dashboard</h2>
          <p className="text-sm text-gray-500 mt-1">Current pipeline health alerts</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => { setDryRunResult(null); dryRun.mutate() }}
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

      {/* Dry run banner */}
      {dryRun.isPending && (
        <div className="mb-6 px-4 py-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700 flex items-center gap-2">
          <RefreshCw size={14} className="animate-spin" />
          Running against live Salesforce + Gong data — this may take 30–60 seconds...
        </div>
      )}

      {/* Dry run results */}
      {dryRunResult && (
        <div className="mb-8 bg-white rounded-xl border border-blue-200 overflow-hidden">
          <div className="px-6 py-4 bg-blue-50 border-b border-blue-100 flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-blue-900 flex items-center gap-2">
                <FlaskConical size={16} /> Dry Run Results
              </h3>
              <p className="text-xs text-blue-700 mt-0.5">
                Scanned {dryRunResult.totalOpportunities} open opportunities — nothing was sent to Slack
              </p>
            </div>
            <div className="flex gap-4 text-sm">
              <span className="text-green-700 font-semibold">{dryRunResult.wouldSend.length} would send</span>
              <span className="text-gray-500">{dryRunResult.wouldSkip.length} skipped</span>
              <span className="text-orange-600">{dryRunResult.unreachable.length} unreachable</span>
            </div>
          </div>

          {dryRunResult.stallRulesActive === 0 && dryRunResult.meddpiccStagesActive === 0 && (
            <div className="px-6 py-4 bg-yellow-50 border-b border-yellow-100 text-sm text-yellow-800">
              ⚠️ No stall rules or MEDDPICC stages configured yet — go to <strong>Stall Rules</strong> and <strong>MEDDPICC Config</strong> to set them up before alerts will fire.
            </div>
          )}

          {/* Would Send */}
          <DryRunSection
            title="Would send"
            count={dryRunResult.wouldSend.length}
            alerts={dryRunResult.wouldSend}
            expanded={expandedSection === 'wouldSend'}
            onToggle={() => setExpandedSection(expandedSection === 'wouldSend' ? null : 'wouldSend')}
            emptyText="No alerts would be sent with current rules"
            badgeClass="bg-green-100 text-green-700"
          />

          {/* Unreachable */}
          {dryRunResult.unreachable.length > 0 && (
            <DryRunSection
              title="Owner not in Slack"
              count={dryRunResult.unreachable.length}
              alerts={dryRunResult.unreachable}
              expanded={expandedSection === 'unreachable'}
              onToggle={() => setExpandedSection(expandedSection === 'unreachable' ? null : 'unreachable')}
              emptyText=""
              badgeClass="bg-orange-100 text-orange-700"
              hint="These owners couldn't be found in Slack — check their email matches their Slack account"
            />
          )}

          {/* Would Skip */}
          {dryRunResult.wouldSkip.length > 0 && (
            <DryRunSection
              title="Would skip (cooldown / snoozed)"
              count={dryRunResult.wouldSkip.length}
              alerts={dryRunResult.wouldSkip}
              expanded={expandedSection === 'wouldSkip'}
              onToggle={() => setExpandedSection(expandedSection === 'wouldSkip' ? null : 'wouldSkip')}
              emptyText=""
              badgeClass="bg-gray-100 text-gray-600"
            />
          )}
        </div>
      )}

      {/* Live summary */}
      {isLoading ? (
        <div className="text-sm text-gray-500">Loading...</div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-4 mb-8">
            <StatCard label="Pending alerts" value={summary?.sent ?? 0} icon={<AlertCircle size={18} className="text-red-500" />} />
            <StatCard label="Snoozed" value={summary?.snoozed ?? 0} icon={<Clock size={18} className="text-yellow-500" />} />
            <StatCard label="Resolved" value={summary?.resolved ?? 0} icon={<CheckCircle size={18} className="text-green-500" />} />
          </div>

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="font-medium text-gray-900">Active alerts by type</h3>
            </div>
            <div className="divide-y divide-gray-100">
              {summary?.byType.length === 0 && (
                <div className="px-6 py-8 text-center text-sm text-gray-400">No active alerts</div>
              )}
              {summary?.byType.map((t) => (
                <div key={t.alertType} className="flex items-center justify-between px-6 py-3">
                  <span className="text-sm text-gray-700">{alertTypeLabel[t.alertType] ?? t.alertType}</span>
                  <span className="text-sm font-semibold text-gray-900">{t._count.id}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function DryRunSection({ title, count, alerts, expanded, onToggle, emptyText, badgeClass, hint }: {
  title: string
  count: number
  alerts: DryRunAlert[]
  expanded: boolean
  onToggle: () => void
  emptyText: string
  badgeClass: string
  hint?: string
}) {
  return (
    <div className="border-b border-gray-100 last:border-0">
      <button onClick={onToggle} className="w-full flex items-center justify-between px-6 py-3 hover:bg-gray-50 text-left">
        <div className="flex items-center gap-3">
          <span className={clsx('text-xs font-semibold px-2 py-0.5 rounded-full', badgeClass)}>{count}</span>
          <span className="text-sm font-medium text-gray-800">{title}</span>
          {hint && <span className="text-xs text-gray-400">{hint}</span>}
        </div>
        {expanded ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
      </button>

      {expanded && (
        <div className="px-6 pb-4">
          {alerts.length === 0 ? (
            <p className="text-sm text-gray-400 py-2">{emptyText}</p>
          ) : (
            <div className="space-y-2">
              {alerts.map((a, i) => (
                <div key={i} className="flex items-start justify-between py-2 border-b border-gray-50 last:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className={clsx('text-xs font-medium px-1.5 py-0.5 rounded', alertTypeColor[a.alertType] ?? 'bg-gray-100 text-gray-600')}>
                        {alertTypeLabel[a.alertType] ?? a.alertType}
                      </span>
                      <span className="text-sm font-medium text-gray-900 truncate">{a.opportunityName}</span>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-gray-400">
                      <Users size={10} />
                      {a.ownerEmail}
                      {a.skipReason && <span className="ml-2 text-yellow-600">— {a.skipReason}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

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
