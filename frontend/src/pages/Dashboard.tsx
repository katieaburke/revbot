import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import {
  AlertCircle, Clock, BellOff, CheckCircle, RefreshCw, Play,
  ArrowRight, Building2, Shield,
} from 'lucide-react'
import clsx from 'clsx'

// ── Types ─────────────────────────────────────────────────────────────────────

type SkipType = 'cooldown' | 'snoozed_owner' | 'snoozed_revops'

interface DryRunAlert {
  opportunityId: string
  skipType?: SkipType
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

function countUniqueOpps(alerts: DryRunAlert[]): number {
  return new Set(alerts.map((a) => a.opportunityId)).size
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export function Dashboard() {
  const qc = useQueryClient()
  const navigate = useNavigate()

  const [dryRunOverride, setDryRunOverride] = useState<DryRunResult | null>(null)
  const [dryRunError, setDryRunError] = useState<string | null>(null)

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

  // ── Derived counts ──────────────────────────────────────────────────────────

  const wouldSendCount = dryRunResult ? countUniqueOpps(dryRunResult.wouldSend) : 0
  const cooldownCount = dryRunResult
    ? countUniqueOpps(dryRunResult.wouldSkip.filter((a) => a.skipType === 'cooldown' || !a.skipType))
    : 0
  const snoozedRevopsCount = dryRunResult
    ? countUniqueOpps(dryRunResult.wouldSkip.filter((a) => a.skipType === 'snoozed_revops'))
    : 0
  const snoozedOwnerCount = dryRunResult
    ? countUniqueOpps(dryRunResult.wouldSkip.filter((a) => a.skipType === 'snoozed_owner'))
    : 0
  const resolvedCount = dryRunResult ? (dryRunResult.resolved ?? []).length : 0

  // Prospecting counts from cache
  const staleAccountCount = prospectingData
    ? prospectingData.flags.filter((f) => f.flagType === 'STALE').length
    : null
  const shouldProspectCount = prospectingData
    ? prospectingData.flags.filter((f) => f.flagType === 'SHOULD_PROSPECT').length
    : null

  // suppress unused warning — settings is fetched for side effects (sfdcBase if needed later)
  void settings

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
              value={wouldSendCount}
              icon={<AlertCircle size={20} />}
              iconClass="text-red-500"
              onClick={() => navigate('/pipe-hygiene?tab=wouldSend')}
            />
            <MetricCard
              label="In Cooldown"
              value={cooldownCount}
              icon={<Clock size={20} />}
              iconClass="text-blue-400"
              onClick={() => navigate('/pipe-hygiene?tab=cooldown')}
            />
            <MetricCard
              label="Snoozed (RevOps)"
              value={snoozedRevopsCount}
              icon={<BellOff size={20} />}
              iconClass="text-amber-500"
              onClick={() => navigate('/pipe-hygiene?tab=snoozedRevops')}
            />
            <MetricCard
              label="Snoozed (Rep)"
              value={snoozedOwnerCount}
              icon={<BellOff size={20} />}
              iconClass="text-yellow-500"
              onClick={() => navigate('/pipe-hygiene?tab=snoozedOwner')}
            />
            <MetricCard
              label="Resolved"
              value={resolvedCount}
              icon={<CheckCircle size={20} />}
              iconClass="text-emerald-500"
              onClick={() => navigate('/pipe-hygiene?tab=resolved')}
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
            onClick={() => navigate('/playbook/accounts')}
          />
          <MetricCard
            label="Should Be Prospecting"
            value={shouldProspectCount}
            icon={<AlertCircle size={20} />}
            iconClass="text-red-400"
            onClick={() => navigate('/playbook/accounts')}
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
}: {
  label: string
  value: number | null
  icon: React.ReactNode
  iconClass: string
  onClick?: () => void
}) {
  return (
    <div
      className={clsx(
        'bg-white rounded-2xl border border-gray-200 p-5 transition-all',
        onClick && 'cursor-pointer hover:border-brand-300 hover:shadow-sm',
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
