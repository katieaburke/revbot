import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { api } from '../lib/api'
import { RefreshCw, Send, ChevronDown, ChevronUp, Users, AlertCircle } from 'lucide-react'
import clsx from 'clsx'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReassignAccount {
  id: string
  name: string
  ownerName: string
  ownerEmail: string | null
  ownerRole: string | null
  billingCountry: string | null
  secondaryOwnerName: string | null
}

interface RoutedAccount {
  account: ReassignAccount
  leaderKey: string
  leaderName: string
  leaderEmail: string
  suggestAna: boolean
  routeReason: string
}

interface UnroutedAccount {
  account: ReassignAccount
  reason: string
}

interface ReassignmentPreview {
  routedByLeader: Record<string, RoutedAccount[]>
  unrouted: UnroutedAccount[]
  total: number
  fetchedAt: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const LEADER_COLORS: Record<string, string> = {
  allison: 'bg-blue-50 text-blue-700 border-blue-200',
  jo: 'bg-violet-50 text-violet-700 border-violet-200',
  karolina: 'bg-pink-50 text-pink-700 border-pink-200',
  samy: 'bg-amber-50 text-amber-700 border-amber-200',
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TerritoryReassignment() {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [sent, setSent] = useState(false)
  const [sendResult, setSendResult] = useState<{ sent: string[]; failed: string[] } | null>(null)

  const { data: preview, isLoading, error, refetch, isFetching } = useQuery<ReassignmentPreview>({
    queryKey: ['territory-reassignment-preview'],
    queryFn: () => api.get('/territory/reassignment/preview').then((r) => r.data),
    staleTime: 5 * 60_000,
  })

  const sendMutation = useMutation({
    mutationFn: () => api.post('/territory/reassignment/send', { preview }).then((r) => r.data),
    onSuccess: (data) => {
      setSent(true)
      setSendResult(data)
    },
  })

  const totalRouted = preview
    ? Object.values(preview.routedByLeader).reduce((s, a) => s + a.length, 0)
    : 0

  function toggleLeader(key: string) {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <div className="p-8 max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">Customers to Reassign</h2>
          <p className="text-sm text-gray-500 mt-1">
            Customer accounts still owned by New Business reps — route to the right CS leader via Slack
          </p>
          {preview && (
            <p className="text-xs text-gray-400 mt-1">
              Last fetched: {fmt(preview.fetchedAt)} · {preview.total} accounts found
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setSent(false); setSendResult(null); refetch() }}
            disabled={isFetching}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            onClick={() => sendMutation.mutate()}
            disabled={!preview || totalRouted === 0 || sendMutation.isPending || sent}
            className={clsx(
              'flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors',
              sent
                ? 'bg-green-50 text-green-700 border border-green-200 cursor-default'
                : 'bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-50'
            )}
          >
            <Send size={14} />
            {sendMutation.isPending ? 'Sending…' : sent ? 'Sent ✓' : `Send Slack messages (${totalRouted})`}
          </button>
        </div>
      </div>

      {/* Send result banner */}
      {sendResult && (
        <div className={clsx(
          'mb-6 px-4 py-3 rounded-lg text-sm border',
          sendResult.failed.length === 0
            ? 'bg-green-50 text-green-800 border-green-200'
            : 'bg-amber-50 text-amber-800 border-amber-200'
        )}>
          {sendResult.sent.length > 0 && <span>✓ Sent to: {sendResult.sent.join(', ')}. </span>}
          {sendResult.failed.length > 0 && <span>⚠️ Failed: {sendResult.failed.join(', ')}</span>}
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-sm text-gray-400">
          Loading accounts from Salesforce…
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 flex items-start gap-3">
          <AlertCircle size={16} className="text-red-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-800">Failed to load accounts</p>
            <p className="text-xs text-red-600 mt-1">{(error as Error).message}</p>
          </div>
        </div>
      )}

      {/* Leader groups */}
      {preview && (
        <div className="space-y-4">
          {Object.entries(preview.routedByLeader).map(([leaderKey, accounts]) => {
            const isOpen = expanded[leaderKey] !== false // default open
            const anaGroup = accounts.filter((a) => a.suggestAna)
            const teamGroup = accounts.filter((a) => !a.suggestAna)

            return (
              <div key={leaderKey} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                {/* Leader header */}
                <button
                  onClick={() => toggleLeader(leaderKey)}
                  className="w-full flex items-center gap-3 px-5 py-4 hover:bg-gray-50 transition-colors"
                >
                  <span className={clsx(
                    'inline-flex px-2.5 py-1 rounded-full text-xs font-semibold border',
                    LEADER_COLORS[leaderKey] ?? 'bg-gray-100 text-gray-600 border-gray-200'
                  )}>
                    {accounts[0]?.leaderName ?? leaderKey}
                  </span>
                  <span className="text-sm text-gray-500">{accounts[0]?.leaderEmail}</span>
                  <span className="ml-auto text-sm font-medium text-gray-700">{accounts.length} accounts</span>
                  {isOpen ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
                </button>

                {isOpen && (
                  <div className="border-t border-gray-100">
                    {/* Ana group */}
                    {anaGroup.length > 0 && (
                      <div>
                        <div className="px-5 py-2 bg-orange-50 border-b border-orange-100">
                          <p className="text-xs font-semibold text-orange-700 uppercase tracking-wide">
                            🇪🇸 Suggest assigning to Ana Hernández ({anaGroup.length})
                          </p>
                        </div>
                        <AccountTable accounts={anaGroup} />
                      </div>
                    )}

                    {/* Team group */}
                    {teamGroup.length > 0 && (
                      <div>
                        {anaGroup.length > 0 && (
                          <div className="px-5 py-2 bg-gray-50 border-b border-gray-100">
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                              🌍 Assign to your team ({teamGroup.length})
                            </p>
                          </div>
                        )}
                        <AccountTable accounts={teamGroup} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {/* Unrouted */}
          {preview.unrouted.length > 0 && (
            <div className="bg-white rounded-xl border border-amber-200 overflow-hidden">
              <button
                onClick={() => toggleLeader('__unrouted')}
                className="w-full flex items-center gap-3 px-5 py-4 hover:bg-amber-50 transition-colors"
              >
                <AlertCircle size={14} className="text-amber-500" />
                <span className="text-sm font-medium text-amber-700">Unrouted accounts</span>
                <span className="ml-auto text-sm font-medium text-amber-700">{preview.unrouted.length}</span>
                {expanded['__unrouted'] !== true
                  ? <ChevronDown size={14} className="text-amber-400" />
                  : <ChevronUp size={14} className="text-amber-400" />
                }
              </button>
              {expanded['__unrouted'] && (
                <div className="border-t border-amber-100">
                  <table className="w-full text-sm">
                    <thead className="bg-amber-50">
                      <tr>
                        <th className="text-left px-5 py-2 text-xs font-medium text-amber-600 uppercase">Account</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-amber-600 uppercase">Owner</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-amber-600 uppercase">Country</th>
                        <th className="text-left px-4 py-2 text-xs font-medium text-amber-600 uppercase">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-amber-50">
                      {preview.unrouted.map(({ account, reason }) => (
                        <tr key={account.id} className="hover:bg-amber-50/50">
                          <td className="px-5 py-2.5 font-medium text-gray-900">{account.name}</td>
                          <td className="px-4 py-2.5 text-gray-600">{account.ownerName}</td>
                          <td className="px-4 py-2.5 text-gray-500">{account.billingCountry ?? '—'}</td>
                          <td className="px-4 py-2.5 text-amber-700 text-xs">{reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Empty state */}
          {totalRouted === 0 && preview.unrouted.length === 0 && (
            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
              <Users size={32} className="mx-auto text-gray-300 mb-3" />
              <p className="text-sm text-gray-500">No accounts need reassignment right now.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Account table ─────────────────────────────────────────────────────────────

function AccountTable({ accounts }: { accounts: RoutedAccount[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-gray-50/60">
        <tr>
          <th className="text-left px-5 py-2 text-xs font-medium text-gray-400 uppercase">Account</th>
          <th className="text-left px-4 py-2 text-xs font-medium text-gray-400 uppercase">Current Owner</th>
          <th className="text-left px-4 py-2 text-xs font-medium text-gray-400 uppercase">Country</th>
          <th className="text-left px-4 py-2 text-xs font-medium text-gray-400 uppercase">Route Reason</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-50">
        {accounts.map(({ account, routeReason }) => (
          <tr key={account.id} className="hover:bg-gray-50">
            <td className="px-5 py-2.5 font-medium text-gray-900">{account.name}</td>
            <td className="px-4 py-2.5 text-gray-600">
              {account.ownerName.includes('#')
                ? <span className="text-gray-400 italic">{account.ownerName} (inactive)</span>
                : account.ownerName
              }
            </td>
            <td className="px-4 py-2.5 text-gray-500">{account.billingCountry ?? '—'}</td>
            <td className="px-4 py-2.5 text-gray-400 text-xs">{routeReason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
