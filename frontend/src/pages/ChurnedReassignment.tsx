import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { RefreshCw, AlertCircle, CheckCircle, ChevronDown, ExternalLink } from 'lucide-react'
import clsx from 'clsx'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChurnedAccount {
  id: string
  name: string
  billingCountry: string | null
  industry: string | null
  numberOfLocations: number | null
  cancellationEffectiveDate: string | null
  cancellationNoticeDate: string | null
  primaryCancellationReason: string | null
  ownerName: string
  ownerEmail: string | null
  ownerRole: string | null
}

interface SalesRep {
  id: string
  name: string
  email: string
  role: string
  region: 'US-CAN' | 'EMEA' | 'Other'
}

interface ChurnedData {
  accounts: ChurnedAccount[]
  reps: SalesRep[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const REGION_COLORS: Record<string, string> = {
  'US-CAN': 'bg-blue-50 text-blue-700',
  'EMEA': 'bg-violet-50 text-violet-700',
  'Other': 'bg-gray-100 text-gray-600',
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ChurnedReassignment() {
  const qc = useQueryClient()
  // Map of accountId → selected repId
  const [selections, setSelections] = useState<Record<string, string>>({})
  // Map of accountId → 'success' | 'error' | 'loading'
  const [rowStatus, setRowStatus] = useState<Record<string, 'success' | 'error' | 'loading'>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})

  const { data, isLoading, error, refetch, isFetching } = useQuery<ChurnedData>({
    queryKey: ['churned-accounts'],
    queryFn: () => api.get('/territory/churned/accounts').then((r) => r.data),
    staleTime: 5 * 60_000,
  })

  const reassignMutation = useMutation({
    mutationFn: ({ account, rep }: { account: ChurnedAccount; rep: SalesRep }) =>
      api.post('/territory/churned/reassign', {
        accountId: account.id,
        newOwnerId: rep.id,
        newOwnerName: rep.name,
        newOwnerEmail: rep.email,
        account,
      }),
    onMutate: ({ account }) => {
      setRowStatus((s) => ({ ...s, [account.id]: 'loading' }))
    },
    onSuccess: (_, { account }) => {
      setRowStatus((s) => ({ ...s, [account.id]: 'success' }))
      // Remove from selections after success
      setSelections((s) => { const n = { ...s }; delete n[account.id]; return n })
    },
    onError: (err, { account }) => {
      setRowStatus((s) => ({ ...s, [account.id]: 'error' }))
      setRowErrors((s) => ({ ...s, [account.id]: (err as Error).message }))
    },
  })

  // Group reps by region for the select dropdown
  const repsByRegion = useMemo(() => {
    const groups: Record<string, SalesRep[]> = {}
    for (const rep of data?.reps ?? []) {
      if (!groups[rep.region]) groups[rep.region] = []
      groups[rep.region].push(rep)
    }
    return groups
  }, [data?.reps])

  // Accounts not yet successfully reassigned
  const pending = (data?.accounts ?? []).filter((a) => rowStatus[a.id] !== 'success')
  const doneCount = (data?.accounts ?? []).length - pending.length

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">Churned Accounts → Sales</h2>
          <p className="text-sm text-gray-500 mt-1">
            Accounts churned 6+ months ago still owned by CS/AM — reassign to a Sales rep for win-back
          </p>
          {data && (
            <p className="text-xs text-gray-400 mt-1">
              {data.accounts.length} accounts · {doneCount > 0 && `${doneCount} reassigned this session`}
            </p>
          )}
        </div>
        <button
          onClick={() => { setRowStatus({}); setSelections({}); setRowErrors({}); refetch() }}
          disabled={isFetching}
          className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-sm text-gray-400">
          Loading churned accounts from Salesforce…
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

      {/* Table */}
      {data && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase">Account</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Locations</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Industry</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Country</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Churned</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Reason</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Current Owner</th>
                <th className="px-4 py-3 text-xs font-medium text-gray-500 uppercase text-left min-w-[200px]">Assign to</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {data.accounts.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-5 py-10 text-center text-sm text-gray-400">
                    No churned accounts to reassign right now.
                  </td>
                </tr>
              )}
              {data.accounts.map((account) => {
                const status = rowStatus[account.id]
                const selectedRepId = selections[account.id] ?? ''
                const selectedRep = data.reps.find((r) => r.id === selectedRepId)

                return (
                  <tr
                    key={account.id}
                    className={clsx(
                      'hover:bg-gray-50 transition-colors',
                      status === 'success' && 'bg-green-50/60 opacity-60',
                    )}
                  >
                    {/* Account */}
                    <td className="px-5 py-3 font-medium text-gray-900 max-w-[200px]">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className="truncate" title={account.name}>{account.name}</span>
                        <a
                          href={`https://uberall.lightning.force.com/${account.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-shrink-0 text-gray-300 hover:text-brand-500 transition-colors"
                          title="Open in Salesforce"
                        >
                          <ExternalLink size={12} />
                        </a>
                      </span>
                    </td>

                    {/* Locations */}
                    <td className="px-4 py-3 text-gray-700 tabular-nums">
                      {account.numberOfLocations != null
                        ? account.numberOfLocations.toLocaleString()
                        : '—'}
                    </td>

                    {/* Industry */}
                    <td className="px-4 py-3 text-gray-600 max-w-[140px]">
                      <span className="block truncate text-xs" title={account.industry ?? ''}>{account.industry ?? '—'}</span>
                    </td>

                    {/* Country */}
                    <td className="px-4 py-3 text-gray-600 text-xs whitespace-nowrap">{account.billingCountry ?? '—'}</td>

                    {/* Churned date */}
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                      {fmtDate(account.cancellationEffectiveDate)}
                    </td>

                    {/* Reason */}
                    <td className="px-4 py-3 text-gray-500 text-xs max-w-[160px]">
                      <span className="block truncate" title={account.primaryCancellationReason ?? ''}>
                        {account.primaryCancellationReason ?? '—'}
                      </span>
                    </td>

                    {/* Current owner */}
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{account.ownerName}</td>

                    {/* New owner picker */}
                    <td className="px-4 py-3 min-w-[200px]">
                      {status === 'success' ? (
                        <span className="text-xs text-green-600 font-medium">Reassigned ✓</span>
                      ) : (
                        <div className="relative">
                          <select
                            value={selectedRepId}
                            onChange={(e) => setSelections((s) => ({ ...s, [account.id]: e.target.value }))}
                            disabled={status === 'loading'}
                            className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 pr-7 bg-white text-gray-700 appearance-none focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
                          >
                            <option value="">Select rep…</option>
                            {Object.entries(repsByRegion).map(([region, reps]) => (
                              <optgroup key={region} label={region}>
                                {reps.map((rep) => (
                                  <option key={rep.id} value={rep.id}>{rep.name}</option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                          <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                        </div>
                      )}
                    </td>

                    {/* Assign button */}
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {status === 'success' ? (
                        <CheckCircle size={16} className="text-green-500 inline-block" />
                      ) : status === 'error' ? (
                        <span className="text-xs text-red-600" title={rowErrors[account.id]}>Failed — retry</span>
                      ) : (
                        <button
                          disabled={!selectedRepId || status === 'loading'}
                          onClick={() => {
                            if (!selectedRep) return
                            reassignMutation.mutate({ account, rep: selectedRep })
                          }}
                          className="px-3 py-1.5 text-xs font-medium bg-brand-500 text-white rounded-lg hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {status === 'loading' ? 'Saving…' : 'Assign'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      {data && data.reps.length > 0 && (
        <div className="mt-3 flex items-center gap-4">
          {Object.entries(REGION_COLORS).map(([region, cls]) => (
            <span key={region} className={clsx('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium', cls)}>
              {region}
            </span>
          ))}
          <span className="text-xs text-gray-400">rep regions available in dropdown</span>
        </div>
      )}
    </div>
  )
}
