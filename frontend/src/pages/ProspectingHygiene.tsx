import { useState, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
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
  Settings,
  Save,
  Workflow,
  Send,
  X,
  Pencil,
  Check,
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
  bdrEmail: string | null
  bdrName: string | null
  prospectingStatus: string | null
  prospectingPauseReason: string | null
  lastRepCommunicationDate: string | null
  targetProspectingDate: string | null
  reEngageDate: string | null
  competitorEndDate: string | null
  competitor: string | null
  daysSinceLastRepContact: number | null
  gongLastCallDate: string | null
  gongTotalCalls: number
  daysSinceLastGongCall: number | null
  contactEmails: string[]
  gongFlowStats: {
    activeWithOverdue: number
    activeOnTrack: number
    completedSinceTarget: number
  } | null
}

interface NudgeEntry {
  sentAt: string
  bdrEmail: string
  flagType: string
}

interface HygieneResult {
  scannedAt: string
  totalAccounts: number
  flags: ProspectingFlag[]
  nudgeLog: Record<string, NudgeEntry>
  config: {
    recordTypeFilter: string
    staleThresholdDays: number
    recentActivityDays: number
  }
}

function businessDaysSince(isoDate: string): number {
  const from = new Date(isoDate)
  const now = new Date()
  let count = 0
  const cursor = new Date(from)
  cursor.setHours(0, 0, 0, 0)
  cursor.setDate(cursor.getDate() + 1)
  while (cursor <= now) {
    const day = cursor.getDay()
    if (day !== 0 && day !== 6) count++
    cursor.setDate(cursor.getDate() + 1)
  }
  return count
}

interface AppSettings {
  sfdcInstanceUrl?: string
  accountRecordTypeFilter?: string
  prospectingStaleThresholdDays?: number
  prospectingRecentActivityDays?: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  // SFDC date-only fields (YYYY-MM-DD) parse as UTC midnight → off-by-one in negative-offset timezones.
  // Treat them as local noon to guarantee the correct calendar date everywhere.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T12:00:00') : new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function daysAgoLabel(days: number | null): string | null {
  if (days === null) return null
  if (days === 0) return 'today'
  if (days === 1) return '1 day ago'
  return `${days} days ago`
}

// ── ProspectingHygiene page ───────────────────────────────────────────────────

