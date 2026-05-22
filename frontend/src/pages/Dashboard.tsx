import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { Play, RefreshCw, AlertCircle, Clock, CheckCircle } from 'lucide-react'

interface Summary {
  total: number
  sent: number
  snoozed: number
  resolved: number
  byType: { alertType: string; _count: { id: number } }[]
}

export function Dashboard() {
  const qc = useQueryClient()
  const { data: summary, isLoading } = useQuery<Summary>({
    queryKey: ['summary'],
    queryFn: () => api.get('/notifications/summary').then((r) => r.data),
    refetchInterval: 30_000,
  })

  const runNow = useMutation({
    mutationFn: () => api.post('/notifications/run-now'),
    onSuccess: () => {
      setTimeout(() => qc.invalidateQueries({ queryKey: ['summary'] }), 3000)
    },
  })

  const alertTypeLabel: Record<string, string> = {
    PAST_DUE_INITIAL: 'Past Due — New Business',
    PAST_DUE_AMENDMENT: 'Past Due — Amendment',
    PAST_DUE_RENEWAL: 'Past Due — Renewal',
    STALLED: 'Stalled',
    MEDDPICC_MISSING: 'Missing MEDDPICC',
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">Dashboard</h2>
          <p className="text-sm text-gray-500 mt-1">Current pipeline health alerts</p>
        </div>
        <button
          onClick={() => runNow.mutate()}
          disabled={runNow.isPending}
          className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50"
        >
          {runNow.isPending ? <RefreshCw size={15} className="animate-spin" /> : <Play size={15} />}
          Run alerts now
        </button>
      </div>

      {runNow.isSuccess && (
        <div className="mb-6 px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
          ✅ Alert job queued — notifications will be sent in a moment.
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-gray-500">Loading...</div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-4 mb-8">
            <StatCard label="Pending alerts" value={summary?.sent ?? 0} icon={<AlertCircle size={18} className="text-red-500" />} />
            <StatCard label="Snoozed" value={summary?.snoozed ?? 0} icon={<Clock size={18} className="text-yellow-500" />} />
            <StatCard label="Resolved" value={summary?.resolved ?? 0} icon={<CheckCircle size={18} className="text-green-500" />} />
          </div>

          {/* By type */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <h3 className="font-medium text-gray-900">Active alerts by type</h3>
            </div>
            <div className="divide-y divide-gray-100">
              {summary?.byType.length === 0 && (
                <div className="px-6 py-8 text-center text-sm text-gray-400">No active alerts</div>
              )}
              {summary?.byType.map((t) => (
                <div key={t.alertType} className="flex items-center justify-between px-6 py-3">
                  <span className="text-sm text-gray-700">{alertTypeLabel[t.alertType] ?? t.alertType}</span>
                  <span className="text-sm font-semibold text-gray-900">{t._count.id}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function StatCard({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 px-6 py-5 flex items-center gap-4">
      <div className="p-2 bg-gray-50 rounded-lg">{icon}</div>
      <div>
        <div className="text-2xl font-bold text-gray-900">{value}</div>
        <div className="text-xs text-gray-500 mt-0.5">{label}</div>
      </div>
    </div>
  )
}
