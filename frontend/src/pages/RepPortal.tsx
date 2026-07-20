import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { ExternalLink, Clock, CheckCircle, AlertCircle, ChevronDown, BellOff, Check, RefreshCw, ChevronUp, Save } from 'lucide-react'
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
  rep: { name: string; email: string | null; repRole: string | null }
  notifications: RepNotification[]
  pending: PendingFlag[]
}

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

type PortalTab = 'pipeline' | 'whitespace'

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

  const [wsRemovedIds, setWsRemovedIds] = useState<Set<string>>(new Set())

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

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
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

      {/* Tab bar */}
      <div className="bg-white border-b border-gray-200 px-6">
        <div className="max-w-2xl mx-auto flex gap-0">
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
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-6 py-6 space-y-3">

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