export function ProspectingHygiene() {
  const qc = useQueryClient()
  const [bdrFilter, setBdrFilter] = useState('')
  const [monthFilter, setMonthFilter] = useState('')          // "YYYY-MM" or ""
  const [dateCompare, setDateCompare] = useState<'before' | 'after' | ''>('')  // before/after filter mode
  const [dateFilterValue, setDateFilterValue] = useState('') // ISO date string "YYYY-MM-DD"
  const [staleOpen, setStaleOpen] = useState(true)
  const [shouldPromoteOpen, setShouldPromoteOpen] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [savedSettings, setSavedSettings] = useState(false)

  // Local editable state for settings
  const [recordTypeFilter, setRecordTypeFilter] = useState('Enterprise_Account_Record')
  const [staleThresholdDays, setStaleThresholdDays] = useState('14')
  const [recentActivityDays, setRecentActivityDays] = useState('14')

  const { data: appSettings } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: () => api.get('/config/settings').then((r) => r.data),
  })

  // Sync local state from persisted settings
  useEffect(() => {
    if (appSettings?.accountRecordTypeFilter != null) {
      setRecordTypeFilter(String(appSettings.accountRecordTypeFilter))
    }
    if (appSettings?.prospectingStaleThresholdDays != null) {
      setStaleThresholdDays(String(appSettings.prospectingStaleThresholdDays))
    }
    if (appSettings?.prospectingRecentActivityDays != null) {
      setRecentActivityDays(String(appSettings.prospectingRecentActivityDays))
    }
  }, [appSettings])

  const saveSettings = useMutation({
    mutationFn: () =>
      api.put('/config/settings', {
        accountRecordTypeFilter: recordTypeFilter.trim(),
        prospectingStaleThresholdDays: Number(staleThresholdDays) || 14,
        prospectingRecentActivityDays: Number(recentActivityDays) || 14,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] })
      setSavedSettings(true)
      setTimeout(() => setSavedSettings(false), 2000)
    },
  })

  const [lastSentAccountId, setLastSentAccountId] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [previewFlag, setPreviewFlag] = useState<ProspectingFlag | null>(null)

  const notifyBdr = useMutation({
    mutationFn: (flag: ProspectingFlag) =>
      api.post('/accounts/notify-bdr', {
        accountId: flag.accountId,
        accountName: flag.accountName,
        flagType: flag.flagType,
        bdrEmail: flag.bdrEmail,
        bdrName: flag.bdrName,
        ownerName: flag.ownerName,
        prospectingStatus: flag.prospectingStatus,
        prospectingPauseReason: flag.prospectingPauseReason,
        daysSinceLastRepContact: flag.daysSinceLastRepContact,
        daysSinceLastGongCall: flag.daysSinceLastGongCall,
        gongTotalCalls: flag.gongTotalCalls,
        lastRepCommunicationDate: flag.lastRepCommunicationDate,
        gongLastCallDate: flag.gongLastCallDate,
        targetProspectingDate: flag.targetProspectingDate,
        reEngageDate: flag.reEngageDate,
        competitorEndDate: flag.competitorEndDate,
        competitor: flag.competitor,
      }),
    onMutate: (flag) => {
      setLastSentAccountId(flag.accountId)
      setSendError(null)
    },
    onSuccess: (_data, flag) => {
      // Optimistically write nudge log into cache so cooldown kicks in immediately
      qc.setQueryData<HygieneResult>(['prospecting-hygiene'], (old) => {
        if (!old) return old
        return {
          ...old,
          nudgeLog: {
            ...old.nudgeLog,
            [flag.accountId]: { sentAt: new Date().toISOString(), bdrEmail: flag.bdrEmail ?? '', flagType: flag.flagType },
          },
        }
      })
    },
    onError: (err: { response?: { data?: { error?: string } }; message?: string }) => {
      setSendError(err.response?.data?.error ?? err.message ?? 'Failed to send')
    },
  })

  const { data, isFetching, isError, error, refetch, isFetched } = useQuery<HygieneResult>({
    queryKey: ['prospecting-hygiene'],
    queryFn: () => api.get('/accounts/prospecting-hygiene').then((r) => r.data),
    enabled: false,
    refetchOnWindowFocus: false,
  })

  const sfdcBase = appSettings?.sfdcInstanceUrl?.replace(/\/$/, '') ?? 'https://uberall.lightning.force.com'

  const staleFlags = useMemo(
    () => (data?.flags ?? []).filter((f) => f.flagType === 'STALE_PROSPECTING'),
    [data]
  )
  const shouldPromoteFlags = useMemo(
    () => (data?.flags ?? []).filter((f) => f.flagType === 'SHOULD_BE_PROSPECTING'),
    [data]
  )

  const bdrs = useMemo(() => {
    if (!data) return []
    const bdrMap = new Map<string, string>()
    for (const f of data.flags) {
      if (f.bdrEmail) bdrMap.set(f.bdrEmail, f.bdrName ?? f.bdrEmail)
    }
    return Array.from(bdrMap.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [data])

  // Unique sorted months (YYYY-MM) from target prospecting dates across all flags
  const availableMonths = useMemo(() => {
    if (!data) return []
    const months = new Set<string>()
    for (const f of data.flags) {
      if (f.targetProspectingDate) {
        months.add(f.targetProspectingDate.slice(0, 7)) // "YYYY-MM"
      }
    }
    return Array.from(months).sort()
  }, [data])

  function applyFilters(flags: ProspectingFlag[]) {
    return flags.filter((f) => {
      if (bdrFilter && f.bdrEmail !== bdrFilter) return false
      if (monthFilter) {
        const fm = f.targetProspectingDate?.slice(0, 7) ?? ''
        if (fm !== monthFilter) return false
      }
      if (dateCompare && dateFilterValue) {
        const target = f.targetProspectingDate ? new Date(f.targetProspectingDate).getTime() : null
        const threshold = new Date(dateFilterValue).getTime()
        if (target === null) return false
        if (dateCompare === 'before' && target >= threshold) return false
        if (dateCompare === 'after' && target <= threshold) return false
      }
      return true
    })
  }

  const filteredStale = applyFilters(staleFlags)
  const filteredShouldPromote = applyFilters(shouldPromoteFlags)

  return (
    <div className="p-8 max-w-5xl">

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">Prospecting Hygiene</h2>
          <p className="text-sm text-gray-500 mt-1">Enterprise accounts in Prospect stage with a target prospecting date</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSettingsOpen((o) => !o)}
            className={clsx(
              'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-colors',
              settingsOpen
                ? 'bg-gray-100 text-gray-800 border-gray-300'
                : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
            )}
          >
            <Settings size={14} />
            Rules
          </button>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50"
          >
            {isFetching ? <RefreshCw size={15} className="animate-spin" /> : <Building2 size={15} />}
            Scan accounts
          </button>
        </div>
      </div>

      {/* Settings panel */}
      {settingsOpen && (
        <div className="mb-6 bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-800 mb-4">Prospecting hygiene rules</h3>

          <div className="space-y-5">

            {/* Record type filter */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Account record type
              </label>
              <p className="text-xs text-gray-400 mb-2">
                Filter to only this SFDC Record Type DeveloperName. Leave blank to scan all prospect accounts.
              </p>
              <input
                type="text"
                value={recordTypeFilter}
                onChange={(e) => setRecordTypeFilter(e.target.value)}
                placeholder="Enterprise_Account_Record"
                className="input w-56"
              />
            </div>

            <div className="h-px bg-gray-100" />

            {/* Stale Prospecting threshold */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Stale prospecting — no activity threshold
              </label>
              <p className="text-xs text-gray-400 mb-2">
                Flag accounts in <strong>Prospecting</strong> status with no rep communication AND no Gong calls
                in the last N days. These should either finish the flow or be marked Paused.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={staleThresholdDays}
                  onChange={(e) => setStaleThresholdDays(e.target.value)}
                  className="input w-24 text-center"
                />
                <span className="text-sm text-gray-500">days without activity</span>
              </div>
            </div>

            <div className="h-px bg-gray-100" />

            {/* Should promote threshold */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Should promote — recent activity window
              </label>
              <p className="text-xs text-gray-400 mb-2">
                Flag accounts in <strong>Planned</strong> status that have had rep communication or Gong call
                activity within the last N days. These should be moved to Prospecting.
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={recentActivityDays}
                  onChange={(e) => setRecentActivityDays(e.target.value)}
                  className="input w-24 text-center"
                />
                <span className="text-sm text-gray-500">days (recent activity window)</span>
              </div>
            </div>

          </div>

          <div className="mt-5 flex items-center gap-3 pt-4 border-t border-gray-100">
            <button
              onClick={() => saveSettings.mutate()}
              disabled={saveSettings.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-500 text-white text-sm font-medium rounded-lg hover:bg-brand-600 disabled:opacity-50"
            >
              <Save size={13} />
              {savedSettings ? 'Saved!' : 'Save rules'}
            </button>
            <p className="text-xs text-gray-400">
              Changes take effect on next scan.
            </p>
          </div>
        </div>
      )}

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

      {/* Error */}
      {isError && (
        <div className="mb-6 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <strong>Scan failed:</strong> {String((error as { message?: string })?.message ?? error)}
        </div>
      )}

      {/* Send error */}
      {sendError && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 flex items-center justify-between">
          <span><strong>Send failed:</strong> {sendError}</span>
          <button onClick={() => setSendError(null)} className="text-red-400 hover:text-red-600 text-xs ml-4">Dismiss</button>
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
          {/* Stat cards */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-white rounded-xl border border-gray-200 px-6 py-5 flex items-center gap-4">
              <div className="p-2 bg-gray-50 rounded-lg"><Building2 size={18} className="text-gray-500" /></div>
              <div>
                <div className="text-2xl font-bold text-gray-900">{data.totalAccounts}</div>
                <div className="text-xs text-gray-500 mt-0.5">Accounts scanned</div>
                <div className="text-xs text-gray-400 mt-0.5">{data.config.recordTypeFilter || 'All'} record type</div>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 px-6 py-5 flex items-center gap-4">
              <div className="p-2 bg-gray-50 rounded-lg"><AlertCircle size={18} className="text-red-500" /></div>
              <div>
                <div className="text-2xl font-bold text-gray-900">{staleFlags.length}</div>
                <div className="text-xs text-gray-500 mt-0.5">Stale prospecting</div>
                <div className="text-xs text-gray-400 mt-0.5">No activity in {data.config.staleThresholdDays}+ days</div>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 px-6 py-5 flex items-center gap-4">
              <div className="p-2 bg-gray-50 rounded-lg"><CheckCircle size={18} className="text-blue-500" /></div>
              <div>
                <div className="text-2xl font-bold text-gray-900">{shouldPromoteFlags.length}</div>
                <div className="text-xs text-gray-500 mt-0.5">Should be Prospecting</div>
                <div className="text-xs text-gray-400 mt-0.5">Active in last {data.config.recentActivityDays}d</div>
              </div>
            </div>
          </div>

          {/* Filters + scanned at */}
          <div className="mb-4 bg-white border border-gray-200 rounded-xl px-4 py-3 space-y-3">
            <div className="flex items-center gap-4 flex-wrap">

              {/* BDR filter */}
              {bdrs.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-gray-500">BDR</span>
                  <select
                    value={bdrFilter}
                    onChange={(e) => setBdrFilter(e.target.value)}
                    className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700"
                  >
                    <option value="">All</option>
                    {bdrs.map(([email, name]) => (
                      <option key={email} value={email}>{name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Month filter */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-gray-500">Target month</span>
                <select
                  value={monthFilter}
                  onChange={(e) => setMonthFilter(e.target.value)}
                  className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700"
                >
                  <option value="">All</option>
                  {availableMonths.map((ym) => {
                    const [year, month] = ym.split('-')
                    const label = new Date(Number(year), Number(month) - 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
                    return <option key={ym} value={ym}>{label}</option>
                  })}
                </select>
              </div>

              {/* Before / after date filter */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-gray-500">Target date</span>
                <select
                  value={dateCompare}
                  onChange={(e) => { setDateCompare(e.target.value as 'before' | 'after' | ''); setDateFilterValue('') }}
                  className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700"
                >
                  <option value="">Any</option>
                  <option value="before">Before</option>
                  <option value="after">After</option>
                </select>
                <input
                  type="date"
                  value={dateFilterValue}
                  onChange={(e) => setDateFilterValue(e.target.value)}
                  disabled={!dateCompare}
                  className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
                />
              </div>

              {/* Clear all */}
              {(bdrFilter || monthFilter || dateCompare || dateFilterValue) && (
                <button
                  onClick={() => { setBdrFilter(''); setMonthFilter(''); setDateCompare(''); setDateFilterValue('') }}
                  className="text-xs text-brand-600 hover:underline ml-auto"
                >
                  Clear filters
                </button>
              )}
            </div>

            <p className="text-xs text-gray-400">
              Scanned {new Date(data.scannedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              {' · '}stale: {data.config.staleThresholdDays}d · recent: {data.config.recentActivityDays}d
            </p>
          </div>

          {/* Stale Prospecting */}
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
                <span className="text-xs text-gray-400">In "Prospecting" with no activity in {data.config.staleThresholdDays}+ days — finish the flow or mark Paused</span>
              </div>
              {staleOpen ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
            </button>
            {staleOpen && (
              <div className="divide-y divide-gray-100">
                {filteredStale.length === 0 ? (
                  <div className="px-6 py-6 text-center text-sm text-gray-400">No stale prospecting accounts</div>
                ) : (
                  filteredStale.map((flag) => (
                    <AccountRow key={flag.accountId} flag={flag} sfdcBase={sfdcBase} onSendToBdr={setPreviewFlag} sendPending={notifyBdr.isPending} lastSentAccountId={lastSentAccountId} nudgeEntry={data.nudgeLog?.[flag.accountId] ?? null} />
                  ))
                )}
              </div>
            )}
          </div>

          {/* Should Move to Prospecting */}
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
                <span className="text-xs text-gray-400">In "Planned" with activity in last {data.config.recentActivityDays}d</span>
              </div>
              {shouldPromoteOpen ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
            </button>
            {shouldPromoteOpen && (
              <div className="divide-y divide-gray-100">
                {filteredShouldPromote.length === 0 ? (
                  <div className="px-6 py-6 text-center text-sm text-gray-400">No accounts to promote</div>
                ) : (
                  filteredShouldPromote.map((flag) => (
                    <AccountRow key={flag.accountId} flag={flag} sfdcBase={sfdcBase} onSendToBdr={setPreviewFlag} sendPending={notifyBdr.isPending} lastSentAccountId={lastSentAccountId} nudgeEntry={data.nudgeLog?.[flag.accountId] ?? null} />
                  ))
                )}
              </div>
            )}
          </div>

          {isFetched && data.flags.length === 0 && (
            <div className="mt-4 px-4 py-3 bg-green-50 border border-green-200 rounded-xl text-sm text-green-700 text-center">
              ✓ No hygiene issues found — all accounts look good!
            </div>
          )}
        </>
      )}

      {/* BDR message preview modal */}
      {previewFlag && (
        <BdrMessagePreview
          flag={previewFlag}
          sfdcBase={sfdcBase}
          isPending={notifyBdr.isPending}
          onConfirm={() => {
            notifyBdr.mutate(previewFlag, {
              onSuccess: () => setPreviewFlag(null),
            })
          }}
          onClose={() => setPreviewFlag(null)}
        />
      )}
    </div>
  )
}

const PROSPECTING_STATUSES = ['Planned', 'Prospecting', 'Paused', 'Success', 'Nurturing']
const PAUSE_REASONS = [
  'Timing (populate "date to re-engage")',
  'Unresponsive',
  'Decision on parent',
  'Decision on child',
  'Company no longer exists (acquisition, insolvent)',
  'Not ICP',
]

// ── AccountRow ────────────────────────────────────────────────────────────────

function AccountRow({
  flag,
  sfdcBase,
  onSendToBdr,
  sendPending,
  lastSentAccountId,
  nudgeEntry,
}: {
  flag: ProspectingFlag
  sfdcBase: string
  onSendToBdr: (flag: ProspectingFlag) => void
  sendPending: boolean
  lastSentAccountId: string | null
  nudgeEntry: NudgeEntry | null
}) {
  const qc = useQueryClient()
  const [editMode, setEditMode] = useState(false)
  const [editStatus, setEditStatus] = useState(flag.prospectingStatus ?? '')
  const [editDate, setEditDate] = useState(flag.targetProspectingDate ?? '')
  const [editPauseReason, setEditPauseReason] = useState(flag.prospectingPauseReason ?? '')

  const saveEdit = useMutation({
    mutationFn: () => api.patch(`/accounts/${flag.accountId}`, {
      Prospecting_Status__c: editStatus || null,
      Target_Prospecting_Date__c: editDate || null,
      Prospecting_Pause_Reason__c: editStatus === 'Paused' ? (editPauseReason || null) : null,
    }),
    onSuccess: () => {
      // Optimistically update the cached scan data
      qc.setQueryData<HygieneResult>(['prospecting-hygiene'], (old) => {
        if (!old) return old
        return {
          ...old,
          flags: old.flags.map((f) =>
            f.accountId === flag.accountId
              ? {
                  ...f,
                  prospectingStatus: editStatus || f.prospectingStatus,
                  targetProspectingDate: editDate || f.targetProspectingDate,
                  prospectingPauseReason: editStatus === 'Paused' ? editPauseReason : null,
                }
              : f
          ),
        }
      })
      setEditMode(false)
    },
  })

  const accountLink = `${sfdcBase}/lightning/r/Account/${flag.accountId}/view`
  const visibleEmails = flag.contactEmails.slice(0, 2)
  const extraEmailCount = flag.contactEmails.length - 2
  const isSending = sendPending && lastSentAccountId === flag.accountId
  const justSent = !sendPending && lastSentAccountId === flag.accountId
  const nudgeBdSince = nudgeEntry ? businessDaysSince(nudgeEntry.sentAt) : null
  const inCooldown = nudgeBdSince !== null && nudgeBdSince < 3

  const statusBadgeClass =
    flag.flagType === 'STALE_PROSPECTING'
      ? 'bg-red-50 text-red-700'
      : 'bg-blue-50 text-blue-700'

  return (
    <div className="px-6 py-4 hover:bg-gray-50">
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">

          {/* Account name + badges */}
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
            <button
              onClick={() => { setEditMode((e) => !e); setEditStatus(flag.prospectingStatus ?? ''); setEditDate(flag.targetProspectingDate ?? ''); setEditPauseReason(flag.prospectingPauseReason ?? '') }}
              className="text-gray-400 hover:text-brand-600 ml-1"
              title="Edit status / date"
            >
              <Pencil size={11} />
            </button>
          </div>

          {/* Owner + BDR */}
          <div className="flex items-center gap-3 mb-2">
            <p className="text-xs text-gray-500">AE: {flag.ownerName ?? flag.ownerEmail}</p>
            {flag.bdrEmail ? (
              <p className="text-xs text-gray-500">BDR: {flag.bdrName ?? flag.bdrEmail}</p>
            ) : (
              <p className="text-xs text-gray-400 italic">No BDR assigned</p>
            )}
          </div>

          {/* Inline edit form */}
          {editMode && (
            <div className="mb-3 p-3 bg-blue-50 border border-blue-200 rounded-lg flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-[10px] font-semibold text-blue-700 mb-1 uppercase tracking-wide">Status</label>
                <select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value)}
                  className="text-xs border border-blue-300 rounded-lg px-2 py-1.5 bg-white text-gray-800"
                >
                  <option value="">— unchanged —</option>
                  {PROSPECTING_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              {editStatus === 'Paused' && (
                <div>
                  <label className="block text-[10px] font-semibold text-blue-700 mb-1 uppercase tracking-wide">Hold reason</label>
                  <select
                    value={editPauseReason}
                    onChange={(e) => setEditPauseReason(e.target.value)}
                    className="text-xs border border-blue-300 rounded-lg px-2 py-1.5 bg-white text-gray-800 max-w-xs"
                  >
                    <option value="">— none —</option>
                    {PAUSE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-[10px] font-semibold text-blue-700 mb-1 uppercase tracking-wide">Target prospecting date</label>
                <input
                  type="date"
                  value={editDate}
                  onChange={(e) => setEditDate(e.target.value)}
                  className="text-xs border border-blue-300 rounded-lg px-2 py-1.5 bg-white text-gray-800"
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => saveEdit.mutate()}
                  disabled={saveEdit.isPending}
                  className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {saveEdit.isPending ? <RefreshCw size={11} className="animate-spin" /> : <Check size={11} />}
                  Save to Salesforce
                </button>
                <button onClick={() => setEditMode(false)} className="text-xs text-blue-500 hover:text-blue-700">Cancel</button>
              </div>
              {saveEdit.isError && (
                <p className="w-full text-xs text-red-600 mt-1">Save failed — check your Salesforce connection</p>
              )}
            </div>
          )}

          {/* Key dates grid */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs mb-2">
            <DateField label="Last rep contact" value={flag.lastRepCommunicationDate} daysAgo={flag.daysSinceLastRepContact} warn={flag.daysSinceLastRepContact === null || flag.daysSinceLastRepContact > 14} />
            <DateField label="Target prospecting date" value={flag.targetProspectingDate} />
            <DateField label="Re-engage date" value={flag.reEngageDate} />
            <DateField label="Competitor contract end" value={flag.competitorEndDate} />
            {flag.prospectingPauseReason && (
              <DateField label="Hold reason" value={flag.prospectingPauseReason} isText />
            )}
          </div>

          {/* Gong calls + contacts */}
          <div className="flex items-center gap-4 flex-wrap text-xs mb-1.5">
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
                      {' · '}last {fmtDate(flag.gongLastCallDate)}
                      {flag.daysSinceLastGongCall !== null && ` (${daysAgoLabel(flag.daysSinceLastGongCall)})`}
                    </span>
                  )}
                </>
              )}
            </div>

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

          {/* Gong flow enrollment */}
          <GongFlowStatus stats={flag.gongFlowStats} />
        </div>

        {/* Send to BDR button */}
        <div className="shrink-0 pt-0.5 flex flex-col items-end gap-1">
          {flag.bdrEmail ? (
            <>
              <button
                onClick={() => onSendToBdr(flag)}
                disabled={isSending || justSent || inCooldown}
                title={inCooldown ? `Cooldown active — sent ${nudgeBdSince} business day${nudgeBdSince === 1 ? '' : 's'} ago (3 bd cooldown)` : undefined}
                className={clsx(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                  justSent
                    ? 'bg-green-50 text-green-700 border-green-200'
                    : inCooldown
                    ? 'bg-gray-50 text-gray-400 border-gray-200 cursor-not-allowed'
                    : 'bg-white text-gray-600 border-gray-200 hover:bg-brand-50 hover:text-brand-700 hover:border-brand-200 disabled:opacity-50'
                )}
              >
                {isSending ? (
                  <RefreshCw size={11} className="animate-spin" />
                ) : (
                  <Send size={11} />
                )}
                {justSent ? 'Sent!' : 'Send to BDR'}
              </button>
              {/* Last sent / cooldown badge */}
              {nudgeEntry && (
                <span className={clsx(
                  'text-[10px] font-medium px-1.5 py-0.5 rounded-full',
                  inCooldown
                    ? 'bg-blue-50 text-blue-500'
                    : 'bg-gray-100 text-gray-400'
                )}>
                  {inCooldown
                    ? `cooldown · ${nudgeBdSince} bd ago`
                    : `sent ${nudgeBdSince! >= 1 ? `${nudgeBdSince} bd ago` : 'today'}`}
                </span>
              )}
            </>
          ) : (
            <span className="text-xs text-gray-300 px-3 py-1.5">No BDR</span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── BdrMessagePreview ─────────────────────────────────────────────────────────

function BdrMessagePreview({
  flag,
  sfdcBase,
  isPending,
  onConfirm,
  onClose,
}: {
  flag: ProspectingFlag
  sfdcBase: string
  isPending: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const bdrFirstName = flag.bdrName?.split(' ')[0] ?? 'there'
  const isStale = flag.flagType === 'STALE_PROSPECTING'
  const staleDays = flag.daysSinceLastRepContact ?? flag.daysSinceLastGongCall

  const headerText = isStale
    ? `👋 Hey ${bdrFirstName}, *${flag.accountName}* has gone stale in prospecting`
    : `👋 Hey ${bdrFirstName}, *${flag.accountName}* looks ready to move to Prospecting`

  const situationText = isStale
    ? staleDays !== null
      ? `This account has been in *Prospecting* status for *${staleDays} days* with no rep communication or Gong call activity.`
      : `This account has been in *Prospecting* status with no recent activity on record.`
    : `This account is in *Planned* status but has had recent outreach activity${flag.gongTotalCalls > 0 ? ` (${flag.gongTotalCalls} Gong call${flag.gongTotalCalls !== 1 ? 's' : ''}, last ${fmtDate(flag.gongLastCallDate)})` : ''}.`

  const updateLines = [
    '• *Prospecting Status* — move to Prospecting, Paused, or Nurturing as appropriate',
    '• *Date to re-engage* — set if pausing or deferring',
    '• *Hold reason* — set if pausing',
    '• *Incumbent vendor* & *contract end date* — fill in if you\'ve identified competitive info',
  ]

  const currentFields: { label: string; value: string }[] = []
  if (flag.lastRepCommunicationDate) currentFields.push({ label: 'Last rep contact', value: `${fmtDate(flag.lastRepCommunicationDate)}${flag.daysSinceLastRepContact !== null ? ` (${flag.daysSinceLastRepContact}d ago)` : ''}` })
  if (flag.gongLastCallDate) currentFields.push({ label: 'Last Gong call', value: `${fmtDate(flag.gongLastCallDate)}${flag.daysSinceLastGongCall !== null ? ` (${flag.daysSinceLastGongCall}d ago)` : ''}` })
  if (flag.targetProspectingDate) currentFields.push({ label: 'Target prospecting date', value: fmtDate(flag.targetProspectingDate) })
  if (flag.reEngageDate) currentFields.push({ label: 'Date to re-engage', value: fmtDate(flag.reEngageDate) })
  if (flag.prospectingPauseReason) currentFields.push({ label: 'Hold reason', value: flag.prospectingPauseReason })
  if (flag.competitor) currentFields.push({ label: 'Incumbent vendor', value: flag.competitor })
  if (flag.competitorEndDate) currentFields.push({ label: 'Vendor contract end', value: fmtDate(flag.competitorEndDate) })
  if (flag.ownerName) currentFields.push({ label: 'Account owner', value: flag.ownerName })

  const accountUrl = `${sfdcBase}/lightning/r/Account/${flag.accountId}/view`

  // Render mrkdwn bold (*text*) as <strong>
  function renderMrkdwn(text: string) {
    const parts = text.split(/(\*[^*]+\*)/g)
    return parts.map((p, i) =>
      p.startsWith('*') && p.endsWith('*')
        ? <strong key={i}>{p.slice(1, -1)}</strong>
        : <span key={i}>{p}</span>
    )
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>

        {/* Modal header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Draft Slack message</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              To: <span className="font-medium">{flag.bdrName ?? flag.bdrEmail}</span>
              {flag.bdrEmail && <span className="text-gray-400"> ({flag.bdrEmail})</span>}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={16} />
          </button>
        </div>

        {/* Slack message preview */}
        <div className="px-6 py-5">
          <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 space-y-3 font-sans text-sm">

            {/* Bot name */}
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded bg-brand-500 flex items-center justify-center text-white text-xs font-bold shrink-0">R</div>
              <span className="font-bold text-gray-900 text-sm">RevBot</span>
              <span className="text-xs text-gray-400">App</span>
            </div>

            {/* Header block */}
            <p className="text-gray-900 leading-snug">{renderMrkdwn(headerText)}</p>

            {/* Situation block */}
            <p className="text-gray-700 leading-snug">{renderMrkdwn(situationText)}</p>

            {/* Update request block */}
            <div className="text-gray-700 leading-snug space-y-0.5">
              <p>Please update the following in Salesforce:</p>
              {updateLines.map((line, i) => (
                <p key={i} className="pl-1">{renderMrkdwn(line)}</p>
              ))}
            </div>

            {/* Divider */}
            <hr className="border-gray-200" />

            {/* Current values on record */}
            {currentFields.length > 0 && (
              <>
                <p className="text-xs font-bold text-gray-500 uppercase tracking-wide">Current values on record</p>
                <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                  {currentFields.map(({ label, value }) => (
                    <div key={label}>
                      <p className="text-xs font-bold text-gray-700">{label}</p>
                      <p className="text-xs text-gray-600">{value}</p>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Button */}
            <div className="pt-1">
              <a
                href={accountUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-brand-500 text-white rounded text-xs font-medium hover:bg-brand-600"
              >
                Update in Salesforce →
              </a>
            </div>

            {/* Context footer */}
            <p className="text-xs text-gray-400">Sent via RevBot · {flag.prospectingStatus ?? 'Unknown'} status</p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isPending}
            className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white text-sm font-medium rounded-lg hover:bg-brand-600 disabled:opacity-50"
          >
            {isPending ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />}
            Send to {flag.bdrName?.split(' ')[0] ?? 'BDR'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── GongFlowStatus ────────────────────────────────────────────────────────────

function GongFlowStatus({ stats }: { stats: ProspectingFlag['gongFlowStats'] }) {
  // null = Gong Engage Flows API unavailable on this plan
  if (stats === null) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-gray-300 mt-1">
        <Workflow size={11} className="shrink-0" />
        <span>Gong flows unavailable</span>
      </div>
    )
  }

  const { activeWithOverdue, activeOnTrack, completedSinceTarget } = stats
  const totalActive = activeWithOverdue + activeOnTrack
  const hasAny = totalActive > 0 || completedSinceTarget > 0

  if (!hasAny) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-gray-400 mt-1">
        <Workflow size={11} className="shrink-0" />
        <span>No contacts in Gong flows</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 flex-wrap mt-1">
      <Workflow size={11} className="text-gray-400 shrink-0" />

      {activeWithOverdue > 0 && (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-red-50 border border-red-200 rounded text-xs text-red-700 font-medium">
          ⚠ {activeWithOverdue} active · overdue step{activeWithOverdue !== 1 ? 's' : ''}
        </span>
      )}

      {activeOnTrack > 0 && (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-700 font-medium">
          ✓ {activeOnTrack} active · on track
        </span>
      )}

      {completedSinceTarget > 0 && (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-gray-100 border border-gray-200 rounded text-xs text-gray-600 font-medium">
          ✓ {completedSinceTarget} completed flow{completedSinceTarget !== 1 ? 's' : ''} since target date
        </span>
      )}
    </div>
  )
}

// ── DateField ─────────────────────────────────────────────────────────────────

function DateField({ label, value, daysAgo, warn, isText }: { label: string; value: string | null | undefined; daysAgo?: number | null; warn?: boolean; isText?: boolean }) {
  if (!value) return null
  return (
    <div className="flex items-center gap-1.5">
      {!isText && <Calendar size={11} className="text-gray-400 shrink-0" />}
      <span className="text-gray-500">{label}:</span>
      <span className={clsx('font-medium', warn ? 'text-red-600' : 'text-gray-800')}>
        {isText ? value : fmtDate(value)}
      </span>
      {daysAgo !== null && daysAgo !== undefined && (
        <span className="text-gray-400">({daysAgoLabel(daysAgo)})</span>
      )}
    </div>
  )
}
