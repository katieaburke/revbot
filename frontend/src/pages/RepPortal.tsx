import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { ExternalLink, Clock, CheckCircle, AlertCircle, ChevronDown, BellOff } from 'lucide-react'
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

interface RepData {
  rep: { name: string; email: string | null }
  notifications: RepNotification[]
}

// ── Alert type display ────────────────────────────────────────────────────────

const ALERT_META: Record<string, { label: string; color: string; what: string }> = {
  PAST_DUE_INITIAL:    { label: 'Past Due',         color: 'bg-red-100 text-red-700',      what: 'Close date has passed — update the date or close the deal.' },
  PAST_DUE_AMENDMENT:  { label: 'Past Due Amendment',color: 'bg-red-100 text-red-700',      what: 'Amendment close date has passed — update or close.' },
  PAST_DUE_RENEWAL:    { label: 'Past Due Renewal',  color: 'bg-red-100 text-red-700',      what: 'Renewal booking date has passed — close this in Salesforce.' },
  STALLED:             { label: 'Zombie Pipeline',     color: 'bg-orange-100 text-orange-700', what: "This deal hasn't had activity in a while. If it's a longer sales cycle, snooze this and we'll check back in — otherwise update the stage, close date, or log activity in Salesforce." },
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

// ── Component ─────────────────────────────────────────────────────────────────

export function RepPortal() {
  const token = new URLSearchParams(window.location.search).get('token') ?? ''
  const qc = useQueryClient()
  const [snoozing, setSnoozing] = useState<string | null>(null) // notif id being snoozed

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
          </div>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-6 py-6 space-y-3">
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
            isPending={snoozeMutation.isPending}
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
                isPending={snoozeMutation.isPending}
              />
            ))}
          </div>
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

// ── Notification card ─────────────────────────────────────────────────────────

function NotifCard({
  notif,
  snoozed = false,
  snoozingId,
  onSnoozeOpen,
  onSnoozeClose,
  onSnooze,
  isPending,
}: {
  notif: RepNotification
  snoozed?: boolean
  snoozingId: string | null
  onSnoozeOpen: () => void
  onSnoozeClose: () => void
  onSnooze: (days?: number, snoozeUntil?: string) => void
  isPending: boolean
}) {
  const [customDate, setCustomDate] = useState('')
  const meta = ALERT_META[notif.alertType] ?? { label: notif.alertType, color: 'bg-gray-100 text-gray-600', what: '' }
  const isSnoozeOpen = snoozingId === notif.id

  // Check for future next step date on STALLED alerts
  const nextStepDate = notif.alertType === 'STALLED'
    ? (notif.alertDetails.nextStepDate as string | null | undefined) ?? null
    : null
  const nextStepFuture = nextStepDate && new Date(nextStepDate) > new Date() ? new Date(nextStepDate) : null

  return (
    // No overflow-hidden — needed so the snooze dropdown isn't clipped
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
          const nextStep = typeof d.nextStep === 'string' ? d.nextStep : null
          return (
            <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2.5">
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
                  <span className="font-medium text-gray-700">Next step</span>{' '}
                  {fmtDate(nextStepDate)}
                  {nextStep && (
                    <span className="text-gray-400 ml-1">· {nextStep.slice(0, 60)}{nextStep.length > 60 ? '…' : ''}</span>
                  )}
                </span>
              )}
            </div>
          )
        })()}

        {/* What to do */}
        <p className="text-sm text-gray-600 mb-3">{meta.what}</p>

        {/* Actions */}
        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={notif.sfdcUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-brand-500 text-white rounded-lg hover:bg-brand-600"
          >
            Open in Salesforce <ExternalLink size={11} />
          </a>

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
                        disabled={isPending}
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
                        disabled={isPending}
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
                        disabled={!customDate || isPending}
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
      </div>
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
