import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { Send } from 'lucide-react'
import clsx from 'clsx'

interface Notification {
  id: string
  opportunityId: string
  opportunityName: string
  alertType: string
  alertDetails: Record<string, unknown>
  status: string
  sentAt: string
  snoozedUntil?: string
  owner: { slackName: string; slackEmail: string; slackUserId: string }
}

const statusColors: Record<string, string> = {
  SENT: 'bg-red-100 text-red-700',
  SNOOZED: 'bg-yellow-100 text-yellow-700',
  RESOLVED: 'bg-green-100 text-green-700',
  DISMISSED: 'bg-gray-100 text-gray-600',
}

const alertTypeLabel: Record<string, string> = {
  PAST_DUE_INITIAL: 'Past Due',
  PAST_DUE_AMENDMENT: 'Past Due (Amendment)',
  PAST_DUE_RENEWAL: 'Past Due (Renewal)',
  STALLED: 'Stalled',
  MEDDPICC_MISSING: 'Missing MEDDPICC',
}

export function Notifications() {
  const [statusFilter, setStatusFilter] = useState('')
  const [nudgeTarget, setNudgeTarget] = useState<Notification | null>(null)
  const [nudgeMessage, setNudgeMessage] = useState('')
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['notifications', statusFilter],
    queryFn: () =>
      api.get('/notifications', { params: { status: statusFilter || undefined } }).then((r) => r.data),
  })

  const nudge = useMutation({
    mutationFn: (n: Notification) =>
      api.post('/notifications/nudge', {
        opportunityId: n.opportunityId,
        opportunityName: n.opportunityName,
        targetUserSlackId: n.owner.slackUserId,
        alertType: n.alertType,
        customMessage: nudgeMessage || undefined,
        ...n.alertDetails,
      }),
    onSuccess: () => {
      setNudgeTarget(null)
      setNudgeMessage('')
      qc.invalidateQueries({ queryKey: ['notifications'] })
    },
  })

  const notifications: Notification[] = data?.notifications ?? []

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-semibold text-gray-900">Notifications</h2>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
        >
          <option value="">All statuses</option>
          <option value="SENT">Pending</option>
          <option value="SNOOZED">Snoozed</option>
          <option value="RESOLVED">Resolved</option>
        </select>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {isLoading ? (
          <div className="px-6 py-8 text-sm text-gray-400">Loading...</div>
        ) : notifications.length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-gray-400">No notifications found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Opportunity</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Type</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Owner</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Sent</th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {notifications.map((n) => (
                <tr key={n.id} className="hover:bg-gray-50">
                  <td className="px-6 py-3 font-medium text-gray-900">{n.opportunityName}</td>
                  <td className="px-6 py-3 text-gray-600">{alertTypeLabel[n.alertType] ?? n.alertType}</td>
                  <td className="px-6 py-3 text-gray-600">{n.owner.slackName ?? n.owner.slackEmail}</td>
                  <td className="px-6 py-3">
                    <span className={clsx('px-2 py-0.5 rounded-full text-xs font-medium', statusColors[n.status] ?? 'bg-gray-100 text-gray-600')}>
                      {n.status.toLowerCase()}
                      {n.status === 'SNOOZED' && n.snoozedUntil && (
                        <> until {new Date(n.snoozedUntil).toLocaleDateString()}</>
                      )}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-gray-400">{new Date(n.sentAt).toLocaleDateString()}</td>
                  <td className="px-6 py-3">
                    {n.status !== 'RESOLVED' && (
                      <button
                        onClick={() => setNudgeTarget(n)}
                        className="flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-700 font-medium"
                      >
                        <Send size={12} /> Nudge
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Nudge modal */}
      {nudgeTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h3 className="font-semibold text-gray-900 mb-1">Nudge opportunity owner</h3>
            <p className="text-sm text-gray-500 mb-4">
              Sending a follow-up Slack message to{' '}
              <strong>{nudgeTarget.owner.slackName ?? nudgeTarget.owner.slackEmail}</strong> about{' '}
              <strong>{nudgeTarget.opportunityName}</strong>.
            </p>
            <textarea
              value={nudgeMessage}
              onChange={(e) => setNudgeMessage(e.target.value)}
              placeholder="Optional custom note to include (e.g. 'This is blocking our forecast — please update today')"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none h-24 mb-4"
            />
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setNudgeTarget(null)}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
              >
                Cancel
              </button>
              <button
                onClick={() => nudge.mutate(nudgeTarget)}
                disabled={nudge.isPending}
                className="px-4 py-2 bg-brand-500 text-white text-sm font-medium rounded-lg hover:bg-brand-600 disabled:opacity-50"
              >
                {nudge.isPending ? 'Sending...' : 'Send nudge'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
