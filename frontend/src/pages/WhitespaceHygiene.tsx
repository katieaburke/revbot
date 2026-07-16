import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { RefreshCw, ChevronDown, ChevronUp, Save, Send, Check } from 'lucide-react'
import clsx from 'clsx'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProductCoverageRecord {
  id: string
  name: string
  productCoverageName: string | null
  accountId: string
  accountName: string
  currentStatus: string | null
  fitUseCase: string | null
  currentLocationsCovered: number | null
  totalLocationsFit: number | null
  expansionPotential: number | null
  arrPotential: number | null
  priority: string | null
}

interface AccountGroup {
  accountId: string
  accountName: string
  ownerEmail: string | null
  ownerName: string | null
  ownerSlackUserId: string | null
  records: ProductCoverageRecord[]
}

interface ExpansionPotentialResponse {
  accounts: AccountGroup[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusBadgeClass(status: string | null): string {
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

function fitBadgeClass(fit: string | null): string {
  switch (fit) {
    case 'Strong Fit':
      return 'bg-green-100 text-green-700'
    case 'Possible Fit':
      return 'bg-yellow-100 text-yellow-700'
    default:
      return 'bg-gray-100 text-gray-500'
  }
}

function priorityBadgeClass(priority: string | null): string {
  switch (priority) {
    case 'High':
      return 'bg-red-100 text-red-700'
    case 'Medium':
      return 'bg-amber-100 text-amber-700'
    case 'Low':
      return 'bg-gray-100 text-gray-500'
    default:
      return 'bg-gray-100 text-gray-500'
  }
}

function fmtCurrency(val: number | null): string {
  if (val === null || val === undefined) return '—'
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(val)
}

// ── AccountCard ───────────────────────────────────────────────────────────────

function AccountCard({
  group,
  onRowSaved,
  onSendPrompt,
}: {
  group: AccountGroup
  onRowSaved: (recordId: string) => void
  onSendPrompt: (group: AccountGroup) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 hover:bg-gray-50">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-3 min-w-0 flex-1 text-left"
        >
          <span className="text-sm font-semibold text-gray-900 truncate">{group.accountName}</span>
          <span className="shrink-0 text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
            {group.records.length} line{group.records.length !== 1 ? 's' : ''}
          </span>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          {group.ownerSlackUserId && (
            <SendPromptButton group={group} onSendPrompt={onSendPrompt} />
          )}
          {open
            ? <ChevronUp size={14} className="text-gray-400" />
            : <ChevronDown size={14} className="text-gray-400" />
          }
        </div>
      </div>

      {open && (
        <div className="border-t border-gray-100 divide-y divide-gray-100">
          {group.records.map((record) => (
            <CoverageRow key={record.id} record={record} onSaved={() => onRowSaved(record.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── SendPromptButton ──────────────────────────────────────────────────────────

function SendPromptButton({
  group,
  onSendPrompt,
}: {
  group: AccountGroup
  onSendPrompt: (group: AccountGroup) => void
}) {
  const [sent, setSent] = useState(false)

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation()
    onSendPrompt(group)
    setSent(true)
    setTimeout(() => setSent(false), 3000)
  }

  return (
    <button
      onClick={handleClick}
      disabled={sent}
      title={`Send whitespace prompt to ${group.ownerName ?? group.ownerEmail ?? 'owner'}`}
      className={clsx(
        'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
        sent
          ? 'bg-green-100 text-green-700'
          : 'text-gray-500 border border-gray-200 hover:bg-gray-50 hover:text-gray-700',
      )}
    >
      {sent ? <Check size={11} /> : <Send size={11} />}
      {sent ? 'Sent!' : 'Send prompt'}
    </button>
  )
}

// ── CoverageRow ───────────────────────────────────────────────────────────────

function CoverageRow({ record, onSaved }: { record: ProductCoverageRecord; onSaved: () => void }) {
  const [locationsValue, setLocationsValue] = useState<string>('')
  const [saveSuccess, setSaveSuccess] = useState(false)

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/whitespace/product-coverage/${record.id}`, {
        totalLocationsFit: Number(locationsValue),
      }),
    onSuccess: () => {
      setSaveSuccess(true)
      setTimeout(() => {
        onSaved()
      }, 600)
    },
  })

  const displayName = record.productCoverageName ?? record.name

  return (
    <div className="px-5 py-3 flex items-center gap-4 flex-wrap text-sm">

      {/* Product name */}
      <div className="flex-1 min-w-0">
        <span className="font-medium text-gray-800 truncate block">{displayName}</span>
      </div>

      {/* Current Status badge */}
      <span className={clsx('shrink-0 text-xs font-medium px-2 py-0.5 rounded-full', statusBadgeClass(record.currentStatus))}>
        {record.currentStatus ?? '—'}
      </span>

      {/* Fit badge */}
      <span className={clsx('shrink-0 text-xs font-medium px-2 py-0.5 rounded-full', fitBadgeClass(record.fitUseCase))}>
        {record.fitUseCase ?? '—'}
      </span>

      {/* Priority badge — only if set */}
      {record.priority && (
        <span className={clsx('shrink-0 text-xs font-medium px-2 py-0.5 rounded-full', priorityBadgeClass(record.priority))}>
          {record.priority}
        </span>
      )}

      {/* Current Locations Covered */}
      <div className="shrink-0 text-xs text-gray-500 w-24 text-right">
        <span className="text-gray-400">Covered: </span>
        <span className="font-medium text-gray-700">{record.currentLocationsCovered ?? '—'}</span>
      </div>

      {/* ARR Potential */}
      <div className="shrink-0 text-xs text-gray-500 w-28 text-right">
        <span className="text-gray-400">ARR: </span>
        <span className="font-medium text-gray-700">{fmtCurrency(record.arrPotential)}</span>
      </div>

      {/* Total Locations Fit input + Save */}
      <div className="shrink-0 flex items-center gap-2">
        <input
          type="number"
          min={0}
          placeholder="Total fit"
          value={locationsValue}
          onChange={(e) => setLocationsValue(e.target.value)}
          className="w-24 text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-center focus:outline-none focus:ring-2 focus:ring-brand-300 focus:border-brand-400"
          disabled={save.isPending || saveSuccess}
        />
        <button
          onClick={() => save.mutate()}
          disabled={!locationsValue || save.isPending || saveSuccess}
          className={clsx(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40',
            saveSuccess
              ? 'bg-green-100 text-green-700'
              : 'bg-brand-500 text-white hover:bg-brand-600 disabled:cursor-not-allowed'
          )}
        >
          {save.isPending ? (
            <RefreshCw size={11} className="animate-spin" />
          ) : (
            <Save size={11} />
          )}
          {saveSuccess ? 'Saved!' : 'Save'}
        </button>
      </div>

      {/* Error */}
      {save.isError && (
        <p className="w-full text-xs text-red-600 mt-1">
          Save failed — check your Salesforce connection
        </p>
      )}
    </div>
  )
}

// ── WhitespaceHygiene page ────────────────────────────────────────────────────

export function WhitespaceHygiene() {
  const qc = useQueryClient()
  const [activeTab] = useState<'expansion-potential'>('expansion-potential')

  // Local state for dismissed rows (removed from list on save success)
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set())

  const sendPromptMutation = useMutation({
    mutationFn: (group: AccountGroup) =>
      api.post('/whitespace/send-prompt', {
        repSlackUserId: group.ownerSlackUserId,
        repEmail: group.ownerEmail,
        repName: group.ownerName ?? group.ownerEmail,
        accountCount: 1,
        lineCount: group.records.length,
      }),
  })

  function handleSendPrompt(group: AccountGroup) {
    sendPromptMutation.mutate(group)
  }

  const { data, isFetching, isError, error } = useQuery<ExpansionPotentialResponse>({
    queryKey: ['whitespace-expansion-potential'],
    queryFn: () => api.get('/whitespace/expansion-potential').then((r) => r.data),
    refetchOnWindowFocus: false,
  })

  function handleRowSaved(recordId: string) {
    setRemovedIds((prev) => new Set([...prev, recordId]))
  }

  // Filter out saved rows from the data
  const filteredAccounts = (data?.accounts ?? [])
    .map((account) => ({
      ...account,
      records: account.records.filter((r) => !removedIds.has(r.id)),
    }))
    .filter((account) => account.records.length > 0)

  const totalLines = filteredAccounts.reduce((sum, a) => sum + a.records.length, 0)
  const totalAccounts = filteredAccounts.length

  return (
    <div className="p-8 max-w-5xl">

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">Whitespace Hygiene</h2>
          <p className="text-sm text-gray-500 mt-1">Product Coverage records missing key whitespace data</p>
        </div>
        <button
          onClick={() => {
            setRemovedIds(new Set())
            qc.invalidateQueries({ queryKey: ['whitespace-expansion-potential'] })
          }}
          disabled={isFetching}
          className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50"
        >
          {isFetching ? <RefreshCw size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          Refresh
        </button>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200">
        <button
          className={clsx(
            'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
            activeTab === 'expansion-potential'
              ? 'border-brand-500 text-brand-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          )}
        >
          Expansion Potential
        </button>
      </div>

      {/* Loading */}
      {isFetching && (
        <div className="mb-6 bg-blue-50 border border-blue-200 rounded-xl p-6 flex flex-col items-center gap-3 text-center">
          <RefreshCw size={28} className="animate-spin text-blue-500" />
          <div>
            <p className="font-medium text-blue-800">Loading whitespace data...</p>
            <p className="text-sm text-blue-600 mt-0.5">Querying Salesforce Product Coverage records</p>
          </div>
        </div>
      )}

      {/* Error */}
      {isError && !isFetching && (
        <div className="mb-6 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <strong>Failed to load:</strong> {String((error as { message?: string })?.message ?? error)}
        </div>
      )}

      {/* Summary badge */}
      {data && !isFetching && (
        <>
          {totalLines === 0 ? (
            <div className="mb-6 px-4 py-3 bg-green-50 border border-green-200 rounded-xl text-sm text-green-700 text-center">
              All expansion potential lines have Total Locations Fit filled in.
            </div>
          ) : (
            <div className="mb-6 inline-flex items-center gap-2 px-4 py-2 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800 font-medium">
              <span className="font-bold text-amber-900">{totalLines}</span>
              {totalLines === 1 ? 'line' : 'lines'} across{' '}
              <span className="font-bold text-amber-900">{totalAccounts}</span>
              {totalAccounts === 1 ? ' account' : ' accounts'} missing Total Locations Fit
            </div>
          )}

          {/* Account cards */}
          {filteredAccounts.length > 0 && (
            <div className="space-y-3">
              {filteredAccounts.map((group) => (
                <AccountCard key={group.accountId} group={group} onRowSaved={handleRowSaved} onSendPrompt={handleSendPrompt} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
