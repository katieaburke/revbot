import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import {
  ChevronDown,
  ExternalLink,
  Clock,
  BellOff,
  Send,
  Copy,
  Check,
  AlertCircle,
  Users,
} from 'lucide-react'
import clsx from 'clsx'

// Plain axios instance — no admin auth interceptors
const managerApi = axios.create({
  baseURL: import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api',
})

// ── Types ─────────────────────────────────────────────────────────────────────

interface ManagerNotification {
  id: string
  opportunityId: string
  opportunityName: string
  alertType: string
  alertDetails: Record<string, unknown>
  status: 'SENT' | 'SNOOZED'
  sentAt: string | null
  snoozedUntil: string | null
  sfdcUrl: string
  totalFlagsForOpp: number
}

interface PendingFlag {
  opportunityId: string
  opportunityName: string
  alertType: string
  ownerEmail: string
  details: Record<string, unknown>
}

interface RepSummary {
  name: string
  email: string
  slackUserId: string
  portalUrl: string | null
  openCount: number
  snoozedCount: number
  totalNotified: number
  pending: PendingFlag[]
  notifications: ManagerNotification[]
}

interface ManagerData {
  manager: { name: string; email: string | null }
  reps: RepSummary[]
}

// ── Alert meta ────────────────────────────────────────────────────────────────

const ALERT_META: Record<string, { label: string; color: string }> = {
  PAST_DUE_INITIAL:    { label: 'Past Due',           color: 'bg-red-100 text-red-700' },
  PAST_DUE_AMENDMENT:  { label: 'Past Due Amendment', color: 'bg-red-100 text-red-700' },
  PAST_DUE_RENEWAL:    { label: 'Past Due Renewal',   color: 'bg-red-100 text-red-700' },
  STALLED:             { label: 'Zombie Pipeline',     color: 'bg-orange-100 text-orange-700' },
  MEDDPICC_MISSING:    { label: 'Missing MEDDPICC',   color: 'bg-purple-100 text-purple-700' },
  NEXT_STEP_MISSING:   { label: 'Missing Next Step',  color: 'bg-yellow-100 text-yellow-700' },
  CLOSE_DATE_RISK:     { label: 'Close Date Risk',    color: 'bg-amber-100 text-amber-700' },
  STAGE_MISMATCH:      { label: 'Stage Mismatch',     color: 'bg-blue-100 text-blue-700' },
  STALE_PROSPECTING:   { label: 'Stale Prospecting',  color: 'bg-gray-100 text-gray-700' },
}

const SNOOZE_OPTIONS = [
  { label: '3 days', days: 3 },
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
  { label: '1 month', days: 30 },
]

function addDays(d: Date, n: number) {
  const r = new Date(d); r.setDate(r.getDate() + n); return r
}

function fmtDate(iso: string | null) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
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

// ── Snooze dropdown (manager variant calling snooze-for-rep) ──────────────────

