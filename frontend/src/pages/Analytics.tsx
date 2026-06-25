import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts'
import { api } from '../lib/api'
import { Loader2 } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChartDataPoint {
  date: string
  total: number
  STALLED: number
  PAST_DUE_INITIAL: number
  PAST_DUE_AMENDMENT: number
  PAST_DUE_RENEWAL: number
  MEDDPICC_MISSING: number
  NEXT_STEP_MISSING: number
  CLOSE_DATE_RISK: number
  STAGE_MISMATCH: number
}

interface DropdownOption {
  email: string
  name: string | null
}

interface FlagsOverTimeResponse {
  chartData: ChartDataPoint[]
  owners: DropdownOption[]
  managers: DropdownOption[]
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ALERT_COLORS: Record<string, string> = {
  STALLED: '#f59e0b',
  PAST_DUE_INITIAL: '#ef4444',
  PAST_DUE_AMENDMENT: '#f97316',
  PAST_DUE_RENEWAL: '#ec4899',
  MEDDPICC_MISSING: '#a855f7',
  NEXT_STEP_MISSING: '#14b8a6',
  CLOSE_DATE_RISK: '#f43f5e',
  STAGE_MISMATCH: '#8b5cf6',
}

const ALERT_LABELS: Record<string, string> = {
  STALLED: 'Zombie Pipeline',
  PAST_DUE_INITIAL: 'Past Due (New)',
  PAST_DUE_AMENDMENT: 'Past Due (Amendment)',
  PAST_DUE_RENEWAL: 'Past Due (Renewal)',
  MEDDPICC_MISSING: 'Missing MEDDPICC/BANT',
  NEXT_STEP_MISSING: 'Missing Next Step',
  CLOSE_DATE_RISK: 'Close Date Risk',
  STAGE_MISMATCH: 'Stage Mismatch',
}

const ALERT_TYPES = Object.keys(ALERT_COLORS) as Array<keyof typeof ALERT_COLORS>

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatXAxisDate(dateStr: string): string {
  // dateStr is YYYY-MM-DD, parse as UTC to avoid timezone shifts
  const [year, month, day] = dateStr.split('-').map(Number)
  const d = new Date(year, month - 1, day)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ─── Component ────────────────────────────────────────────────────────────────

export function Analytics() {
  const [days, setDays] = useState<'30' | '60' | '90'>('30')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [managerEmail, setManagerEmail] = useState('')

  const params = new URLSearchParams({ days })
  if (ownerEmail) params.set('ownerEmail', ownerEmail)
  if (managerEmail) params.set('managerEmail', managerEmail)

  const { data, isLoading, error } = useQuery<FlagsOverTimeResponse>({
    queryKey: ['analytics-flags-over-time', days, ownerEmail, managerEmail],
    queryFn: async () => {
      const res = await api.get<FlagsOverTimeResponse>(`/analytics/flags-over-time?${params.toString()}`)
      return res.data
    },
  })

  const hasData = data && data.chartData.length > 0

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Analytics</h1>
        <p className="text-sm text-gray-500 mt-1">Open flags over time — tracked each time you run a scan.</p>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        {/* Days selector */}
        <div className="flex items-center rounded-lg border border-gray-200 overflow-hidden bg-white">
          {(['30', '60', '90'] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={[
                'px-3 py-1.5 text-sm font-medium transition-colors',
                days === d
                  ? 'bg-brand-600 text-white'
                  : 'text-gray-600 hover:bg-gray-50',
              ].join(' ')}
            >
              {d}d
            </button>
          ))}
        </div>

        {/* Owner filter */}
        <select
          value={ownerEmail}
          onChange={(e) => setOwnerEmail(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">All owners</option>
          {data?.owners.map((o) => (
            <option key={o.email} value={o.email}>
              {o.name ?? o.email}
            </option>
          ))}
        </select>

        {/* Manager filter */}
        <select
          value={managerEmail}
          onChange={(e) => setManagerEmail(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <option value="">All managers</option>
          {data?.managers.map((m) => (
            <option key={m.email} value={m.email}>
              {m.name ?? m.email}
            </option>
          ))}
        </select>
      </div>

      {/* Chart Card */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-700">Open Flags Over Time</h2>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center h-80 text-gray-400">
            <Loader2 size={24} className="animate-spin mr-2" />
            <span className="text-sm">Loading...</span>
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center h-80 text-red-400 text-sm">
            Failed to load analytics data.
          </div>
        )}

        {!isLoading && !error && !hasData && (
          <div className="flex flex-col items-center justify-center h-80 text-gray-400 text-sm text-center">
            <p className="font-medium text-gray-600 mb-1">No scan history yet</p>
            <p>Run a scan from the Dashboard to start tracking flag history.</p>
          </div>
        )}

        {!isLoading && !error && hasData && (
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={data.chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="date"
                tickFormatter={formatXAxisDate}
                tick={{ fontSize: 11, fill: '#6b7280' }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 11, fill: '#6b7280' }}
                tickLine={false}
                axisLine={false}
                width={32}
              />
              <Tooltip
                formatter={(value, name) => {
                  const nameStr = String(name)
                  const label = nameStr === 'total' ? 'Unique opps' : (ALERT_LABELS[nameStr] ?? nameStr)
                  return [value, label]
                }}
                labelFormatter={(label) => formatXAxisDate(String(label))}
                contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
              />
              <Legend
                formatter={(value: string) =>
                  value === 'total' ? 'Unique opps (line)' : (ALERT_LABELS[value] ?? value)
                }
                wrapperStyle={{ fontSize: 11 }}
              />
              {ALERT_TYPES.map((type) => (
                <Bar
                  key={type}
                  dataKey={type}
                  stackId="flags"
                  fill={ALERT_COLORS[type]}
                  name={type}
                />
              ))}
              <Line
                type="monotone"
                dataKey="total"
                stroke="#374151"
                strokeWidth={2}
                strokeDasharray="4 4"
                dot={false}
                name="total"
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}

        {!isLoading && !error && hasData && (
          <p className="mt-3 text-xs text-gray-400">
            Each data point reflects the latest scan of that day. Line = unique opps; bars = total flags (one opp can have multiple).
          </p>
        )}
      </div>
    </div>
  )
}
