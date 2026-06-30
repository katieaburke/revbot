import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import {
  RefreshCw,
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Calendar,
  Phone,
  Building2,
} from 'lucide-react'
import clsx from 'clsx'

// ── Types ─────────────────────────────────────────────────────────────────────

type ProspectingFlagType = 'STALE_PROSPECTING' | 'SHOULD_BE_PROSPECTING'

interface ProspectingFlag {
  flagType: ProspectingFlagType
  accountId: string
  accountName: string
  recordTypeName: string | null
  ownerEmail: string
  ownerName: string | null
  prospectingStatus: string | null
  lastRepCommunicationDate: string | null
  targetProspectingDate: string | null
  reEngageDate: string | null
  competitorEndDate: string | null
  daysSinceLastRepContact: number | null
  gongLastCallDate: string | null
  gongTotalCalls: number
  daysSinceLastGongCall: number | null
  contactEmails: string[]
}

interface HygieneResult {
  scannedAt: string
  totalAccounts: number
  flags: ProspectingFlag[]
  config: {
    recordTypeFilter: string
    staleThresholdDays: number
    recentActivityDays: number
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function daysAgoLabel(days: number | null): string | null {
  if (days === null) return null
  if (days === 0) return 'today'
  if (days === 1) return '1 day ago'
  return `${days} days ago`
}

// ── ProspectingHygiene page ───────────────────────────────────────────────────

export function ProspectingHygiene() {
  const [ownerFilter, setOwnerFilter] = useState('')
  const [staleOpen, setStaleOpen] = useState(true)
  const [shouldPromoteOpen, setShouldPromoteOpen] = useState(true)

  const { data, isFetching, isError, error, refetch, isFetched } = useQuery<HygieneResult>({
    queryKey: ['prospecting-hygiene'],
    queryFn: () => api.get('/accounts/prospecting-hygiene').then((r) => r.data),
    enabled: false,
    refetchOnWindowFocus: false,
  })

  const staleFlags = useMemo(
    () => (data?.flags ?? []).filter((f) => f.flagType === 'STALE_PROSPECTING'),
    [data]
  )
  const shouldPromoteFlags = useMemo(
    () => (data?.flags ?? []).filter((f) => f.flagType === 'SHOULD_BE_PROSPECTING'),
    [data]
  )

  // Unique owners across all flags
  const owners = useMemo(() => {
    if (!data) return []
    const ownerMap = new Map<string, string>()
    for (const f of data.flags) {
      ownerMap.set(f.ownerEmail, f.ownerName ?? f.ownerEmail)
    }
    return Array.from(ownerMap.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [data])

  function applyOwnerFilter(flags: ProspectingFlag[]) {
    if (!ownerFilter) return flags
    return flags.filter((f) => f.ownerEmail === ownerFilter)
  }

  const filteredStale = applyOwnerFilter(staleFlags)
  const filteredShouldPromote = applyOwnerFilter(shouldPromoteFlags)

  return (
    <div className="p-8 max-w-5xl">

      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">Prospecting Hygiene</h2>
          <p className="text-sm text-gray-500 mt-1">Enterprise accounts in Prospect stage</p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50"
        >
          {isFetching ? <RefreshCw size={15} className="animate-spin" /> : <Building2 size={15} />}
          Scan accounts
        </button>
      </div>

      {/* Loading state */}
      {isFetching && (
        <div className="mb-6 bg-blue-50 border border-blue-200 rounded-xl p-6 flex flex-col items-center gap-3 text-center">
          <RefreshCw size={28} className="animate-spin text-blue-500" />
          <div>
            <p className="font-medium text-blue-800">Scanning accounts...</p>
            <p className="text-sm text-blue-600 mt-0.5">Pulling live Salesforce + Gong data — this takes 10–20 seconds</p>
          </div>
          <div className="w-full bg-blue-100 rounded-full h-1.5 overflow-hidden mt-1">
            <div className="h-1.5 bg-blue-400 rounded-full animate-pulse w-2/3" />
          </div>
        </div>
      )}

      {/* Error state */}
      {isError && (
        <div className="mb-6 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <strong>Scan failed:</strong> {String((error as { message?: string })?.message ?? error)}
        </div>
      )}

      {/* Empty / not yet scanned */}
      {!isFetching && !data && !isError && (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-sm text-gray-400">
          <Building2 size={32} className="mx-auto mb-3 text-gray-300" />
          <p className="font-medium text-gray-500 mb-1">No scan results yet</p>
          <p className="text-xs">Click "Scan accounts" to check prospecting hygiene.</p>
        </div>
      )}

      {/* Results */}
      {data && !isFetching && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-white rounded-xl border border-gray-200 px-6 py-5 flex items-center gap-4">
              <div className="p-2 bg-gray-50 rounded-lg">
                <Building2 size={18} className="text-gray-500" />
              </div>
              <div>
                <div className="text-2xl font-bold text-gray-900">{data.totalAccounts}</div>
                <div className="text-xs text-gray-500 mt-0.5">Accounts scanned</div>
                <div className="text-xs text-gray-400 mt-0.5">{data.config.recordTypeFilter} record type</div>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 px-6 py-5 flex items-center gap-4">
              <div className="p-2 bg-gray-50 rounded-lg">
                <AlertCircle size={18} className="text-red-500" />
              </div>
              <div>
                <div className="text-2xl font-bold text-gray-900">{staleFlags.length}</div>
                <div className="text-xs text-gray-500 mt-0.5">Stale prospecting</div>
                <div className="text-xs text-gray-400 mt-0.5">In "Prospecting", no recent activity</div>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 px-6 py-5 flex items-center gap-4">
              <div className="p-2 bg-gray-50 rounded-lg">
                <CheckCircle size={18} className="text-blue-500" />
              </div>
              <div>
                <div className="text-2xl font-bold text-gray-900">{shouldPromoteFlags.length}</div>
                <div className="text-xs text-gray-500 mt-0.5">Should be Prospecting</div>
                <div className="text-xs text-gray-400 mt-0.5">In "Planned" with recent activity</div>
              </div>
            </div>
          </div>

          {/* Scanned at + filters */}
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <p className="text-xs text-gray-400">
              Scanned {new Date(data.scannedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              {' · '}stale threshold: {data.config.staleThresholdDays}d
              {' · '}recent activity window: {data.config.recentActivityDays}d
            </p>
            {owners.length > 1 && (
              <select
                value={ownerFilter}
                onChange={(e) => setOwnerFilter(e.target.value)}
                className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700"
              >
                <option value="">All owners</option>
                {owners.map(([email, name]) => (
                  <option key={email} value={email}>{name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Stale Prospecting section */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-4">
            <button
              onClick={() => setStaleOpen((o) => !o)}
              className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-50 text-left border-b border-gray-100"
            >
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                  {filteredStale.length}
                </span>
                <span className="text-sm font-semibold text-gray-800">Stale Prospecting</span>
                <span className="text-xs text-gray-400">In "Prospecting" status with no recent activity</span>
              </div>
              {staleOpen ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
            </button>

            {staleOpen && (
              <div className="divide-y divide-gray-100">
                {filteredStale.length === 0 ? (
                  <div className="px-6 py-6 text-center text-sm text-gray-400">No stale prospecting accounts</div>
                ) : (
                  filteredStale.map((flag) => (
                    <AccountRow key={flag.accountId} flag={flag} />
                  ))
                )}
              </div>
            )}
          </div>

          {/* Should be Prospecting section */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <button
              onClick={() => setShouldPromoteOpen((o) => !o)}
              className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-50 text-left border-b border-gray-100"
            >
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                  {filteredShouldPromote.length}
                </span>
                <span className="text-sm font-semibold text-gray-800">Should Move to Prospecting</span>
                <span className="text-xs text-gray-400">In "Planned" status with recent activity</span>
              </div>
              {shouldPromoteOpen ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
            </button>

            {shouldPromoteOpen && (
              <div className="divide-y divide-gray-100">
                {filteredShouldPromote.length === 0 ? (
                  <div className="px-6 py-6 text-center text-sm text-gray-400">No accounts to promote</div>
                ) : (
                  filteredShouldPromote.map((flag) => (
                    <AccountRow key={flag.accountId} flag={flag} />
                  ))
                )}
              </div>
            )}
          </div>

          {isFetched && data.flags.length === 0 && (
            <div className="mt-4 px-4 py-3 bg-green-50 border border-green-200 rounded-xl text-sm text-green-700 text-center">
              No hygiene issues found — all accounts look good!
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── AccountRow ────────────────────────────────────────────────────────────────

function AccountRow({ flag }: { flag: ProspectingFlag }) {
  const sfdcBase = 'https://uberall.lightning.force.com'
  const accountLink = `${sfdcBase}/lightning/r/Account/${flag.accountId}/view`

  const statusBadgeClass =
    flag.flagType === 'STALE_PROSPECTING'
      ? 'bg-red-50 text-red-700'
      : 'bg-blue-50 text-blue-700'

  const visibleEmails = flag.contactEmails.slice(0, 2)
  const extraEmailCount = flag.contactEmails.length - 2

  return (
    <div className="px-6 py-4 hover:bg-gray-50">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">

          {/* Account name + status badge */}
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <a
              href={accountLink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold text-gray-900 hover:text-brand-600 flex items-center gap-1"
            >
              {flag.accountName}
              <ExternalLink size={11} className="text-gray-400" />
            </a>
            <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full', statusBadgeClass)}>
              {flag.prospectingStatus ?? 'Unknown'}
            </span>
            {flag.recordTypeName && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                {flag.recordTypeName}
              </span>
            )}
          </div>

          {/* Owner */}
          <p className="text-xs text-gray-500 mb-2">{flag.ownerName ?? flag.ownerEmail}</p>

          {/* Date fields grid */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs mb-2">

            {/* Last Rep Communication */}
            <div className="flex items-center gap-1.5">
              <Calendar size={11} className="text-gray-400 shrink-0" />
              <span className="text-gray-500">Last rep contact:</span>
              <span className={clsx('font-medium', flag.lastRepCommunicationDate ? 'text-gray-800' : 'text-gray-400')}>
                {fmtDate(flag.lastRepCommunicationDate)}
              </span>
              {flag.daysSinceLastRepContact !== null && (
                <span className="text-gray-400">({daysAgoLabel(flag.daysSinceLastRepContact)})</span>
              )}
            </div>

            {/* Target Prospecting Date */}
            <div className="flex items-center gap-1.5">
              <Calendar size={11} className="text-gray-400 shrink-0" />
              <span className="text-gray-500">Target date:</span>
              <span className={clsx('font-medium', flag.targetProspectingDate ? 'text-gray-800' : 'text-gray-400')}>
                {fmtDate(flag.targetProspectingDate)}
              </span>
            </div>

            {/* Re-engage Date */}
            <div className="flex items-center gap-1.5">
              <Calendar size={11} className="text-gray-400 shrink-0" />
              <span className="text-gray-500">Re-engage:</span>
              <span className={clsx('font-medium', flag.reEngageDate ? 'text-gray-800' : 'text-gray-400')}>
                {fmtDate(flag.reEngageDate)}
              </span>
            </div>

            {/* Competitor End Date */}
            <div className="flex items-center gap-1.5">
              <Calendar size={11} className="text-gray-400 shrink-0" />
              <span className="text-gray-500">Competitor end:</span>
              <span className={clsx('font-medium', flag.competitorEndDate ? 'text-gray-800' : 'text-gray-400')}>
                {fmtDate(flag.competitorEndDate)}
              </span>
            </div>

          </div>

          {/* Gong + contacts row */}
          <div className="flex items-center gap-4 flex-wrap text-xs">

            {/* Gong activity */}
            <div className="flex items-center gap-1.5">
              <Phone size={11} className="text-gray-400 shrink-0" />
              <span className="text-gray-500">Gong:</span>
              {flag.gongTotalCalls === 0 ? (
                <span className="text-gray-400">No calls</span>
              ) : (
                <>
                  <span className="font-medium text-gray-800">{flag.gongTotalCalls} call{flag.gongTotalCalls !== 1 ? 's' : ''}</span>
                  {flag.gongLastCallDate && (
                    <span className="text-gray-400">
                      · last {fmtDate(flag.gongLastCallDate)}
                      {flag.daysSinceLastGongCall !== null && (
                        <span className="ml-1">({daysAgoLabel(flag.daysSinceLastGongCall)})</span>
                      )}
                    </span>
                  )}
                </>
              )}
            </div>

            {/* Contact emails */}
            {flag.contactEmails.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-gray-500">Contacts:</span>
                {visibleEmails.map((email) => (
                  <span key={email} className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-600">{email}</span>
                ))}
                {extraEmailCount > 0 && (
                  <span className="text-gray-400">+{extraEmailCount} more</span>
                )}
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  )
}