function SnoozeDropdown({
  notificationId,
  repSlackUserId,
  token,
  onClose,
}: {
  notificationId: string
  repSlackUserId: string
  token: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [customDate, setCustomDate] = useState('')

  const snoozeMutation = useMutation({
    mutationFn: ({ days, snoozeUntil }: { days?: number; snoozeUntil?: string }) =>
      managerApi.post('/manager/snooze-for-rep', {
        token,
        notificationId,
        repSlackUserId,
        days,
        snoozeUntil,
      }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['manager-portal', token] })
      onClose()
    },
  })

  return (
    <div className="absolute left-0 top-full mt-1 z-50 bg-white border border-gray-200 rounded-xl shadow-xl text-xs min-w-[200px]">
      <p className="px-3 pt-2.5 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Snooze until</p>

      {SNOOZE_OPTIONS.map((opt) => {
        const until = addDays(new Date(), opt.days)
        return (
          <button
            key={opt.days}
            onClick={() => snoozeMutation.mutate({ days: opt.days })}
            disabled={snoozeMutation.isPending}
            className="w-full text-left px-3 py-2 hover:bg-amber-50 hover:text-amber-800 disabled:opacity-50 text-gray-700 flex items-center justify-between"
          >
            <span>{opt.label}</span>
            <span className="text-gray-400">{until.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
          </button>
        )
      })}

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
            disabled={!customDate || snoozeMutation.isPending}
            onClick={() => snoozeMutation.mutate({ snoozeUntil: new Date(customDate + 'T12:00:00').toISOString() })}
            className="px-2.5 py-1.5 text-xs bg-amber-500 text-white rounded-lg disabled:opacity-40 hover:bg-amber-600 font-medium"
          >
            Set
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Compact notification card (inside rep expand) ─────────────────────────────

function ManagerNotifCard({
  notif,
  repSlackUserId,
  token,
}: {
  notif: ManagerNotification
  repSlackUserId: string
  token: string
}) {
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const meta = ALERT_META[notif.alertType] ?? { label: notif.alertType, color: 'bg-gray-100 text-gray-600' }
  const d = notif.alertDetails
  const amount = d.amount != null ? Number(d.amount) : null
  const closeDate = typeof d.closeDate === 'string' ? d.closeDate : null
  const stage = typeof d.stage === 'string' ? d.stage : null
  const nextStep = typeof d.nextStep === 'string' && d.nextStep.trim() ? d.nextStep.trim() : null
  const nextStepDate = typeof d.nextStepDate === 'string' ? d.nextStepDate : null
  const isSnoozed = notif.status === 'SNOOZED'
  const flagCount = notif.totalFlagsForOpp ?? 1

  return (
    <div className={clsx('bg-gray-50 rounded-lg border px-4 py-3', isSnoozed ? 'border-gray-100 opacity-70' : 'border-gray-200')}>
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className={clsx('inline-flex flex-shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold', meta.color)}>
            {meta.label}
          </span>
          <a
            href={notif.sfdcUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-gray-800 text-sm hover:text-blue-600 truncate flex items-center gap-1"
          >
            {notif.opportunityName}
            <ExternalLink size={10} className="flex-shrink-0 text-gray-300" />
          </a>
          {flagCount > 1 && (
            <span
              className="flex-shrink-0 inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-50 text-orange-500"
              title={`This opportunity has been flagged ${flagCount} times total`}
            >
              flagged {flagCount}×
            </span>
          )}
        </div>
        {isSnoozed && notif.snoozedUntil && (
          <span className="flex-shrink-0 text-xs text-gray-400 flex items-center gap-1">
            <Clock size={10} /> until {fmtDate(notif.snoozedUntil)}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-0.5 mb-2">
        {amount != null && (
          <span className="text-xs text-gray-500">
            <span className="font-medium text-gray-700">ACV</span>{' '}
            ${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })}
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
        <p className="text-xs text-gray-500 mb-2">
          <span className="font-medium text-gray-700">Next step</span>{' '}
          {nextStep}
        </p>
      )}

      <div className="flex items-center gap-2">
        <a
          href={notif.sfdcUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-white"
        >
          Open in Salesforce <ExternalLink size={10} />
        </a>

        {!isSnoozed && (
          <div className="relative">
            <button
              onClick={() => setSnoozeOpen((v) => !v)}
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-white"
            >
              <BellOff size={10} />
              Snooze
              <ChevronDown size={10} className={clsx('transition-transform', snoozeOpen && 'rotate-180')} />
            </button>
            {snoozeOpen && (
              <SnoozeDropdown
                notificationId={notif.id}
                repSlackUserId={repSlackUserId}
                token={token}
                onClose={() => setSnoozeOpen(false)}
              />
            )}
          </div>
        )}

        {notif.sentAt && (
          <span className="text-xs text-gray-300 ml-auto">Sent {fmtDate(notif.sentAt)}</span>
        )}
      </div>
    </div>
  )
}

// ── Rep card ──────────────────────────────────────────────────────────────────

function RepCard({ rep, token }: { rep: RepSummary; token: string }) {
  const [expanded, setExpanded] = useState(false)
  const [sendDone, setSendDone] = useState(false)
  const [copyDone, setCopyDone] = useState(false)

  const sendLinkMutation = useMutation({
    mutationFn: () =>
      managerApi.post('/manager/send-portal-link', { token, repSlackUserId: rep.slackUserId }).then((r) => r.data),
    onSuccess: () => {
      setSendDone(true)
      setTimeout(() => setSendDone(false), 3000)
    },
  })

  function handleCopy() {
    if (!rep.portalUrl) return
    navigator.clipboard.writeText(rep.portalUrl).then(() => {
      setCopyDone(true)
      setTimeout(() => setCopyDone(false), 3000)
    })
  }

  // Alert type breakdown for open notifications
  const typeCounts = rep.notifications
    .filter((n) => n.status === 'SENT')
    .reduce<Record<string, number>>((acc, n) => {
      acc[n.alertType] = (acc[n.alertType] ?? 0) + 1
      return acc
    }, {})

  const hasPending = rep.pending?.length > 0
  const hasFlags = rep.openCount > 0 || rep.snoozedCount > 0
  const hasExpandable = hasFlags || hasPending
  const openNotifs = rep.notifications.filter((n) => n.status === 'SENT')
  const snoozedNotifs = rep.notifications.filter((n) => n.status === 'SNOOZED')

  return (
    <div className={clsx('bg-white rounded-xl border', hasExpandable ? 'border-gray-200' : 'border-gray-100 opacity-60')}>
      <div className="px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          {/* Rep info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-gray-900 text-sm">{rep.name}</span>
              {rep.openCount > 0 && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">
                  {rep.openCount} open
                </span>
              )}
              {rep.snoozedCount > 0 && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-500">
                  {rep.snoozedCount} snoozed
                </span>
              )}
              {rep.totalNotified > 0 && (
                <span
                  className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-50 text-orange-600"
                  title="Unique opportunities RevBot has flagged for this rep (all time)"
                >
                  {rep.totalNotified} opp{rep.totalNotified !== 1 ? 's' : ''} flagged
                </span>
              )}
            </div>

            {hasFlags ? (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {Object.entries(typeCounts).map(([type, count]) => {
                  const meta = ALERT_META[type] ?? { label: type, color: 'bg-gray-100 text-gray-600' }
                  return (
                    <span key={type} className={clsx('inline-flex px-2 py-0.5 rounded-full text-xs font-medium', meta.color)}>
                      {meta.label} x{count}
                    </span>
                  )
                })}
                {hasPending && (
                  <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-600">
                    {rep.pending.length} queued
                  </span>
                )}
              </div>
            ) : hasPending ? (
              <div className="flex flex-wrap gap-1.5 mt-2">
                <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-600">
                  {rep.pending.length} queued (not yet sent)
                </span>
              </div>
            ) : (
              <p className="text-xs text-gray-400 mt-1">No active flags 🎉</p>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              onClick={() => sendLinkMutation.mutate()}
              disabled={sendLinkMutation.isPending || sendDone}
              title="Send portal link to rep via Slack"
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              {sendDone ? <Check size={11} className="text-green-500" /> : <Send size={11} />}
              {sendDone ? 'Sent!' : 'Send link'}
            </button>

            <button
              onClick={handleCopy}
              title="Copy rep portal link"
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50"
            >
              {copyDone ? <Check size={11} className="text-green-500" /> : <Copy size={11} />}
              {copyDone ? 'Copied!' : 'Copy link'}
            </button>

            {hasExpandable && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                <ChevronDown size={11} className={clsx('transition-transform', expanded && 'rotate-180')} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Expanded notifications */}
      {expanded && hasExpandable && (
        <div className="border-t border-gray-100 px-5 py-4 space-y-2">
          {openNotifs.map((notif) => (
            <ManagerNotifCard key={notif.id} notif={notif} repSlackUserId={rep.slackUserId} token={token} />
          ))}

          {snoozedNotifs.length > 0 && (
            <>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider pt-1">Snoozed</p>
              {snoozedNotifs.map((notif) => (
                <ManagerNotifCard key={notif.id} notif={notif} repSlackUserId={rep.slackUserId} token={token} />
              ))}
            </>
          )}

          {hasPending && (
            <>
              <p className="text-[10px] font-semibold text-blue-400 uppercase tracking-wider pt-2">
                Queued — not yet sent
              </p>
              {rep.pending.map((flag) => {
                const meta = ALERT_META[flag.alertType] ?? { label: flag.alertType, color: 'bg-gray-100 text-gray-600' }
                const d = flag.details ?? {}
                const amount = d.amount != null ? Number(d.amount) : null
                const closeDate = typeof d.closeDate === 'string' ? d.closeDate : null
                const stage = typeof d.stage === 'string' ? d.stage : null
                const sfdcUrl = `https://uberall.lightning.force.com/lightning/r/Opportunity/${flag.opportunityId}/view`
                return (
                  <div
                    key={`${flag.opportunityId}|${flag.alertType}`}
                    className="bg-blue-50/40 rounded-lg border border-blue-100 border-dashed px-4 py-3"
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className={clsx('inline-flex flex-shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold', meta.color)}>
                        {meta.label}
                      </span>
                      <a
                        href={sfdcUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-gray-800 text-sm hover:text-blue-600 truncate flex items-center gap-1"
                      >
                        {flag.opportunityName}
                        <ExternalLink size={10} className="flex-shrink-0 text-gray-300" />
                      </a>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                      {amount != null && (
                        <span className="text-xs text-gray-500">
                          <span className="font-medium text-gray-700">ACV</span>{' '}
                          ${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })}
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
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ManagerPortal() {
  const token = new URLSearchParams(window.location.search).get('token') ?? ''
  const qc = useQueryClient()

  const { data, isLoading, error } = useQuery<ManagerData>({
    queryKey: ['manager-portal', token],
    queryFn: () => managerApi.get(`/manager/me?token=${token}`).then((r) => r.data),
    enabled: !!token,
    retry: false,
  })

  // Keep qc in scope to avoid lint warning — invalidations happen inside child components
  void qc

  if (!token) {
    return <ErrorScreen message="No access link found. Ask your RevOps admin for a manager portal link." />
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-sm text-gray-400">Loading your team's flags…</p>
      </div>
    )
  }

  if (error) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = (error as any)?.response?.status
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg = (error as any)?.response?.data?.error
    if (status === 401) {
      return <ErrorScreen message="This link has expired or is invalid. Ask your RevOps admin to generate a fresh manager link from the Team tab." />
    }
    if (status === 404) {
      return <ErrorScreen message={msg ?? "Manager not found — make sure your RevOps team has you in the system."} />
    }
    return <ErrorScreen message={msg ?? "Something went wrong loading your team data. Please try again or contact RevOps."} />
  }

  const firstName = data!.manager.name.split(' ')[0]
  const totalOpen = data!.reps.reduce((sum, r) => sum + r.openCount, 0)

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Hi {firstName} 👋</h1>
            <p className="text-sm text-gray-500 mt-0.5">Your team's pipeline flags</p>
          </div>
          <div className="flex items-center gap-2">
            <Users size={15} className="text-gray-400" />
            <span className="text-sm text-gray-500">{data!.reps.length} reps</span>
            {totalOpen > 0 && (
              <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-700">
                {totalOpen} open flags
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-6 space-y-3">
        {data!.reps.length === 0 && (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
            <Users size={32} className="mx-auto text-gray-300 mb-3" />
            <p className="text-sm font-medium text-gray-700">No direct reports found</p>
            <p className="text-xs text-gray-400 mt-1">Make sure your Salesforce org has your team's reporting hierarchy set up.</p>
          </div>
        )}

        {data!.reps.map((rep) => (
          <RepCard key={rep.slackUserId} rep={rep} token={token} />
        ))}

        <p className="text-center text-xs text-gray-300 pt-4">Powered by Beacon · RevOps</p>
      </div>
    </div>
  )
}
