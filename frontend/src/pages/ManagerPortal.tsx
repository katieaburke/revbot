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
  manager: { name: string; email: string | null; roleName: string | null }
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

// ── Opp-level card — one per opportunity, all flags grouped together ──────────

interface OppGroup {
  opportunityId: string
  opportunityName: string
  sfdcUrl: string
  alertDetails: Record<string, unknown>
  totalFlagsForOpp: number
  flags: ManagerNotification[]
  pendingFlags: PendingFlag[]
}

function FlagRow({
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
  const isSnoozed = notif.status === 'SNOOZED'

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className={clsx('inline-flex flex-shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold', meta.color)}>
        {meta.label}
      </span>
      {isSnoozed && notif.snoozedUntil ? (
        <span className="text-xs text-gray-400 flex items-center gap-1">
          <Clock size={10} /> snoozed until {fmtDate(notif.snoozedUntil)}
        </span>
      ) : (
        <div className="relative">
          <button
            onClick={() => setSnoozeOpen((v) => !v)}
            className="flex items-center gap-1 px-2 py-0.5 text-xs text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"
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
        <span className="text-xs text-gray-300">· sent {fmtDate(notif.sentAt)}</span>
      )}
    </div>
  )
}

function OppCard({
  group,
  repSlackUserId,
  token,
}: {
  group: OppGroup
  repSlackUserId: string
  token: string
}) {
  const d = group.alertDetails
  const amount = d.amount != null ? Number(d.amount) : null
  const closeDate = typeof d.closeDate === 'string' ? d.closeDate : null
  const stage = typeof d.stage === 'string' ? d.stage : null
  const nextStep = typeof d.nextStep === 'string' && d.nextStep.trim() ? d.nextStep.trim() : null
  const nextStepDate = typeof d.nextStepDate === 'string' ? d.nextStepDate : null
  const allSnoozed = group.flags.every((f) => f.status === 'SNOOZED')

  return (
    <div className={clsx('bg-gray-50 rounded-lg border px-4 py-3', allSnoozed ? 'border-gray-100 opacity-70' : 'border-gray-200')}>
      {/* Opp header */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <a
          href={group.sfdcUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-gray-800 text-sm hover:text-blue-600 flex items-center gap-1"
        >
          {group.opportunityName}
          <ExternalLink size={10} className="flex-shrink-0 text-gray-400" />
        </a>
        {group.totalFlagsForOpp > 1 && (
          <span
            className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-50 text-orange-500"
            title={`This opportunity has been flagged ${group.totalFlagsForOpp} times total`}
          >
            flagged {group.totalFlagsForOpp}×
          </span>
        )}
      </div>

      {/* Deal metadata */}
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 mb-1.5">
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
        <p className="text-xs text-gray-500 mb-2">
          <span className="font-medium text-gray-700">Next step</span>{' '}
          {nextStep}
        </p>
      )}

      {/* Active + snoozed flags */}
      {group.flags.length > 0 && (
        <div className="space-y-1.5 mt-2 pt-2 border-t border-gray-100">
          {group.flags.map((notif) => (
            <FlagRow key={notif.id} notif={notif} repSlackUserId={repSlackUserId} token={token} />
          ))}
        </div>
      )}

      {/* Pending (queued) flags for this same opp */}
      {group.pendingFlags.length > 0 && (
        <div className="space-y-1 mt-2 pt-2 border-t border-dashed border-blue-100">
          <p className="text-[10px] font-semibold text-blue-400 uppercase tracking-wider mb-1">Queued — not yet sent</p>
          {group.pendingFlags.map((flag) => {
            const meta = ALERT_META[flag.alertType] ?? { label: flag.alertType, color: 'bg-gray-100 text-gray-600' }
            return (
              <div key={flag.alertType} className="flex items-center gap-2">
                <span className={clsx('inline-flex flex-shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold opacity-75', meta.color)}>
                  {meta.label}
                </span>
                <span className="text-xs text-blue-400">queued</span>
              </div>
            )
          })}
        </div>
      )}
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

  // Group notifications by opportunityId — one card per opp, all flags together
  const SFDC_BASE = 'https://uberall.lightning.force.com'
  const oppGroupMap = new Map<string, OppGroup>()

  for (const notif of rep.notifications) {
    const existing = oppGroupMap.get(notif.opportunityId)
    if (existing) {
      existing.flags.push(notif)
    } else {
      oppGroupMap.set(notif.opportunityId, {
        opportunityId: notif.opportunityId,
        opportunityName: notif.opportunityName,
        sfdcUrl: notif.sfdcUrl,
        alertDetails: notif.alertDetails,
        totalFlagsForOpp: notif.totalFlagsForOpp,
        flags: [notif],
        pendingFlags: [],
      })
    }
  }

  // Merge pending flags into existing opp groups, or create new opp-only groups
  for (const flag of (rep.pending ?? [])) {
    const existing = oppGroupMap.get(flag.opportunityId)
    if (existing) {
      existing.pendingFlags.push(flag)
    } else {
      const sfdcUrl = `${SFDC_BASE}/lightning/r/Opportunity/${flag.opportunityId}/view`
      oppGroupMap.set(flag.opportunityId, {
        opportunityId: flag.opportunityId,
        opportunityName: flag.opportunityName,
        sfdcUrl,
        alertDetails: flag.details ?? {},
        totalFlagsForOpp: 0,
        flags: [],
        pendingFlags: [flag],
      })
    }
  }

  // Active groups first (any flag is SENT), then all-snoozed, then pending-only
  const activeGroups = [...oppGroupMap.values()].filter((g) => g.flags.some((f) => f.status === 'SENT'))
  const snoozedGroups = [...oppGroupMap.values()].filter((g) => g.flags.length > 0 && g.flags.every((f) => f.status === 'SNOOZED'))
  const pendingOnlyGroups = [...oppGroupMap.values()].filter((g) => g.flags.length === 0 && g.pendingFlags.length > 0)

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
          {activeGroups.map((group) => (
            <OppCard key={group.opportunityId} group={group} repSlackUserId={rep.slackUserId} token={token} />
          ))}

          {snoozedGroups.length > 0 && (
            <>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider pt-1">Snoozed</p>
              {snoozedGroups.map((group) => (
                <OppCard key={group.opportunityId} group={group} repSlackUserId={rep.slackUserId} token={token} />
              ))}
            </>
          )}

          {pendingOnlyGroups.length > 0 && (
            <>
              <p className="text-[10px] font-semibold text-blue-400 uppercase tracking-wider pt-1">Queued — not yet sent</p>
              {pendingOnlyGroups.map((group) => (
                <OppCard key={group.opportunityId} group={group} repSlackUserId={rep.slackUserId} token={token} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Whitespace tab types ──────────────────────────────────────────────────────

interface WsLine {
  id: string
  productCoverageName: string | null
  currentLocationsCovered: number | null
  currentArr: number
  priority: string | null
}

interface WsAccount {
  accountId: string
  accountName: string
  contractEndDate: string | null
  totalCurrentArr: number
  lines: WsLine[]
}

interface WsRep {
  ownerEmail: string
  ownerName: string
  totalLines: number
  totalCurrentArr: number
  accounts: WsAccount[]
}

interface WsData {
  hasAccess: boolean
  reps: WsRep[]
}

// ── Whitespace tab components ─────────────────────────────────────────────────

function fmtEur(val: number) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(val)
}

function WsRepCard({ rep }: { rep: WsRep }) {
  const [expanded, setExpanded] = useState(false)
  const [openAccountIds, setOpenAccountIds] = useState<Set<string>>(new Set())

  function toggleAccount(id: string) {
    setOpenAccountIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
      >
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-gray-900 text-sm">{rep.ownerName}</span>
          <span className="ml-2 text-xs text-gray-500">
            {rep.accounts.length} account{rep.accounts.length !== 1 ? 's' : ''} · {rep.totalLines} line{rep.totalLines !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="text-sm font-semibold text-gray-700">{fmtEur(rep.totalCurrentArr)}</span>
          <ChevronDown size={14} className={clsx('text-gray-400 transition-transform', expanded && 'rotate-180')} />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 px-5 py-4 space-y-2">
          {rep.accounts.map((acct) => {
            const open = openAccountIds.has(acct.accountId)
            return (
              <div key={acct.accountId} className="border border-gray-100 rounded-lg overflow-hidden">
                <button
                  onClick={() => toggleAccount(acct.accountId)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 text-left"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium text-gray-800 truncate">{acct.accountName}</span>
                    <span className="shrink-0 text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
                      {acct.lines.length} line{acct.lines.length !== 1 ? 's' : ''}
                    </span>
                    {acct.contractEndDate && (
                      <span className="shrink-0 text-xs text-gray-400">
                        ends {new Date(acct.contractEndDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-xs font-semibold text-gray-700">{fmtEur(acct.totalCurrentArr)}</span>
                    <ChevronDown size={13} className={clsx('text-gray-400 transition-transform', open && 'rotate-180')} />
                  </div>
                </button>

                {open && (
                  <div className="border-t border-gray-100 divide-y divide-gray-100">
                    {acct.lines.map((line) => (
                      <div key={line.id} className="px-5 py-3 flex items-center gap-3 flex-wrap text-sm bg-gray-50/50">
                        <div className="flex-1 min-w-0">
                          <span className="font-medium text-gray-800 truncate block">{line.productCoverageName ?? '—'}</span>
                        </div>
                        {line.priority && (
                          <span className={clsx(
                            'shrink-0 text-xs font-medium px-2 py-0.5 rounded-full',
                            line.priority === 'High' ? 'bg-red-100 text-red-700' : line.priority === 'Medium' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'
                          )}>
                            {line.priority}
                          </span>
                        )}
                        <div className="shrink-0 text-xs text-gray-500 w-24 text-right">
                          <span className="text-gray-400">Covered: </span>
                          <span className="font-medium text-gray-700">{line.currentLocationsCovered ?? '—'}</span>
                        </div>
                        <div className="shrink-0 text-xs w-28 text-right">
                          <span className="text-gray-400">Curr ARR: </span>
                          <span className="font-semibold text-gray-800">{fmtEur(line.currentArr)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ManagerPortal() {
  const token = new URLSearchParams(window.location.search).get('token') ?? ''
  const qc = useQueryClient()
  const [activeTab, setActiveTab] = useState<'pipeline' | 'whitespace'>('pipeline')

  const { data, isLoading, error } = useQuery<ManagerData>({
    queryKey: ['manager-portal', token],
    queryFn: () => managerApi.get(`/manager/me?token=${token}`).then((r) => r.data),
    enabled: !!token,
    retry: false,
  })

  const { data: wsData, isFetching: wsFetching } = useQuery<WsData>({
    queryKey: ['manager-whitespace', token],
    queryFn: () => managerApi.get(`/manager/whitespace?token=${token}`).then((r) => r.data),
    enabled: !!token && activeTab === 'whitespace',
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
  const showWhitespaceTab = data!.manager.roleName?.toLowerCase().includes('existing business') ?? false

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between">
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

          {/* Tab bar */}
          {showWhitespaceTab && (
            <div className="flex gap-1 mt-4">
              <button
                onClick={() => setActiveTab('pipeline')}
                className={clsx(
                  'px-4 py-1.5 rounded-full text-sm font-medium transition-colors',
                  activeTab === 'pipeline'
                    ? 'bg-gray-900 text-white'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                )}
              >
                Pipeline
              </button>
              <button
                onClick={() => setActiveTab('whitespace')}
                className={clsx(
                  'px-4 py-1.5 rounded-full text-sm font-medium transition-colors',
                  activeTab === 'whitespace'
                    ? 'bg-gray-900 text-white'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                )}
              >
                Whitespace
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-6 space-y-3">
        {activeTab === 'pipeline' && (
          <>
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
          </>
        )}

        {activeTab === 'whitespace' && (
          <>
            {wsFetching && (
              <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
                <p className="text-sm text-gray-400">Loading whitespace data…</p>
              </div>
            )}

            {!wsFetching && wsData?.hasAccess === false && (
              <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
                <p className="text-sm font-medium text-gray-700">Whitespace data is available for Existing Business managers</p>
                <p className="text-xs text-gray-400 mt-1">Your role doesn't currently have access to this view.</p>
              </div>
            )}

            {!wsFetching && wsData?.hasAccess === true && wsData.reps.length === 0 && (
              <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
                <p className="text-sm font-medium text-gray-700">No whitespace data found</p>
                <p className="text-xs text-gray-400 mt-1">All expansion potential lines for your team have Total Locations Fit filled in.</p>
              </div>
            )}

            {!wsFetching && wsData?.hasAccess === true && wsData.reps.length > 0 && (
              <>
                <p className="text-xs text-gray-400 px-1">
                  {wsData.reps.length} rep{wsData.reps.length !== 1 ? 's' : ''} with missing location fit data
                </p>
                {wsData.reps.map((rep) => (
                  <WsRepCard key={rep.ownerEmail} rep={rep} />
                ))}
              </>
            )}
          </>
        )}

        <p className="text-center text-xs text-gray-300 pt-4">Powered by Beacon · RevOps</p>
      </div>
    </div>
  )
}
