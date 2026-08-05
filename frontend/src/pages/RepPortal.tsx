import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { ExternalLink, Clock, CheckCircle, AlertCircle, ChevronDown, BellOff, Check, RefreshCw, ChevronUp, Save, Table2, LayoutList } from 'lucide-react'
import clsx from 'clsx'

// Plain axios instance — no admin auth interceptors, no 401→/login redirect
const repApi = axios.create({
  baseURL: import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api',
})

// ── Types ─────────────────────────────────────────────────────────────────────

interface RepNotification {
  id: string
  opportunityId: string
  opportunityName: string
  alertType: string
  alertDetails: Record<string, unknown>
  status: 'SENT' | 'SNOOZED'
  sentAt: string | null
  snoozedUntil: string | null
  sfdcUrl: string
}

interface PendingFlag {
  opportunityId: string
  opportunityName: string
  alertType: string
  details: Record<string, unknown>
}

interface RepData {
  rep: {
    name: string
    email: string | null
    repRole: string | null
    showTerritoryCleanup?: boolean
    showWhitespace?: boolean
    roleLookupFailed?: boolean
  }
  notifications: RepNotification[]
  pending: PendingFlag[]
}

// ── Territory Cleanup ─────────────────────────────────────────────────────────

interface TerritoryAccount {
  accountId: string
  accountName: string
  website: string | null
  description: string | null
  industry: string | null
  subIndustry: string | null
  numberOfLocations: number | null
  currentLocations: number | null
  ultimateParentLocations: number | null
  icpIppFit: string | null
  icpIppFitRating: string | null
  icp: string | null
  accountStage: string | null
  prospectingStatus: string | null
  prospectingPauseReason: string | null
  duplicateFlag: boolean
  parentId: string | null
  parentName: string | null
  ultimateParent: string | null
  lastRepCommunicationDate: string | null
  billingCountry: string | null
  operatingModel: string | null
  productFit: string | null
  productFitRationale: string | null
  sfdcUrl: string
}

interface PicklistOption {
  value: string
  label: string
}

interface RepPicklists {
  industry: string[]
  icpIppFitRating: string[]
  operatingModel: string[]
  /** Optional: the frontend can deploy ahead of a backend that doesn't send it. */
  productFit?: PicklistOption[]
}

/**
 * Product Fit written for each disposition. Mirrors PRODUCT_FIT_BY_DISPOSITION on
 * the server — API values, not Setup labels ("No Fit" is stored as `No Need`).
 * Dispositions absent here leave Product Fit alone.
 */
const PRODUCT_FIT_BY_DISPOSITION: Record<string, string> = {
  GOOD_LEAVE_IN_TERRITORY: 'Strong Fit',
  USE_CASE_LOW_PRIORITY: 'Partial Fit',
  NO_ICP: 'No Need',
}

/**
 * Prospecting statuses a BDR nomination will promote to "Planned". Mirrors
 * NOMINATABLE_PROSPECTING_STATUSES on the server; anything else is already being
 * worked, so nomination only moves the target date.
 */
const NOMINATABLE_PROSPECTING_STATUSES = ['', 'Hold']

/**
 * The 2nd of next month as `YYYY-MM-DD` — what a BDR nomination will set Target
 * Prospecting Date to. Deliberately the same UTC arithmetic as `nextMonthSecond`
 * on the server, so the preview here and the value written there agree even for a
 * rep whose local date is a day ahead of or behind UTC.
 */
function nextMonthSecond(now: Date = new Date()): string {
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2))
  const mm = String(target.getUTCMonth() + 1).padStart(2, '0')
  return `${target.getUTCFullYear()}-${mm}-02`
}

/**
 * Show the Salesforce label for a stored Product Fit value. These diverge: the
 * option labelled "No Fit" is stored as `No Need`, so displaying the raw value
 * would show reps a term that no longer exists in Salesforce.
 */
function productFitLabel(value: string, picklists: RepPicklists): string {
  return picklists.productFit?.find((o) => o.value === value)?.label ?? value
}

interface TerritoryFilters {
  lastCommBefore: string
  includeBlankLastComm: boolean
  minLocations: string
  maxLocations: string
}

interface TerritoryResponse {
  accounts: TerritoryAccount[]
  totalInTerritory: number
  alreadyValidated: number
  picklists: RepPicklists
  appliedFilters?: {
    lastCommBefore: string
    includeBlankLastComm: boolean
    minLocations: number | null
    maxLocations: number | null
  }
}

type Disposition =
  | 'GOOD_LEAVE_IN_TERRITORY'
  | 'USE_CASE_LOW_PRIORITY'
  | 'NO_ICP'
  | 'DUPLICATE'
  | 'DECISION_ON_PARENT'
  | 'DECISION_ON_CHILD'
  | 'OTHER'

type NoIcpSubReason = 'TOO_SMALL' | 'JUNK' | 'PARTNER' | 'DEFUNCT'

const DISPOSITION_OPTIONS: {
  value: Disposition
  label: string
  hint: string
  tone: string
}[] = [
  {
    value: 'GOOD_LEAVE_IN_TERRITORY',
    label: 'Great account — leave in my territory',
    hint: 'Confirm the operating model and hierarchy while you\'re here.',
    tone: 'border-green-300 bg-green-50 text-green-800',
  },
  {
    value: 'USE_CASE_LOW_PRIORITY',
    label: 'Has a use case, but not ICP/strong fit',
    hint: 'Low priority account. Sets Product Fit to "Partial Fit".',
    tone: 'border-amber-300 bg-amber-50 text-amber-800',
  },
  {
    value: 'NO_ICP',
    label: 'No fit',
    hint: 'Disqualifies the account, removes it from your territory and sets Product Fit to "No Fit".',
    tone: 'border-red-300 bg-red-50 text-red-800',
  },
  {
    value: 'DUPLICATE',
    label: 'Duplicate',
    hint: 'Flags the account as a potential duplicate for RevOps to merge.',
    tone: 'border-purple-300 bg-purple-50 text-purple-800',
  },
  {
    value: 'DECISION_ON_PARENT',
    label: 'Strong/partial fit, but decision is made on the parent',
    hint: 'Puts prospecting on hold with reason "Decision on parent".',
    tone: 'border-blue-300 bg-blue-50 text-blue-800',
  },
  {
    value: 'DECISION_ON_CHILD',
    label: 'Strong/partial fit, but decision is made on the child',
    hint: 'Puts prospecting on hold with reason "Decision on child".',
    tone: 'border-blue-300 bg-blue-50 text-blue-800',
  },
  {
    value: 'OTHER',
    label: 'Other',
    hint: 'Tell us what\'s going on — a note is required.',
    tone: 'border-gray-300 bg-gray-50 text-gray-700',
  },
]

/**
 * `effect` mirrors NO_ICP_ROUTING on the server. Shown next to each reason because
 * these all reassign the account away from the rep, which is not obvious from the
 * reason alone and isn't something they can undo from here.
 */
const NO_ICP_REASONS: { value: NoIcpSubReason; label: string; effect: string }[] = [
  {
    value: 'TOO_SMALL',
    label: 'Too small — location count is wrong',
    effect: 'Stays an Enterprise record, goes to Shark Tank',
  },
  { value: 'JUNK', label: 'Junk account', effect: 'Goes to Grave Yard' },
  {
    value: 'PARTNER',
    label: 'Partner account',
    effect: 'Converts to a Partner record, goes to Shark Tank',
  },
  { value: 'DEFUNCT', label: 'Defunct account', effect: 'Goes to Grave Yard' },
]

interface WhitespaceLine {
  id: string
  name: string
  productCoverageName: string | null
  accountId: string
  accountName: string
  currentStatus: string | null
  fitUseCase: string | null
  currentLocationsCovered: number | null
  totalLocationsFit: number | null
  arrPotential: number | null
  priority: string | null
}

interface WhitespaceAccountGroup {
  accountId: string
  accountName: string
  lines: WhitespaceLine[]
}

interface WhitespaceResponse {
  records: WhitespaceAccountGroup[]
}

// ── Alert type display ────────────────────────────────────────────────────────

const ALERT_META: Record<string, { label: string; color: string; what: string }> = {
  PAST_DUE_INITIAL:    { label: 'Past Due',         color: 'bg-red-100 text-red-700',      what: 'Close date has passed — update the date or close the deal.' },
  PAST_DUE_AMENDMENT:  { label: 'Past Due Amendment',color: 'bg-red-100 text-red-700',      what: 'Amendment close date has passed — update or close.' },
  PAST_DUE_RENEWAL:    { label: 'Past Due Renewal',  color: 'bg-red-100 text-red-700',      what: 'Renewal booking date has passed — close this in Salesforce.' },
  STALLED:             { label: 'Zombie Pipeline',     color: 'bg-orange-100 text-orange-700', what: "This is a nudge to re-engage the deal if it needs a push — flagged based on time in stage or total deal age. If it's an active longer sales cycle, just snooze and we'll check back in." },
  MEDDPICC_MISSING:    { label: 'Missing MEDDPICC',  color: 'bg-purple-100 text-purple-700', what: 'Required MEDDPICC/BANT fields are blank for this stage.' },
  NEXT_STEP_MISSING:   { label: 'Missing Next Step', color: 'bg-yellow-100 text-yellow-700', what: 'Next step description or date is missing/overdue.' },
  CLOSE_DATE_RISK:     { label: 'Close Date Risk',   color: 'bg-amber-100 text-amber-700',   what: 'Close date is approaching but deal is still in early stage.' },
  STAGE_MISMATCH:      { label: 'Stage Mismatch',    color: 'bg-blue-100 text-blue-700',     what: 'Next step text suggests a later stage than what\'s set in Salesforce.' },
  STALE_PROSPECTING:   { label: 'Stale Prospecting', color: 'bg-gray-100 text-gray-700',     what: 'No recent activity on this prospecting account.' },
}

function fmtDate(iso: string | null) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function wsStatusBadgeClass(status: string | null): string {
  switch (status) {
    case 'Has':
      return 'bg-green-100 text-green-700'
    case 'Pitching / Does Not Have':
      return 'bg-blue-100 text-blue-700'
    case 'Does Not Have / Not Pitching Yet':
      return 'bg-gray-100 text-gray-600'
    case 'Used to have':
      return 'bg-orange-100 text-orange-700'
    default:
      return 'bg-gray-100 text-gray-500'
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

type PortalTab = 'pipeline' | 'whitespace' | 'territory'

/**
 * `YYYY-MM-DD` for N days ago. UTC arithmetic to match `defaultLastCommBefore` on
 * the server, so the prefilled date and the server's own fallback agree.
 */
function daysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

/**
 * What the filter bar starts on, and what Reset goes back to: accounts with 100+
 * locations untouched for a year. These are prefilled rather than left blank so
 * the inputs show the filter that's actually in effect — a blank date box above
 * copy saying "not contacted since ..." reads like a bug.
 *
 * Computed once at module load; a session doesn't outlive a date change in any way
 * that matters here.
 *
 * Empty string still means "unset", so clearing a box genuinely removes that
 * bound — the rep isn't stuck with the default.
 */
const DEFAULT_TERRITORY_FILTERS: TerritoryFilters = {
  lastCommBefore: daysAgo(365),
  includeBlankLastComm: true,
  minLocations: '100',
  maxLocations: '',
}

/**
 * Format a bare `YYYY-MM-DD`. Not `fmtDate` — that goes through `new Date()`,
 * which reads a date-only string as UTC midnight and so renders the day before
 * in any negative-offset timezone.
 */
function fmtDateOnly(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  if (!y || !m || !d) return ymd
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/**
 * Plain-English version of the filter the server actually applied. Reads from
 * `appliedFilters` rather than local state so it reflects defaults and rejected
 * values, not whatever happens to be typed in the boxes.
 */
function describeTerritoryFilters(f: TerritoryResponse['appliedFilters']): string {
  if (!f) return 'matching your current filters'

  const contact = f.includeBlankLastComm
    ? `not contacted since ${fmtDateOnly(f.lastCommBefore)} (or never contacted)`
    : `last contacted before ${fmtDateOnly(f.lastCommBefore)}`

  let locations = ''
  if (f.minLocations !== null && f.maxLocations !== null) {
    locations = ` with ${f.minLocations}–${f.maxLocations} locations`
  } else if (f.minLocations !== null) {
    locations = ` with ${f.minLocations}+ locations`
  } else if (f.maxLocations !== null) {
    locations = ` with up to ${f.maxLocations} locations`
  }

  return `${contact}${locations}`
}

type TerritoryView = 'table' | 'cards'

const TERRITORY_VIEW_KEY = 'beacon.territoryView'

/**
 * Remembers the rep's choice of grid vs cards across visits, but forces cards on
 * narrow screens — the table needs ~62rem and reps open this from Slack on a
 * phone, where a horizontally-scrolling 8-column grid is unusable.
 */
function useTerritoryView(): [TerritoryView, (v: TerritoryView) => void, boolean] {
  const [stored, setStored] = useState<TerritoryView>(() => {
    try {
      return localStorage.getItem(TERRITORY_VIEW_KEY) === 'cards' ? 'cards' : 'table'
    } catch {
      // Safari in private mode throws on localStorage access.
      return 'table'
    }
  })

  const query = '(min-width: 1024px)'
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  )

  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  function choose(v: TerritoryView) {
    setStored(v)
    try {
      localStorage.setItem(TERRITORY_VIEW_KEY, v)
    } catch {
      // Preference just won't persist — not worth surfacing.
    }
  }

  return [wide ? stored : 'cards', choose, wide]
}

export function RepPortal() {
  const token = new URLSearchParams(window.location.search).get('token') ?? ''
  const qc = useQueryClient()
  const [snoozing, setSnoozing] = useState<string | null>(null) // notif id being snoozed
  const [activeTab, setActiveTab] = useState<PortalTab>('pipeline')

  const { data, isLoading, error } = useQuery<RepData>({
    queryKey: ['rep-portal', token],
    queryFn: () => repApi.get(`/rep/me?token=${token}`).then((r) => r.data),
    enabled: !!token,
    retry: false,
  })

  const snoozeMutation = useMutation({
    mutationFn: ({ notificationId, days, snoozeUntil }: { notificationId: string; days?: number; snoozeUntil?: string }) =>
      repApi.post('/rep/snooze', { token, notificationId, days, snoozeUntil }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['rep-portal', token] })
      setSnoozing(null)
    },
  })

  const closeDateMutation = useMutation({
    mutationFn: ({ opportunityId, closeDate }: { opportunityId: string; closeDate: string }) =>
      repApi.post('/rep/update-close-date', { token, opportunityId, closeDate }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rep-portal', token] }),
  })

  const nextStepMutation = useMutation({
    mutationFn: ({ opportunityId, nextStep, nextStepDate }: { opportunityId: string; nextStep?: string; nextStepDate?: string }) =>
      repApi.post('/rep/update-next-step', { token, opportunityId, nextStep, nextStepDate }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rep-portal', token] }),
  })

  const [recheckMsg, setRecheckMsg] = useState<string | null>(null)
  const recheckMutation = useMutation({
    mutationFn: () => repApi.post('/rep/recheck', { token }).then((r) => r.data as { currentFlags: number; resolved: number; newFlags: { opportunityId: string; opportunityName: string; alertType: string }[] }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['rep-portal', token] })
      const parts: string[] = []
      if (result.newFlags.length) parts.push(`${result.newFlags.length} new flag${result.newFlags.length !== 1 ? 's' : ''} found`)
      if (result.resolved) parts.push(`${result.resolved} resolved`)
      if (!parts.length) parts.push('All clear — no changes')
      setRecheckMsg(parts.join(' · '))
      setTimeout(() => setRecheckMsg(null), 5000)
    },
  })

  const whitespaceQuery = useQuery<WhitespaceResponse>({
    queryKey: ['rep-whitespace', token],
    queryFn: () => repApi.get(`/rep/whitespace?token=${token}`).then((r) => r.data),
    enabled: !!token && activeTab === 'whitespace',
    retry: false,
  })

  // Two copies of the filter state: `territoryDraft` is what's in the inputs,
  // `territoryFilters` is what's been applied. Each apply is a fresh Salesforce
  // query, so we don't want one per keystroke.
  const [territoryDraft, setTerritoryDraft] = useState<TerritoryFilters>(DEFAULT_TERRITORY_FILTERS)
  const [territoryFilters, setTerritoryFilters] = useState<TerritoryFilters>(DEFAULT_TERRITORY_FILTERS)

  const territoryQuery = useQuery<TerritoryResponse>({
    queryKey: ['rep-territory', token, territoryFilters],
    queryFn: () => {
      const p = new URLSearchParams({ token })
      if (territoryFilters.lastCommBefore) p.set('lastCommBefore', territoryFilters.lastCommBefore)
      if (!territoryFilters.includeBlankLastComm) p.set('includeBlankLastComm', 'false')
      if (territoryFilters.minLocations) p.set('minLocations', territoryFilters.minLocations)
      if (territoryFilters.maxLocations) p.set('maxLocations', territoryFilters.maxLocations)
      return repApi.get(`/rep/territory-cleanup?${p.toString()}`).then((r) => r.data)
    },
    enabled: !!token && activeTab === 'territory',
    retry: false,
  })

  const territoryDirty =
    JSON.stringify(territoryDraft) !== JSON.stringify(territoryFilters)

  const [wsRemovedIds, setWsRemovedIds] = useState<Set<string>>(new Set())
  const [territoryDoneIds, setTerritoryDoneIds] = useState<Set<string>>(new Set())
  const [territoryView, setTerritoryView, canUseTable] = useTerritoryView()

  const wsRecords = (whitespaceQuery.data?.records ?? [])
    .map((group) => ({
      ...group,
      lines: group.lines.filter((l) => !wsRemovedIds.has(l.id)),
    }))
    .filter((group) => group.lines.length > 0)

  const open = data?.notifications.filter((n) => n.status === 'SENT') ?? []
  const snoozed = data?.notifications.filter((n) => n.status === 'SNOOZED') ?? []

  if (!token) {
    return <ErrorScreen message="No access link found. Click the link in your RevBot Slack message." />
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-sm text-gray-400">Loading your flags…</p>
      </div>
    )
  }

  if (error) {
    return <ErrorScreen message="This link has expired or is invalid. Message RevBot in Slack to get a fresh link." />
  }

  const firstName = data!.rep.name.split(' ')[0]

  // The grid needs ~62rem minimum, so the default 2xl shell would scroll the
  // disposition dropdown and Save button off-screen. Widen the whole shell (not
  // just the table) so the header and tabs stay aligned with the content.
  const shellWidth =
    activeTab === 'territory' && territoryView === 'table' ? 'max-w-screen-2xl' : 'max-w-2xl'

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className={clsx(shellWidth, 'mx-auto flex items-center justify-between')}>
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Hi {firstName} 👋</h1>
            <p className="text-sm text-gray-500 mt-0.5">Your open RevBot flags</p>
          </div>
          <div className="flex items-center gap-3">
            {open.length > 0 && (
              <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-700">
                {open.length} open
              </span>
            )}
            {snoozed.length > 0 && (
              <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-600">
                {snoozed.length} snoozed
              </span>
            )}
            <button
              onClick={() => recheckMutation.mutate()}
              disabled={recheckMutation.isPending}
              title="Re-evaluate your deals against current rules"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw size={11} className={clsx(recheckMutation.isPending && 'animate-spin')} />
              {recheckMutation.isPending ? 'Checking…' : 'Recheck my deals'}
            </button>
          </div>
        </div>
      </div>

      {/* Role lookup failed — explain the missing tabs instead of silently hiding
          them, since a Salesforce outage looks exactly like "you're not allowed". */}
      {data?.rep.roleLookupFailed && (
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-2.5">
          <div className={clsx(shellWidth, 'mx-auto text-xs text-amber-800')}>
            Couldn't check your Salesforce role, so some tabs may be hidden. This is a
            connection problem, not a permissions one — ask RevOps to reconnect Salesforce.
          </div>
        </div>
      )}

      {/* Tab bar */}
      <div className="bg-white border-b border-gray-200 px-6">
        <div className={clsx(shellWidth, 'mx-auto flex gap-0')}>
          <button
            onClick={() => setActiveTab('pipeline')}
            className={clsx(
              'px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors',
              activeTab === 'pipeline'
                ? 'border-brand-500 text-brand-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            )}
          >
            Pipeline
          </button>
          {data?.rep.showWhitespace && (
            <button
              onClick={() => setActiveTab('whitespace')}
              className={clsx(
                'px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors',
                activeTab === 'whitespace'
                  ? 'border-brand-500 text-brand-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              )}
            >
              📊 Whitespace
            </button>
          )}
          {data?.rep.showTerritoryCleanup && (
            <button
              onClick={() => setActiveTab('territory')}
              className={clsx(
                'px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors',
                activeTab === 'territory'
                  ? 'border-brand-500 text-brand-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              )}
            >
              🧹 Territory Cleanup
            </button>
          )}
        </div>
      </div>

      <div className={clsx(shellWidth, 'mx-auto px-6 py-6 space-y-3')}>

        {/* ── Pipeline tab ── */}
        {activeTab === 'pipeline' && (
          <>
            {/* Recheck result */}
            {recheckMsg && (
              <div className="flex items-center gap-2 px-4 py-2.5 bg-green-50 border border-green-200 rounded-xl text-xs text-green-700 font-medium">
                <Check size={13} className="flex-shrink-0" />
                {recheckMsg}
              </div>
            )}

            {/* All clear */}
            {open.length === 0 && snoozed.length === 0 && (
              <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
                <CheckCircle size={32} className="mx-auto text-green-400 mb-3" />
                <p className="text-sm font-medium text-gray-700">All clear — no open flags!</p>
                <p className="text-xs text-gray-400 mt-1">RevBot will message you when something needs attention.</p>
              </div>
            )}

            {/* Open flags */}
            {open.map((notif) => (
              <NotifCard
                key={notif.id}
                notif={notif}
                snoozingId={snoozing}
                onSnoozeOpen={() => setSnoozing(notif.id)}
                onSnoozeClose={() => setSnoozing(null)}
                onSnooze={(days, snoozeUntil) => snoozeMutation.mutate({ notificationId: notif.id, days, snoozeUntil })}
                isSnoozePending={snoozeMutation.isPending}
                onUpdateCloseDate={(closeDate) => closeDateMutation.mutate({ opportunityId: notif.opportunityId, closeDate })}
                isCloseDatePending={closeDateMutation.isPending}
                onUpdateNextStep={(nextStep, nextStepDate) => nextStepMutation.mutate({ opportunityId: notif.opportunityId, nextStep, nextStepDate })}
                isNextStepPending={nextStepMutation.isPending}
                repRole={data?.rep.repRole}
              />
            ))}

            {/* Snoozed */}
            {snoozed.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 mt-4">Snoozed</p>
                {snoozed.map((notif) => (
                  <NotifCard
                    key={notif.id}
                    notif={notif}
                    snoozed
                    snoozingId={snoozing}
                    onSnoozeOpen={() => setSnoozing(notif.id)}
                    onSnoozeClose={() => setSnoozing(null)}
                    onSnooze={(days, snoozeUntil) => snoozeMutation.mutate({ notificationId: notif.id, days, snoozeUntil })}
                    isSnoozePending={snoozeMutation.isPending}
                    onUpdateCloseDate={(closeDate) => closeDateMutation.mutate({ opportunityId: notif.opportunityId, closeDate })}
                    isCloseDatePending={closeDateMutation.isPending}
                    onUpdateNextStep={(nextStep, nextStepDate) => nextStepMutation.mutate({ opportunityId: notif.opportunityId, nextStep, nextStepDate })}
                    isNextStepPending={nextStepMutation.isPending}
                    repRole={data?.rep.repRole}
                  />
                ))}
              </div>
            )}

            {/* Want to get ahead? */}
            {(data?.pending ?? []).length > 0 && (
              <div className="mt-6">
                <div className="mb-3">
                  <p className="text-sm font-semibold text-gray-700">Want to get ahead? 🚀</p>
                  <p className="text-xs text-gray-400 mt-0.5">These deals are queued up and will be flagged soon — get a head start before RevBot sends the nudge.</p>
                </div>
                {data!.pending.map((flag) => {
                  const meta = ALERT_META[flag.alertType] ?? { label: flag.alertType, color: 'bg-gray-100 text-gray-600' }
                  const sfdcUrl = `https://uberall.lightning.force.com/lightning/r/Opportunity/${flag.opportunityId}/view`
                  const amount = flag.details.amount != null ? Number(flag.details.amount) : null
                  const closeDate = typeof flag.details.closeDate === 'string' ? flag.details.closeDate : null
                  const stage = typeof flag.details.stage === 'string' ? flag.details.stage : null
                  return (
                    <div key={`${flag.opportunityId}|${flag.alertType}`} className="bg-white rounded-xl border border-dashed border-gray-200 mb-2">
                      <div className="px-5 py-4">
                        <div className="flex items-center gap-2 mb-1.5 min-w-0">
                          <span className={clsx('inline-flex flex-shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold opacity-70', meta.color)}>
                            {meta.label}
                          </span>
                          <a href={sfdcUrl} target="_blank" rel="noopener noreferrer"
                            className="font-medium text-gray-900 text-sm hover:text-brand-600 truncate flex items-center gap-1">
                            {flag.opportunityName}
                            <ExternalLink size={11} className="flex-shrink-0 text-gray-300" />
                          </a>
                        </div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3">
                          {amount != null && (
                            <span className="text-xs text-gray-500"><span className="font-medium text-gray-700">ACV</span> {amount.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })}</span>
                          )}
                          {closeDate && (
                            <span className="text-xs text-gray-500"><span className="font-medium text-gray-700">Close</span> {fmtDate(closeDate)}</span>
                          )}
                          {stage && (
                            <span className="text-xs text-gray-500"><span className="font-medium text-gray-700">Stage</span> {stage}</span>
                          )}
                        </div>
                        <a href={sfdcUrl} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-brand-500 text-white rounded-lg hover:bg-brand-600">
                          Open in Salesforce <ExternalLink size={11} />
                        </a>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}

        {/* ── Whitespace tab ── */}
        {activeTab === 'whitespace' && (
          <>
            {whitespaceQuery.isLoading && (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <RefreshCw size={28} className="animate-spin text-blue-400" />
                <p className="text-sm text-gray-400">Loading expansion potential data…</p>
              </div>
            )}

            {!whitespaceQuery.isLoading && wsRecords.length === 0 && (
              <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
                <CheckCircle size={32} className="mx-auto text-green-400 mb-3" />
                <p className="text-sm font-medium text-gray-700">All caught up — no expansion potential data needed 🎉</p>
                <p className="text-xs text-gray-400 mt-1">RevBot will reach out when there's something to fill in.</p>
              </div>
            )}

            {wsRecords.length > 0 && (
              <div className="space-y-3">
                {wsRecords.map((group) => (
                  <WhitespaceAccountCard
                    key={group.accountId}
                    group={group}
                    token={token}
                    onLineSaved={(id) => setWsRemovedIds((prev) => new Set([...prev, id]))}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Territory Cleanup tab ── */}
        {activeTab === 'territory' && (
          <>
            {/* Filters live outside the data block so they stay usable while the
                query is loading or has errored. */}
            <div
              className="bg-white rounded-xl border border-gray-200 p-4 mb-3"
              // Enter anywhere in the filter bar applies, matching the muscle
              // memory of every other search box.
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !territoryDirty || territoryQuery.isFetching) return
                setTerritoryFilters(territoryDraft)
              }}
            >
              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Last rep contact before
                  </label>
                  <input
                    type="date"
                    value={territoryDraft.lastCommBefore}
                    onChange={(e) =>
                      setTerritoryDraft((f) => ({ ...f, lastCommBefore: e.target.value }))
                    }
                    className="px-2.5 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Locations</label>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={0}
                      placeholder="min"
                      value={territoryDraft.minLocations}
                      onChange={(e) =>
                        setTerritoryDraft((f) => ({ ...f, minLocations: e.target.value }))
                      }
                      className="w-20 px-2.5 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-400"
                    />
                    <span className="text-gray-400 text-xs">to</span>
                    <input
                      type="number"
                      min={0}
                      placeholder="max"
                      value={territoryDraft.maxLocations}
                      onChange={(e) =>
                        setTerritoryDraft((f) => ({ ...f, maxLocations: e.target.value }))
                      }
                      className="w-20 px-2.5 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-400"
                    />
                  </div>
                </div>

                <label className="flex items-center gap-1.5 text-xs text-gray-600 pb-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={territoryDraft.includeBlankLastComm}
                    onChange={(e) =>
                      setTerritoryDraft((f) => ({ ...f, includeBlankLastComm: e.target.checked }))
                    }
                    className="rounded border-gray-300"
                  />
                  Include never contacted
                </label>

                <div className="flex items-center gap-2 pb-1">
                  <button
                    onClick={() => setTerritoryFilters(territoryDraft)}
                    disabled={!territoryDirty || territoryQuery.isFetching}
                    className="px-3 py-1.5 text-xs font-medium bg-brand-500 text-white rounded-lg disabled:opacity-40 hover:bg-brand-600"
                  >
                    {territoryQuery.isFetching ? 'Loading…' : 'Apply'}
                  </button>
                  <button
                    onClick={() => {
                      setTerritoryDraft(DEFAULT_TERRITORY_FILTERS)
                      setTerritoryFilters(DEFAULT_TERRITORY_FILTERS)
                    }}
                    className="px-3 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50"
                  >
                    Reset
                  </button>
                </div>
              </div>

              {Boolean(territoryDraft.minLocations || territoryDraft.maxLocations) && (
                <p className="text-xs text-amber-700 mt-2.5">
                  Accounts with no location count on record are excluded while a locations
                  range is set.
                </p>
              )}
            </div>

            {territoryQuery.isLoading && (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <RefreshCw size={28} className="animate-spin text-blue-400" />
                <p className="text-sm text-gray-400">Loading your territory…</p>
              </div>
            )}

            {territoryQuery.error && (
              <div className="bg-white rounded-xl border border-red-200 p-6 text-center">
                <AlertCircle size={28} className="mx-auto text-red-400 mb-3" />
                <p className="text-sm font-medium text-gray-700">Couldn't load your territory</p>
                <p className="text-xs text-gray-400 mt-1 font-mono">
                  {(territoryQuery.error as { response?: { data?: { error?: string } } })?.response?.data?.error ??
                    String(territoryQuery.error)}
                </p>
              </div>
            )}

            {territoryQuery.data && (
              <>
                <div className="bg-white rounded-xl border border-gray-200 p-4 mb-3">
                  <p className="text-sm text-gray-700">
                    These are <strong>Prospect</strong> accounts you own,{' '}
                    {describeTerritoryFilters(territoryQuery.data.appliedFilters)}. Tell us what each
                    one should be, and we'll update Salesforce for you.
                  </p>
                  <div className="flex items-center gap-4 mt-2.5 text-xs text-gray-500">
                    <span>
                      <strong className="text-gray-800">{territoryQuery.data.accounts.length}</strong> to review
                    </span>
                    {territoryQuery.data.alreadyValidated > 0 && (
                      <span className="text-green-600">
                        <Check size={11} className="inline mb-px" /> {territoryQuery.data.alreadyValidated} done
                      </span>
                    )}
                    <span className="text-gray-400">
                      {territoryQuery.data.totalInTerritory} in territory
                    </span>

                    {/* Hidden on narrow screens, where the table isn't an option. */}
                    {canUseTable && (
                      <div className="ml-auto flex items-center rounded-lg border border-gray-200 p-0.5">
                        {([
                          { view: 'table' as const, icon: Table2, label: 'Grid' },
                          { view: 'cards' as const, icon: LayoutList, label: 'Cards' },
                        ]).map(({ view, icon: Icon, label }) => (
                          <button
                            key={view}
                            onClick={() => setTerritoryView(view)}
                            className={clsx(
                              'flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium',
                              territoryView === view
                                ? 'bg-brand-50 text-brand-700'
                                : 'text-gray-400 hover:text-gray-600',
                            )}
                          >
                            <Icon size={12} />
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {territoryQuery.data.accounts.length === 0 ? (
                  <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
                    <CheckCircle size={32} className="mx-auto text-green-400 mb-3" />
                    <p className="text-sm font-medium text-gray-700">
                      Territory's clean — nothing to review 🎉
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      We'll queue up more if new accounts go quiet.
                    </p>
                  </div>
                ) : territoryView === 'table' ? (
                  <TerritoryTable
                    accounts={territoryQuery.data.accounts.filter(
                      (a) => !territoryDoneIds.has(a.accountId),
                    )}
                    picklists={territoryQuery.data.picklists}
                    token={token}
                    onDone={(id) => setTerritoryDoneIds((prev) => new Set([...prev, id]))}
                  />
                ) : (
                  <div className="space-y-3">
                    {territoryQuery.data.accounts
                      .filter((a) => !territoryDoneIds.has(a.accountId))
                      .map((account) => (
                        <TerritoryAccountCard
                          key={account.accountId}
                          account={account}
                          picklists={territoryQuery.data!.picklists}
                          token={token}
                          onDone={(id) => setTerritoryDoneIds((prev) => new Set([...prev, id]))}
                        />
                      ))}
                  </div>
                )}
              </>
            )}
          </>
        )}

        <p className="text-center text-xs text-gray-300 pt-4">Powered by Beacon · RevOps</p>
      </div>
    </div>
  )
}

// ── Snooze options ────────────────────────────────────────────────────────────

const SNOOZE_OPTIONS = [
  { label: '3 days', days: 3 },
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
  { label: '1 month', days: 30 },
]

function addDays(d: Date, n: number) {
  const r = new Date(d); r.setDate(r.getDate() + n); return r
}

// ── Per-alert action config ───────────────────────────────────────────────────

type ActionSpec =
  | { kind: 'sfdc'; label: string; primary?: boolean }
  | { kind: 'close-date'; label: string; primary?: boolean }
  | { kind: 'next-step'; label: string; primary?: boolean }

function actionsForType(alertType: string): ActionSpec[] {
  switch (alertType) {
    case 'PAST_DUE_INITIAL':
    case 'PAST_DUE_AMENDMENT':
      return [
        { kind: 'close-date', label: 'Update Close Date', primary: true },
        { kind: 'sfdc', label: 'Open in Salesforce' },
      ]
    case 'PAST_DUE_RENEWAL':
      return [{ kind: 'sfdc', label: 'Open in Salesforce', primary: true }]
    case 'STALLED':
      return [
        { kind: 'sfdc', label: 'Update Stage', primary: true },
        { kind: 'close-date', label: 'Update Close Date' },
      ]
    case 'MEDDPICC_MISSING':
      return [{ kind: 'sfdc', label: 'Update in Salesforce', primary: true }]
    case 'NEXT_STEP_MISSING':
      return [
        { kind: 'next-step', label: 'Update Next Step', primary: true },
        { kind: 'sfdc', label: 'Open in Salesforce' },
      ]
    case 'CLOSE_DATE_RISK':
      return [
        { kind: 'close-date', label: 'Update Close Date', primary: true },
        { kind: 'sfdc', label: 'Update Stage' },
      ]
    case 'STAGE_MISMATCH':
      return [{ kind: 'sfdc', label: 'Open in Salesforce', primary: true }]
    default:
      return [{ kind: 'sfdc', label: 'Open in Salesforce', primary: true }]
  }
}

// ── Notification card ─────────────────────────────────────────────────────────

function NotifCard({
  notif,
  snoozed = false,
  snoozingId,
  onSnoozeOpen,
  onSnoozeClose,
  onSnooze,
  isSnoozePending,
  onUpdateCloseDate,
  isCloseDatePending,
  onUpdateNextStep,
  isNextStepPending,
  repRole,
}: {
  notif: RepNotification
  snoozed?: boolean
  snoozingId: string | null
  onSnoozeOpen: () => void
  onSnoozeClose: () => void
  onSnooze: (days?: number, snoozeUntil?: string) => void
  isSnoozePending: boolean
  onUpdateCloseDate: (closeDate: string) => void
  isCloseDatePending: boolean
  onUpdateNextStep: (nextStep?: string, nextStepDate?: string) => void
  isNextStepPending: boolean
  repRole?: string | null
}) {
  const [customDate, setCustomDate] = useState('')
  const [openForm, setOpenForm] = useState<'close-date' | 'next-step' | null>(null)
  const [closeDateVal, setCloseDateVal] = useState('')
  const [nsText, setNsText] = useState('')
  const [nsDate, setNsDate] = useState('')

  const meta = ALERT_META[notif.alertType] ?? { label: notif.alertType, color: 'bg-gray-100 text-gray-600', what: '' }
  const isSnoozeOpen = snoozingId === notif.id
  const actions = actionsForType(notif.alertType)

  // Future next step date used for the "1 wk after next step" snooze option
  const rawNextStepDate = (notif.alertDetails.nextStepDate as string | null | undefined) ?? null
  const nextStepFuture = rawNextStepDate && new Date(rawNextStepDate) > new Date() ? new Date(rawNextStepDate) : null

  function handleCloseDateSubmit() {
    if (!closeDateVal) return
    onUpdateCloseDate(closeDateVal)
    setOpenForm(null)
  }

  function handleNextStepSubmit() {
    if (!nsText.trim() && !nsDate) return
    onUpdateNextStep(nsText.trim() || undefined, nsDate || undefined)
    setOpenForm(null)
  }

  return (
    <div className={clsx('bg-white rounded-xl border', snoozed ? 'border-gray-100 opacity-70' : 'border-gray-200')}>
      <div className="px-5 py-4">
        {/* Opp name + SFDC link */}
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className={clsx('inline-flex flex-shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold', meta.color)}>
              {meta.label}
            </span>
            <a
              href={notif.sfdcUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-gray-900 text-sm hover:text-brand-600 truncate flex items-center gap-1"
            >
              {notif.opportunityName}
              <ExternalLink size={11} className="flex-shrink-0 text-gray-300" />
            </a>
          </div>
          {snoozed && notif.snoozedUntil && (
            <span className="flex-shrink-0 text-xs text-gray-400 flex items-center gap-1">
              <Clock size={11} /> until {fmtDate(notif.snoozedUntil)}
            </span>
          )}
        </div>

        {/* Deal metadata */}
        {(() => {
          const d = notif.alertDetails
          const amount = d.amount != null ? Number(d.amount) : null
          const closeDate = typeof d.closeDate === 'string' ? d.closeDate : null
          const stage = typeof d.stage === 'string' ? d.stage : null
          const nextStepDate = typeof d.nextStepDate === 'string' ? d.nextStepDate : null
          const nextStep = typeof d.nextStep === 'string' && d.nextStep.trim() ? d.nextStep.trim() : null
          const oppType = typeof d.oppType === 'string' ? d.oppType : null
          const isExistingBusiness = repRole?.toLowerCase().includes('existing business') ?? false
          const netAcv = d.netAcv != null ? Number(d.netAcv) : null
          const nextContractEndDate = typeof d.nextContractEndDate === 'string' ? d.nextContractEndDate : null
          const nextRenewalDate = typeof d.nextRenewalDate === 'string' ? d.nextRenewalDate : null
          const hasAutoRenewal = typeof d.hasAutoRenewal === 'boolean' ? d.hasAutoRenewal : null
          // Show contract details section when Type=Renewal and Net ACV=0
          const isRenewalZeroAcv = oppType === 'Renewal' && netAcv === 0
          return (
            <div className="mb-2.5 space-y-1.5">
              <div className="flex flex-wrap gap-x-4 gap-y-1 items-center">
                {isExistingBusiness && oppType && (
                  <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700">
                    {oppType}
                  </span>
                )}
                {amount != null && (
                  <span className="text-xs text-gray-500">
                    <span className="font-medium text-gray-700">ACV</span>{' '}
                    {amount.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })}
                  </span>
                )}
                {closeDate && (
                  <span className="text-xs text-gray-500">
                    <span className="font-medium text-gray-700">Close</span>{' '}
                    {fmtDate(closeDate)}
                  </span>
                )}
                {stage && (
                  <span className="text-xs text-gray-500">
                    <span className="font-medium text-gray-700">Stage</span>{' '}
                    {stage}
                  </span>
                )}
                {nextStepDate && (
                  <span className="text-xs text-gray-500">
                    <span className="font-medium text-gray-700">Next step date</span>{' '}
                    {fmtDate(nextStepDate)}
                  </span>
                )}
              </div>
              {nextStep && (
                <p className="text-xs text-gray-500">
                  <span className="font-medium text-gray-700">Next step</span>{' '}
                  {nextStep}
                </p>
              )}
              {/* Renewal $0 ACV: show contract details from Account */}
              {isRenewalZeroAcv && (
                <div className="mt-2 pt-2.5 border-t border-gray-100 space-y-2">
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Contract details</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {nextContractEndDate && (
                      <span className="text-xs text-gray-500">
                        <span className="font-medium text-gray-700">Contract End</span>{' '}
                        {fmtDate(nextContractEndDate)}
                      </span>
                    )}
                    {nextRenewalDate && (
                      <span className="text-xs text-gray-500">
                        <span className="font-medium text-gray-700">Cancellation Deadline</span>{' '}
                        {fmtDate(nextRenewalDate)}
                      </span>
                    )}
                    {hasAutoRenewal !== null && (
                      <span className="text-xs text-gray-500">
                        <span className="font-medium text-gray-700">Auto-Renewal</span>{' '}
                        <span className={hasAutoRenewal ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>
                          {hasAutoRenewal ? 'Yes' : 'No'}
                        </span>
                      </span>
                    )}
                  </div>
                  {hasAutoRenewal && nextContractEndDate && (
                    <button
                      disabled={isNextStepPending}
                      onClick={() => {
                        const contractEnd = new Date(nextContractEndDate)
                        const startDate = new Date(contractEnd)
                        startDate.setDate(startDate.getDate() + 1)
                        const fmtLong = (d: Date) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
                        const text = `Contract will auto-renew on ${fmtLong(contractEnd)} and start on ${fmtLong(startDate)}`
                        onUpdateNextStep(text, nextContractEndDate)
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-40"
                    >
                      <Check size={11} /> No Price Increase — Generate Next Step
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })()}

        {/* What to do */}
        <p className="text-sm text-gray-600 mb-3">{meta.what}</p>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          {actions.map((action) => {
            if (action.kind === 'sfdc') {
              return (
                <a
                  key={action.label}
                  href={notif.sfdcUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={clsx(
                    'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg',
                    action.primary
                      ? 'bg-brand-500 text-white hover:bg-brand-600'
                      : 'text-gray-500 border border-gray-200 hover:bg-gray-50',
                  )}
                >
                  {action.label} <ExternalLink size={11} />
                </a>
              )
            }

            if (action.kind === 'close-date') {
              return (
                <button
                  key={action.label}
                  onClick={() => setOpenForm(openForm === 'close-date' ? null : 'close-date')}
                  className={clsx(
                    'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg',
                    action.primary
                      ? 'bg-brand-500 text-white hover:bg-brand-600'
                      : 'text-gray-500 border border-gray-200 hover:bg-gray-50',
                    openForm === 'close-date' && action.primary && 'ring-2 ring-brand-300',
                  )}
                >
                  {action.label}
                  <ChevronDown size={11} className={clsx('transition-transform', openForm === 'close-date' && 'rotate-180')} />
                </button>
              )
            }

            if (action.kind === 'next-step') {
              return (
                <button
                  key={action.label}
                  onClick={() => setOpenForm(openForm === 'next-step' ? null : 'next-step')}
                  className={clsx(
                    'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg',
                    action.primary
                      ? 'bg-brand-500 text-white hover:bg-brand-600'
                      : 'text-gray-500 border border-gray-200 hover:bg-gray-50',
                    openForm === 'next-step' && action.primary && 'ring-2 ring-brand-300',
                  )}
                >
                  {action.label}
                  <ChevronDown size={11} className={clsx('transition-transform', openForm === 'next-step' && 'rotate-180')} />
                </button>
              )
            }

            return null
          })}

          {/* Snooze */}
          {!snoozed && (
            <div className="relative">
              <button
                onClick={isSnoozeOpen ? onSnoozeClose : onSnoozeOpen}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                <BellOff size={11} />
                Snooze <ChevronDown size={11} className={clsx('transition-transform', isSnoozeOpen && 'rotate-180')} />
              </button>

              {isSnoozeOpen && (
                <div className="absolute left-0 top-full mt-1 z-50 bg-white border border-gray-200 rounded-xl shadow-xl text-xs min-w-[200px]">
                  <p className="px-3 pt-2.5 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Snooze until</p>

                  {SNOOZE_OPTIONS.map((opt) => {
                    const until = addDays(new Date(), opt.days)
                    return (
                      <button
                        key={opt.days}
                        onClick={() => onSnooze(opt.days)}
                        disabled={isSnoozePending}
                        className="w-full text-left px-3 py-2 hover:bg-amber-50 hover:text-amber-800 disabled:opacity-50 text-gray-700 flex items-center justify-between"
                      >
                        <span>{opt.label}</span>
                        <span className="text-gray-400">{until.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                      </button>
                    )
                  })}

                  {nextStepFuture && (
                    <>
                      <div className="border-t border-gray-100 mt-1" />
                      <button
                        onClick={() => onSnooze(undefined, addDays(nextStepFuture, 7).toISOString())}
                        disabled={isSnoozePending}
                        className="w-full text-left px-3 py-2 hover:bg-blue-50 hover:text-blue-800 disabled:opacity-50 text-blue-600 flex items-center justify-between"
                      >
                        <span>1 wk after next step</span>
                        <span className="text-blue-400">{addDays(nextStepFuture, 7).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                      </button>
                    </>
                  )}

                  <div className="border-t border-gray-100 mt-1 px-3 py-2.5">
                    <p className="text-[10px] text-gray-400 mb-1.5 font-medium">Custom date</p>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="date"
                        value={customDate}
                        min={new Date().toISOString().split('T')[0]}
                        onChange={(e) => setCustomDate(e.target.value)}
                        className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5 min-w-0"
                      />
                      <button
                        disabled={!customDate || isSnoozePending}
                        onClick={() => onSnooze(undefined, new Date(customDate + 'T12:00:00').toISOString())}
                        className="px-2.5 py-1.5 text-xs bg-amber-500 text-white rounded-lg disabled:opacity-40 hover:bg-amber-600 font-medium"
                      >
                        Set
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {notif.sentAt && (
            <span className="text-xs text-gray-300 ml-auto">Sent {fmtDate(notif.sentAt)}</span>
          )}
        </div>

        {/* Inline: Update Close Date */}
        {openForm === 'close-date' && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <p className="text-xs font-medium text-gray-700 mb-2">New close date</p>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={closeDateVal}
                min={new Date().toISOString().split('T')[0]}
                onChange={(e) => setCloseDateVal(e.target.value)}
                className="flex-1 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5"
              />
              <button
                disabled={!closeDateVal || isCloseDatePending}
                onClick={handleCloseDateSubmit}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-brand-500 text-white rounded-lg disabled:opacity-40 hover:bg-brand-600"
              >
                <Check size={11} /> Save to Salesforce
              </button>
              <button onClick={() => setOpenForm(null)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
            </div>
          </div>
        )}

        {/* Inline: Update Next Step */}
        {openForm === 'next-step' && (
          <div className="mt-3 pt-3 border-t border-gray-100 space-y-2">
            <p className="text-xs font-medium text-gray-700">Update next step</p>
            <textarea
              value={nsText}
              onChange={(e) => setNsText(e.target.value)}
              placeholder="What's the next action on this deal?"
              rows={2}
              className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 resize-none"
            />
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <p className="text-[10px] text-gray-400 mb-1">Next step date</p>
                <input
                  type="date"
                  value={nsDate}
                  min={new Date().toISOString().split('T')[0]}
                  onChange={(e) => setNsDate(e.target.value)}
                  className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5"
                />
              </div>
              <div className="flex flex-col gap-1.5 pt-4">
                <button
                  disabled={(!nsText.trim() && !nsDate) || isNextStepPending}
                  onClick={handleNextStepSubmit}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-brand-500 text-white rounded-lg disabled:opacity-40 hover:bg-brand-600 whitespace-nowrap"
                >
                  <Check size={11} /> Save to Salesforce
                </button>
                <button onClick={() => setOpenForm(null)} className="text-xs text-gray-400 hover:text-gray-600 text-center">Cancel</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Territory Cleanup card ────────────────────────────────────────────────────

/**
 * Everything a disposition needs: form state, the mirrored validation rules, and
 * the save. Shared by the card and the table row so the two views can't drift
 * apart on what's required — the rules here are the ones the server enforces.
 */
function useDispositionForm({
  account,
  token,
  onDone,
}: {
  account: TerritoryAccount
  token: string
  onDone: (accountId: string) => void
}) {
  const [disposition, setDisposition] = useState<Disposition | null>(null)
  const [subReason, setSubReason] = useState<NoIcpSubReason | null>(null)
  const [feedback, setFeedback] = useState('')
  const [locations, setLocations] = useState('')
  // Seeded from Salesforce so an already-correct value just needs confirming.
  const [operatingModel, setOperatingModel] = useState(account.operatingModel ?? '')
  const [productFitRationale, setProductFitRationale] = useState(
    account.productFitRationale ?? '',
  )
  const [nominateForBdrFocus, setNominateForBdrFocus] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = useMutation({
    mutationFn: () =>
      repApi
        .post('/rep/territory-cleanup/disposition', {
          token,
          accountId: account.accountId,
          accountName: account.accountName,
          disposition,
          subReason,
          feedback: feedback.trim() || null,
          // Only send corrections the rep actually changed.
          numberOfLocations: locations.trim() ? Number(locations) : null,
          operatingModel: operatingModel || null,
          nominateForBdrFocus,
          // Unchanged means don't write it, so an untouched rationale doesn't
          // rewrite itself and bump LastModified on every save.
          productFitRationale:
            productFitRationale.trim() !== (account.productFitRationale ?? '').trim()
              ? productFitRationale.trim()
              : null,
        })
        .then((r) => r.data),
    onSuccess: () => {
      setErr(null)
      onDone(account.accountId)
    },
    onError: (e: unknown) => {
      setErr(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? String(e),
      )
    },
  })

  const selected = DISPOSITION_OPTIONS.find((o) => o.value === disposition)

  // Validation mirrors the server so reps get instant feedback.
  const needsSubReason = disposition === 'NO_ICP' && !subReason
  const needsNote = disposition === 'OTHER' && !feedback.trim()
  // Both "keep it" verdicts ask the rep to validate the operating model — it's the
  // field we most need on accounts anyone intends to work.
  const needsOperatingModel =
    (disposition === 'GOOD_LEAVE_IN_TERRITORY' ||
      disposition === 'USE_CASE_LOW_PRIORITY') &&
    !operatingModel
  const canSubmit =
    !!disposition &&
    !needsSubReason &&
    !needsNote &&
    !needsOperatingModel &&
    !submit.isPending

  const locationsDisplay =
    account.numberOfLocations ?? account.currentLocations ?? null

  /** Undefined for dispositions that say nothing about product fit. */
  const impliedProductFit = disposition
    ? PRODUCT_FIT_BY_DISPOSITION[disposition]
    : undefined

  /** Reset to a clean slate on a new pick — a stale sub-reason must not survive. */
  function pickDisposition(value: Disposition | null) {
    setDisposition(value)
    setSubReason(null)
    setErr(null)
  }

  return {
    disposition,
    pickDisposition,
    subReason,
    setSubReason,
    feedback,
    setFeedback,
    locations,
    setLocations,
    operatingModel,
    setOperatingModel,
    productFitRationale,
    setProductFitRationale,
    nominateForBdrFocus,
    setNominateForBdrFocus,
    err,
    submit,
    selected,
    needsSubReason,
    needsNote,
    needsOperatingModel,
    canSubmit,
    locationsDisplay,
    impliedProductFit,
  }
}

function TerritoryAccountCard({
  account,
  picklists,
  token,
  onDone,
}: {
  account: TerritoryAccount
  picklists: RepPicklists
  token: string
  onDone: (accountId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const {
    disposition,
    pickDisposition,
    subReason,
    setSubReason,
    feedback,
    setFeedback,
    locations,
    setLocations,
    operatingModel,
    setOperatingModel,
    productFitRationale,
    setProductFitRationale,
    nominateForBdrFocus,
    setNominateForBdrFocus,
    err,
    submit,
    selected,
    needsOperatingModel,
    canSubmit,
    locationsDisplay,
    impliedProductFit,
  } = useDispositionForm({ account, token, onDone })

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start justify-between gap-3 p-4 text-left hover:bg-gray-50"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{account.accountName}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-gray-500">
            {account.industry && <span>{account.industry}</span>}
            {locationsDisplay != null && <span>{locationsDisplay} locations</span>}
            {account.billingCountry && <span>{account.billingCountry}</span>}
          </div>
          {/* Description on the collapsed card: it's the fastest way to tell what a
              company does, and a rep shouldn't have to expand every row to get it.
              Hidden once expanded, where the full untruncated text is shown. */}
          {!expanded && (
            <p className="text-[11px] text-gray-500 mt-1 line-clamp-2 whitespace-pre-line">
              {account.description?.trim() || (
                <span className="text-gray-300 italic">No company description on record</span>
              )}
            </p>
          )}
          <p className="text-[11px] text-gray-400 mt-1">
            Last rep contact:{' '}
            {account.lastRepCommunicationDate
              ? fmtDate(account.lastRepCommunicationDate)
              : 'never logged'}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a
            href={account.sfdcUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="p-1.5 text-gray-300 hover:text-brand-500"
            title="Open in Salesforce"
          >
            <ExternalLink size={13} />
          </a>
          {expanded ? (
            <ChevronUp size={15} className="text-gray-400" />
          ) : (
            <ChevronDown size={15} className="text-gray-400" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 p-4 space-y-4">
          {/* Context the rep needs to judge */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs bg-gray-50 rounded-lg p-3">
            {/* Description leads — it's the fastest way for a rep to tell what the
                company actually does before judging fit. */}
            {/* Always rendered, even when blank — the collapsed card says "no
                description on record", so it would be odd for that to vanish on
                expand and leave the rep unsure whether it just wasn't shown. */}
            <div className="col-span-2">
              <p className="text-[10px] uppercase tracking-wide text-gray-400">Company description</p>
              <p className="text-gray-700 whitespace-pre-line">
                {account.description?.trim() || (
                  <span className="text-gray-300 italic">No company description on record</span>
                )}
              </p>
            </div>
            <Detail label="Industry" value={account.industry} />
            <Detail label="Sub-industry" value={account.subIndustry} />
            <Detail label="Locations" value={locationsDisplay?.toString() ?? null} />
            <Detail
              label="Parent"
              value={account.parentName ?? account.ultimateParent ?? null}
            />
            <Detail label="Operating model" value={account.operatingModel} />
            <Detail
              label="Product fit"
              value={account.productFit ? productFitLabel(account.productFit, picklists) : null}
            />
            {account.productFitRationale?.trim() && (
              <div className="col-span-2">
                <p className="text-[10px] uppercase tracking-wide text-gray-400">
                  Product fit rationale
                </p>
                {/* Long Text Area (32k) — scroll rather than let one verbose
                    rationale push the disposition buttons off screen. */}
                <p className="text-gray-700 whitespace-pre-line max-h-32 overflow-y-auto">
                  {account.productFitRationale}
                </p>
              </div>
            )}
            {account.website && (
              <div className="col-span-2">
                <p className="text-[10px] uppercase tracking-wide text-gray-400">Website</p>
                <a
                  href={account.website.startsWith('http') ? account.website : `https://${account.website}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand-600 hover:underline break-all"
                >
                  {account.website}
                </a>
              </div>
            )}
          </div>

          {/* Disposition picker */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-gray-700">What should happen to this account?</p>
            {DISPOSITION_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={clsx(
                  'flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors',
                  disposition === opt.value
                    ? opt.tone
                    : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50',
                )}
              >
                <input
                  type="radio"
                  name={`disp-${account.accountId}`}
                  checked={disposition === opt.value}
                  onChange={() => pickDisposition(opt.value)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block text-xs font-medium">{opt.label}</span>
                  <span className="block text-[11px] opacity-75 mt-0.5">{opt.hint}</span>
                </span>
              </label>
            ))}
          </div>

          {/* Great account → confirm operating model + hierarchy */}
          {disposition === 'GOOD_LEAVE_IN_TERRITORY' && (
            <div className="space-y-2.5 border-l-2 border-green-300 pl-3">
              <p className="text-[11px] font-medium text-gray-600">
                Quick check while you're here — correct anything that's wrong.
              </p>
              <div>
                <p className="text-[10px] text-gray-400 mb-1">
                  Operating model{' '}
                  {account.operatingModel
                    ? `(currently ${account.operatingModel} — confirm or change)`
                    : '(currently blank — required)'}
                </p>
                <select
                  value={operatingModel}
                  onChange={(e) => setOperatingModel(e.target.value)}
                  className={`w-full text-xs border rounded-lg px-2.5 py-1.5 bg-white ${
                    needsOperatingModel ? 'border-amber-400' : 'border-gray-200'
                  }`}
                >
                  <option value="">— Select operating model —</option>
                  {/* ?? [] because the frontend can deploy ahead of the backend,
                      and an older API response has no operatingModel list. */}
                  {(picklists.operatingModel ?? []).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              <label className="flex items-start gap-2 text-xs text-gray-700 bg-indigo-50 border border-indigo-200 rounded-lg px-2.5 py-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={nominateForBdrFocus}
                  onChange={(e) => setNominateForBdrFocus(e.target.checked)}
                />
                <span>
                  <span className="font-medium">
                    Nominate for next month’s BDR focus list
                  </span>
                  <span className="block text-[10px] text-gray-500 mt-0.5">
                    Sets <strong>Target Prospecting Date</strong> to{' '}
                    {fmtDateOnly(nextMonthSecond())}
                    {/* Mirror the server rule so the checkbox doesn't promise a status
                        change it won't make on an account already being worked. */}
                    {NOMINATABLE_PROSPECTING_STATUSES.includes(
                      account.prospectingStatus ?? '',
                    )
                      ? ' and Prospecting Status to “Planned”.'
                      : `. Prospecting Status stays “${account.prospectingStatus}”.`}
                  </span>
                </span>
              </label>

              <div className="text-[11px] text-gray-500">
                Hierarchy:{' '}
                {account.parentName || account.ultimateParent ? (
                  <span className="text-gray-700">
                    {account.parentName ?? account.ultimateParent}
                  </span>
                ) : (
                  <span className="text-amber-600">no parent set</span>
                )}
                {' — '}
                <a
                  href={account.sfdcUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand-600 hover:underline"
                >
                  Check the hierarchy
                </a>
              </div>
            </div>
          )}

          {/* Low priority → operating model + why it's only a partial fit */}
          {disposition === 'USE_CASE_LOW_PRIORITY' && (
            <div className="space-y-2.5 border-l-2 border-amber-300 pl-3">
              <div>
                <p className="text-[10px] text-gray-400 mb-1">
                  Operating model{' '}
                  {account.operatingModel
                    ? `(currently ${account.operatingModel} — confirm or change)`
                    : '(currently blank — required)'}
                </p>
                <select
                  value={operatingModel}
                  onChange={(e) => setOperatingModel(e.target.value)}
                  className={`w-full text-xs border rounded-lg px-2.5 py-1.5 bg-white ${
                    needsOperatingModel ? 'border-amber-400' : 'border-gray-200'
                  }`}
                >
                  <option value="">— Select operating model —</option>
                  {(picklists.operatingModel ?? []).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <p className="text-[10px] text-gray-400 mb-1">
                  Product fit rationale — why is this only a partial fit?
                </p>
                {/* Seeded with what's already on the record, so the rep edits the
                    existing rationale instead of silently replacing it. */}
                <textarea
                  value={productFitRationale}
                  onChange={(e) => setProductFitRationale(e.target.value)}
                  rows={3}
                  placeholder="e.g. Has a use case for listings but only 12 locations, no local marketing team."
                  className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5"
                />
              </div>
            </div>
          )}

          {/* No fit → reason */}
          {disposition === 'NO_ICP' && (
            <div className="space-y-1.5 border-l-2 border-red-300 pl-3">
              <p className="text-[11px] font-medium text-gray-600">Why is it not a fit?</p>
              {NO_ICP_REASONS.map((r) => (
                <label
                  key={r.value}
                  className="flex items-start gap-2 text-xs text-gray-700 cursor-pointer"
                >
                  <input
                    type="radio"
                    className="mt-0.5"
                    name={`noicp-${account.accountId}`}
                    checked={subReason === r.value}
                    onChange={() => setSubReason(r.value)}
                  />
                  <span>
                    {r.label}
                    <span className="block text-[10px] text-gray-400">{r.effect}</span>
                  </span>
                </label>
              ))}
              {subReason === 'TOO_SMALL' && (
                <div className="pt-1.5">
                  <p className="text-[10px] text-gray-400 mb-1">
                    Correct location count{' '}
                    {locationsDisplay != null ? `(currently ${locationsDisplay})` : ''}
                  </p>
                  <input
                    type="number"
                    min={0}
                    value={locations}
                    onChange={(e) => setLocations(e.target.value)}
                    placeholder="e.g. 4"
                    className="w-32 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5"
                  />
                </div>
              )}
            </div>
          )}

          {/* Say the quiet part out loud — reps should know what we'll write.
              Suppressed when Salesforce already says it, since we skip that write. */}
          {impliedProductFit && impliedProductFit !== account.productFit && (
            <p className="text-[10px] text-gray-400">
              This will set <strong>Product Fit</strong> to “
              {productFitLabel(impliedProductFit, picklists)}”
              {account.productFit
                ? ` (currently ${productFitLabel(account.productFit, picklists)})`
                : ''}
              .
            </p>
          )}

          {/* Feedback — always available, required for Other */}
          <div>
            <p className="text-[10px] text-gray-400 mb-1">
              Anything else we should know? {disposition === 'OTHER' && <span className="text-red-500">(required)</span>}
            </p>
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={2}
              placeholder="Optional context for RevOps…"
              className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 resize-none"
            />
          </div>

          {selected && (
            <p className="text-[11px] text-gray-500 bg-gray-50 rounded-lg px-2.5 py-2">
              <strong>On save:</strong> {selected.hint}
            </p>
          )}

          {err && (
            <p className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded-lg px-2.5 py-2">
              {err}
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              disabled={!canSubmit}
              onClick={() => submit.mutate()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-brand-500 text-white rounded-lg disabled:opacity-40 hover:bg-brand-600"
            >
              {submit.isPending ? (
                <RefreshCw size={11} className="animate-spin" />
              ) : (
                <Check size={11} />
              )}
              {submit.isPending ? 'Saving…' : 'Save to Salesforce'}
            </button>
            <button
              onClick={() => setExpanded(false)}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Territory table (grid view) ───────────────────────────────────────────────

/** Shared cell padding so the header and body columns line up. */
const TD = 'px-2.5 py-2 align-middle'

const HOVER_CARD_W = 340

/**
 * Hover tooltip for text too long to sit in a grid cell.
 *
 * Portalled to `document.body` and positioned with fixed coordinates measured on
 * hover, because the table lives in an `overflow-x-auto` container that clips any
 * absolutely-positioned child. Renders `children` untouched when there's no text,
 * so a cell with nothing to reveal gets no hover affordance at all.
 */
function HoverCard({
  label,
  text,
  children,
  className,
}: {
  label: string
  text: string | null | undefined
  children: React.ReactNode
  /** Applied to the trigger. Needed for `min-w-0` when the trigger is a flex child. */
  className?: string
}) {
  const [pos, setPos] = useState<{ top: number; left: number; flip: boolean } | null>(null)

  // Fixed coordinates go stale as soon as anything scrolls, so close rather than
  // try to follow. `capture` is what catches the table's own scroll container.
  useEffect(() => {
    if (!pos) return
    const close = () => setPos(null)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [pos])

  if (!text) return <span className={className}>{children}</span>

  const open = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    // Prefer above; drop below only when there isn't room, so the card doesn't
    // cover the row the rep is about to act on.
    const flip = r.top < 240
    setPos({
      top: flip ? r.bottom + 6 : r.top - 6,
      left: Math.min(Math.max(8, r.left), window.innerWidth - HOVER_CARD_W - 8),
      flip,
    })
  }

  return (
    <span
      className={clsx(
        'cursor-help decoration-gray-300 decoration-dotted underline-offset-2 hover:underline',
        className,
      )}
      onMouseEnter={open}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 rounded-lg border border-gray-200 bg-white p-3 shadow-lg"
            style={{
              width: HOVER_CARD_W,
              left: pos.left,
              top: pos.top,
              transform: pos.flip ? undefined : 'translateY(-100%)',
            }}
          >
            <p className="mb-1 text-[10px] uppercase tracking-wide text-gray-400">{label}</p>
            {/* Capped: a very long rationale would otherwise cover the grid. The
                expanded row still has the full text. */}
            <p className="max-h-56 overflow-hidden whitespace-pre-line text-[11px] leading-relaxed text-gray-700">
              {text}
            </p>
          </div>,
          document.body,
        )}
    </span>
  )
}

/**
 * One account per row. Picking a disposition opens a detail row underneath for
 * the follow-ups that don't fit in a cell — required ones are marked, and Save
 * stays disabled until they're filled, same rules as the card.
 */
function TerritoryAccountRow({
  account,
  picklists,
  token,
  onDone,
}: {
  account: TerritoryAccount
  picklists: RepPicklists
  token: string
  onDone: (accountId: string) => void
}) {
  const {
    disposition,
    pickDisposition,
    subReason,
    setSubReason,
    feedback,
    setFeedback,
    locations,
    setLocations,
    operatingModel,
    setOperatingModel,
    productFitRationale,
    setProductFitRationale,
    nominateForBdrFocus,
    setNominateForBdrFocus,
    err,
    submit,
    selected,
    needsSubReason,
    needsNote,
    needsOperatingModel,
    canSubmit,
    locationsDisplay,
    impliedProductFit,
  } = useDispositionForm({ account, token, onDone })

  const [showContext, setShowContext] = useState(false)

  const parent = account.parentName ?? account.ultimateParent
  const description = account.description?.trim()
  const rationale = account.productFitRationale?.trim()

  return (
    <>
      <tr className={clsx('border-t border-gray-100', disposition && 'bg-brand-50/40')}>
        <td className={clsx(TD, 'max-w-[22rem]')}>
          <div className="flex items-center gap-1.5">
            {/* Toggles the context row. A hover popover would be clipped by the
                table's horizontal scroll container, so this expands in place. */}
            <button
              onClick={() => setShowContext((v) => !v)}
              className={clsx(
                'shrink-0 rounded p-0.5 hover:bg-gray-100',
                showContext ? 'text-brand-500' : 'text-gray-300 hover:text-gray-500',
              )}
              title={showContext ? 'Hide company description' : 'Show company description and rationale'}
              aria-expanded={showContext}
            >
              {showContext ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
            {/* title keeps the full name reachable on hover even though the
                hover card is showing the description. */}
            <HoverCard label="Company description" text={description} className="min-w-0 truncate">
              <span className="truncate font-medium text-gray-900" title={account.accountName}>
                {account.accountName}
              </span>
            </HoverCard>
            <a
              href={account.sfdcUrl}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-gray-300 hover:text-brand-500"
              title="Open in Salesforce"
            >
              <ExternalLink size={11} />
            </a>
          </div>
          {/* Truncated here for a fast scan; the full text is one click away. The
              native title gives a hover preview without the extra click. */}
          <p
            className="truncate pl-[1.15rem] text-[11px] text-gray-400"
            title={description || undefined}
          >
            {description || <span className="italic text-gray-300">No company description</span>}
          </p>
        </td>
        <td className={clsx(TD, 'max-w-[9rem] truncate text-gray-600')} title={account.industry ?? ''}>
          {account.industry || <span className="text-gray-300">—</span>}
        </td>
        <td className={clsx(TD, 'text-right tabular-nums text-gray-600')}>
          {locationsDisplay ?? <span className="text-gray-300">—</span>}
        </td>
        {/* nowrap: "United States" wrapping to two lines makes the row taller than
            its neighbours and the grid loses its scannability. */}
        <td className={clsx(TD, 'max-w-[8rem] truncate whitespace-nowrap text-gray-600')}>
          {account.billingCountry || <span className="text-gray-300">—</span>}
        </td>
        <td className={clsx(TD, 'max-w-[11rem] truncate text-gray-600')} title={parent ?? ''}>
          {parent || <span className="text-amber-600">no parent</span>}
        </td>
        <td className={clsx(TD, 'whitespace-nowrap text-gray-600')}>
          <HoverCard label="Product fit rationale" text={rationale}>
            {account.productFit ? (
              productFitLabel(account.productFit, picklists)
            ) : (
              <span className="text-gray-300">—</span>
            )}
          </HoverCard>
        </td>
        <td className={clsx(TD, 'whitespace-nowrap text-gray-500')}>
          {account.lastRepCommunicationDate ? (
            fmtDate(account.lastRepCommunicationDate)
          ) : (
            <span className="text-gray-400">never</span>
          )}
        </td>
        <td className={TD}>
          <select
            value={disposition ?? ''}
            onChange={(e) => pickDisposition((e.target.value || null) as Disposition | null)}
            className="w-full min-w-[13rem] rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs"
          >
            <option value="">— Pick one —</option>
            {DISPOSITION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </td>
        <td className={clsx(TD, 'text-right')}>
          <button
            disabled={!canSubmit}
            onClick={() => submit.mutate()}
            className="inline-flex items-center gap-1 rounded-lg bg-brand-500 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-40"
          >
            {submit.isPending ? (
              <RefreshCw size={11} className="animate-spin" />
            ) : (
              <Check size={11} />
            )}
            Save
          </button>
        </td>
      </tr>

      {/* Read-only context: what's already on the record, for judging fit. */}
      {showContext && (
        <tr className={clsx(disposition ? 'bg-brand-50/40' : 'bg-gray-50')}>
          <td colSpan={9} className="px-2.5 pb-2.5 pt-0">
            <div className="grid gap-x-6 gap-y-2 rounded-lg border border-gray-200 bg-white p-3 md:grid-cols-2">
              <div className="md:col-span-2">
                <p className="text-[10px] uppercase tracking-wide text-gray-400">Company description</p>
                <p className="whitespace-pre-line text-gray-700">
                  {description || <span className="italic text-gray-300">No company description on record</span>}
                </p>
              </div>
              <div className="md:col-span-2">
                <p className="text-[10px] uppercase tracking-wide text-gray-400">
                  Product fit rationale
                  {account.productFit && (
                    <span className="ml-1.5 normal-case tracking-normal text-gray-500">
                      (currently {productFitLabel(account.productFit, picklists)})
                    </span>
                  )}
                </p>
                {/* Long Text Area (32k) — scroll rather than let one verbose
                    rationale push the rest of the queue off screen. */}
                <p className="max-h-32 overflow-y-auto whitespace-pre-line text-gray-700">
                  {rationale || <span className="italic text-gray-300">No rationale on record</span>}
                </p>
              </div>
              <Detail label="Sub-industry" value={account.subIndustry} />
              <Detail label="Operating model" value={account.operatingModel} />
              <Detail label="Prospecting status" value={account.prospectingStatus} />
              <Detail label="Pause reason" value={account.prospectingPauseReason} />
              {account.website && (
                <div className="md:col-span-2">
                  <p className="text-[10px] uppercase tracking-wide text-gray-400">Website</p>
                  <a
                    href={
                      account.website.startsWith('http')
                        ? account.website
                        : `https://${account.website}`
                    }
                    target="_blank"
                    rel="noreferrer"
                    className="break-all text-brand-600 hover:underline"
                  >
                    {account.website}
                  </a>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}

      {disposition && (
        <tr className="bg-brand-50/40">
          <td colSpan={9} className="px-2.5 pb-3 pt-0">
            <div className="space-y-2.5 rounded-lg border border-gray-200 bg-white p-2.5">
              {/* Both "keep it" verdicts validate the operating model. */}
              {(disposition === 'GOOD_LEAVE_IN_TERRITORY' ||
                disposition === 'USE_CASE_LOW_PRIORITY') && (
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <p className="mb-1 text-[10px] text-gray-400">
                      Operating model{' '}
                      {account.operatingModel
                        ? `(currently ${account.operatingModel})`
                        : '(blank — required)'}
                    </p>
                    <select
                      value={operatingModel}
                      onChange={(e) => setOperatingModel(e.target.value)}
                      className={clsx(
                        'min-w-[12rem] rounded-lg border bg-white px-2 py-1.5 text-xs',
                        needsOperatingModel ? 'border-amber-400' : 'border-gray-200',
                      )}
                    >
                      <option value="">— Select operating model —</option>
                      {(picklists.operatingModel ?? []).map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                  {disposition === 'GOOD_LEAVE_IN_TERRITORY' && (
                    <>
                      <label className="flex cursor-pointer items-center gap-1.5 pb-1.5 text-xs text-gray-700">
                        <input
                          type="checkbox"
                          checked={nominateForBdrFocus}
                          onChange={(e) => setNominateForBdrFocus(e.target.checked)}
                        />
                        Nominate for next month’s BDR focus list
                      </label>
                      <a
                        href={account.sfdcUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="pb-1.5 text-xs text-brand-600 hover:underline"
                      >
                        Check the hierarchy
                      </a>
                    </>
                  )}
                </div>
              )}

              {disposition === 'USE_CASE_LOW_PRIORITY' && (
                <div>
                  <p className="mb-1 text-[10px] text-gray-400">
                    Product fit rationale — why is this only a partial fit?
                  </p>
                  <textarea
                    value={productFitRationale}
                    onChange={(e) => setProductFitRationale(e.target.value)}
                    rows={2}
                    placeholder="e.g. Listings use case, but only 12 locations and no local marketing team."
                    className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
                  />
                </div>
              )}

              {disposition === 'NO_ICP' && (
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <p className="mb-1 text-[10px] text-gray-400">Why is it not a fit? (required)</p>
                    <select
                      value={subReason ?? ''}
                      onChange={(e) =>
                        setSubReason((e.target.value || null) as NoIcpSubReason | null)
                      }
                      className={clsx(
                        'min-w-[16rem] rounded-lg border bg-white px-2 py-1.5 text-xs',
                        needsSubReason ? 'border-amber-400' : 'border-gray-200',
                      )}
                    >
                      <option value="">— Select a reason —</option>
                      {NO_ICP_REASONS.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label} → {r.effect}
                        </option>
                      ))}
                    </select>
                  </div>
                  {subReason === 'TOO_SMALL' && (
                    <div>
                      <p className="mb-1 text-[10px] text-gray-400">
                        Correct location count{' '}
                        {locationsDisplay != null ? `(currently ${locationsDisplay})` : ''}
                      </p>
                      <input
                        type="number"
                        min={0}
                        value={locations}
                        onChange={(e) => setLocations(e.target.value)}
                        placeholder="e.g. 4"
                        className="w-28 rounded-lg border border-gray-200 px-2 py-1.5 text-xs"
                      />
                    </div>
                  )}
                </div>
              )}

              <div>
                <p className="mb-1 text-[10px] text-gray-400">
                  {disposition === 'DUPLICATE'
                    ? 'Which account is it a duplicate of?'
                    : 'Anything else we should know?'}{' '}
                  {needsNote && <span className="text-red-500">(required)</span>}
                </p>
                <textarea
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  rows={2}
                  className={clsx(
                    'w-full resize-none rounded-lg border px-2 py-1.5 text-xs',
                    needsNote ? 'border-amber-400' : 'border-gray-200',
                  )}
                  placeholder={
                    disposition === 'DUPLICATE'
                      ? 'e.g. duplicate of Acme Corp (the record with the open opp)'
                      : 'Optional context for RevOps…'
                  }
                />
              </div>

              {selected && (
                <p className="text-[11px] text-gray-500">
                  <strong>On save:</strong> {selected.hint}
                  {/* Only add the Product Fit sentence when the hint doesn't already
                      say it, or it reads twice in a row. */}
                  {impliedProductFit &&
                    impliedProductFit !== account.productFit &&
                    !selected.hint.includes('Product Fit') && (
                      <>
                        {' '}
                        Sets Product Fit to “{productFitLabel(impliedProductFit, picklists)}”.
                      </>
                    )}
                </p>
              )}

              {err && (
                <p className="rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-600">
                  {err}
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function TerritoryTable({
  accounts,
  picklists,
  token,
  onDone,
}: {
  accounts: TerritoryAccount[]
  picklists: RepPicklists
  token: string
  onDone: (accountId: string) => void
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
      <table className="w-full min-w-[68rem] text-xs">
        {/* Sticky so the columns stay identifiable once a rep scrolls a long queue. */}
        <thead className="sticky top-0 z-10 bg-gray-50 text-[10px] uppercase tracking-wide text-gray-400">
          <tr className="[&>th]:whitespace-nowrap [&>th]:px-2.5 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
            <th>Account</th>
            <th>Industry</th>
            <th className="!text-right">Locs</th>
            <th>Country</th>
            <th>Parent</th>
            <th>Product fit</th>
            <th>Last contact</th>
            <th>What should happen?</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <TerritoryAccountRow
              key={account.accountId}
              account={account}
              picklists={picklists}
              token={token}
              onDone={onDone}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-gray-400">{label}</p>
      <p className="text-gray-700">{value || <span className="text-gray-300">—</span>}</p>
    </div>
  )
}

// ── Whitespace components ─────────────────────────────────────────────────────

function WhitespaceAccountCard({
  group,
  token,
  onLineSaved,
}: {
  group: WhitespaceAccountGroup
  token: string
  onLineSaved: (id: string) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-semibold text-gray-900 truncate">{group.accountName}</span>
          <span className="shrink-0 text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
            {group.lines.length} line{group.lines.length !== 1 ? 's' : ''}
          </span>
        </div>
        {open ? <ChevronUp size={14} className="text-gray-400 shrink-0" /> : <ChevronDown size={14} className="text-gray-400 shrink-0" />}
      </button>

      {open && (
        <div className="border-t border-gray-100 divide-y divide-gray-100">
          {group.lines.map((line) => (
            <WhitespaceLineRow
              key={line.id}
              line={line}
              token={token}
              onSaved={() => onLineSaved(line.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function WhitespaceLineRow({
  line,
  token,
  onSaved,
}: {
  line: WhitespaceLine
  token: string
  onSaved: () => void
}) {
  const [locationsValue, setLocationsValue] = useState('')
  const [saveSuccess, setSaveSuccess] = useState(false)

  const save = useMutation({
    mutationFn: () =>
      repApi.patch(`/rep/whitespace/${line.id}`, {
        token,
        totalLocationsFit: Number(locationsValue),
      }),
    onSuccess: () => {
      setSaveSuccess(true)
      setTimeout(() => onSaved(), 600)
    },
  })

  const displayName = line.productCoverageName ?? line.name

  return (
    <div className="px-5 py-3 flex items-center gap-4 flex-wrap text-sm">
      {/* Product name */}
      <div className="flex-1 min-w-0">
        <span className="font-medium text-gray-800 truncate block">{displayName}</span>
      </div>

      {/* Current Status badge */}
      <span className={clsx('shrink-0 text-xs font-medium px-2 py-0.5 rounded-full', wsStatusBadgeClass(line.currentStatus))}>
        {line.currentStatus ?? '—'}
      </span>

      {/* Current Locations Covered */}
      {line.currentLocationsCovered != null && (
        <div className="shrink-0 text-xs text-gray-500">
          <span className="text-gray-400">Covered: </span>
          <span className="font-medium text-gray-700">{line.currentLocationsCovered}</span>
        </div>
      )}

      {/* Total Locations Fit input + Save */}
      <div className="shrink-0 flex items-center gap-2">
        <input
          type="number"
          min={0}
          placeholder="Total locations"
          value={locationsValue}
          onChange={(e) => setLocationsValue(e.target.value)}
          className="w-32 text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-center focus:outline-none focus:ring-2 focus:ring-brand-300 focus:border-brand-400"
          disabled={save.isPending || saveSuccess}
        />
        <button
          onClick={() => save.mutate()}
          disabled={!locationsValue || save.isPending || saveSuccess}
          className={clsx(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40',
            saveSuccess
              ? 'bg-green-100 text-green-700'
              : 'bg-brand-500 text-white hover:bg-brand-600 disabled:cursor-not-allowed',
          )}
        >
          {save.isPending ? (
            <RefreshCw size={11} className="animate-spin" />
          ) : saveSuccess ? (
            <Check size={11} />
          ) : (
            <Save size={11} />
          )}
          {saveSuccess ? 'Saved!' : 'Save'}
        </button>
      </div>

      {save.isError && (
        <p className="w-full text-xs text-red-600 mt-1">Save failed — try again.</p>
      )}
    </div>
  )
}

// ── Error screen ──────────────────────────────────────────────────────────────

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-6">
      <div className="bg-white rounded-2xl border border-gray-200 p-8 max-w-sm text-center">
        <AlertCircle size={28} className="mx-auto text-red-400 mb-3" />
        <p className="text-sm text-gray-700">{message}</p>
      </div>
    </div>
  )
}
