import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import {
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Save,
  Send,
  Check,
  Filter,
  Target,
  TrendingUp,
} from 'lucide-react'
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
  arrPotential: number | null
  priority: string | null
  pricePerLocation: number | null
  currentArr: number
}

interface AccountGroup {
  accountId: string
  accountName: string
  totalCurrentArr: number
  records: ProductCoverageRecord[]
}

interface AmGroup {
  ownerEmail: string | null
  ownerName: string | null
  ownerSlackUserId: string | null
  totalLines: number
  totalCurrentArr: number
  accounts: AccountGroup[]
}

interface ExpansionPotentialResponse {
  ams: AmGroup[]
}

type SortMode = 'arr' | 'locations'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtCurrency(val: number | null | undefined): string {
  if (val === null || val === undefined) return '—'
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(val)
}

function priorityBadgeClass(priority: string | null): string {
  switch (priority) {
    case 'High':
      return 'bg-red-100 text-red-700'
    case 'Medium':
      return 'bg-amber-100 text-amber-700'
    default:
      return 'bg-gray-100 text-gray-500'
  }
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
    <div className="px-5 py-3 flex items-center gap-3 flex-wrap text-sm bg-gray-50/50">
      {/* Product name */}
      <div className="flex-1 min-w-0">
        <span className="font-medium text-gray-800 truncate block">{displayName}</span>
      </div>

      {/* Priority badge */}
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

      {/* Price per location */}
      <div className="shrink-0 text-xs text-gray-500 w-20 text-right">
        <span className="text-gray-400">€/loc: </span>
        <span className="font-medium text-gray-700">
          {record.pricePerLocation != null ? record.pricePerLocation.toLocaleString('de-DE') : '—'}
        </span>
      </div>

      {/* Current ARR */}
      <div className="shrink-0 text-xs w-28 text-right">
        <span className="text-gray-400">Curr ARR: </span>
        <span className="font-semibold text-gray-800">{fmtCurrency(record.currentArr)}</span>
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

      {save.isError && (
        <p className="w-full text-xs text-red-600 mt-1">
          Save failed — check your Salesforce connection
        </p>
      )}
    </div>
  )
}

// ── AccountSubCard ────────────────────────────────────────────────────────────

function AccountSubCard({
  account,
  onRowSaved,
}: {
  account: AccountGroup
  onRowSaved: (recordId: string) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="border border-gray-100 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-gray-800 truncate">{account.accountName}</span>
          <span className="shrink-0 text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
            {account.records.length} line{account.records.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs font-semibold text-gray-700">{fmtCurrency(account.totalCurrentArr)}</span>
          {open
            ? <ChevronUp size={13} className="text-gray-400" />
            : <ChevronDown size={13} className="text-gray-400" />
          }
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100 divide-y divide-gray-100">
          {account.records.map((record) => (
            <CoverageRow key={record.id} record={record} onSaved={() => onRowSaved(record.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── AmCard ────────────────────────────────────────────────────────────────────

function AmCard({
  am,
  isChecked,
  onCheckChange,
  onRowSaved,
  sendSuccessKey,
}: {
  am: AmGroup
  isChecked: boolean
  onCheckChange: (checked: boolean) => void
  onRowSaved: (recordId: string) => void
  sendSuccessKey: number | null
}) {
  const [open, setOpen] = useState(false)

  const displayName = am.ownerName ?? am.ownerEmail ?? 'Unknown AM'
  const totalAccounts = am.accounts.length

  return (
    <div className={clsx('bg-white rounded-xl border overflow-hidden', isChecked ? 'border-brand-400 ring-1 ring-brand-300' : 'border-gray-200')}>
      <div className="flex items-center gap-3 px-5 py-4">
        {/* Checkbox */}
        <input
          type="checkbox"
          checked={isChecked}
          onChange={(e) => onCheckChange(e.target.checked)}
          className="w-4 h-4 rounded border-gray-300 text-brand-500 focus:ring-brand-300 shrink-0 cursor-pointer"
          title={am.ownerSlackUserId ? undefined : 'No Slack user found for this AM'}
        />

        {/* Name + stats — clicking expands */}
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex-1 min-w-0 text-left flex items-center gap-3"
        >
          <span className="text-sm font-semibold text-gray-900 truncate">{displayName}</span>
          <span className="shrink-0 text-xs text-gray-500">
            {totalAccounts} {totalAccounts === 1 ? 'account' : 'accounts'} · {am.totalLines} {am.totalLines === 1 ? 'line' : 'lines'} · {fmtCurrency(am.totalCurrentArr)}
          </span>
        </button>

        {/* Send success indicator */}
        {sendSuccessKey !== null && (
          <span className="shrink-0 flex items-center gap-1 text-xs text-green-600 font-medium">
            <Check size={12} /> Sent!
          </span>
        )}

        {/* Expand/collapse */}
        <button onClick={() => setOpen((o) => !o)} className="shrink-0 text-gray-400 hover:text-gray-600">
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {open && (
        <div className="border-t border-gray-100 px-5 py-4 space-y-2">
          {am.accounts.map((account) => (
            <AccountSubCard key={account.accountId} account={account} onRowSaved={onRowSaved} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── WhitespaceHygiene page ────────────────────────────────────────────────────

export function WhitespaceHygiene() {
  const qc = useQueryClient()
  const [sortMode, setSortMode] = useState<SortMode>('arr')
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set())
  const [checkedAms, setCheckedAms] = useState<Set<string>>(new Set())
  // map ownerKey -> timestamp of send success (for 3s checkmark)
  const [sendSuccessKeys, setSendSuccessKeys] = useState<Map<string, number>>(new Map())

  const { data, isFetching, isError, error } = useQuery<ExpansionPotentialResponse>({
    queryKey: ['whitespace-expansion-potential'],
    queryFn: () => api.get('/whitespace/expansion-potential').then((r) => r.data),
    refetchOnWindowFocus: false,
  })

  const sendPromptMutation = useMutation({
    mutationFn: ({ am }: { am: AmGroup; ownerKey: string }) =>
      api.post('/whitespace/send-prompt', {
        repSlackUserId: am.ownerSlackUserId,
        repEmail: am.ownerEmail,
        repName: am.ownerName ?? am.ownerEmail,
        accountCount: am.accounts.length,
        lineCount: am.totalLines,
        currentArr: am.totalCurrentArr,
      }),
    onSuccess: (_data, variables) => {
      const { ownerKey } = variables
      const key = Date.now()
      setSendSuccessKeys((prev) => new Map(prev).set(ownerKey, key))
      setCheckedAms((prev) => {
        const next = new Set(prev)
        next.delete(ownerKey)
        return next
      })
      setTimeout(() => {
        setSendSuccessKeys((prev) => {
          const next = new Map(prev)
          if (next.get(ownerKey) === key) next.delete(ownerKey)
          return next
        })
      }, 3000)
    },
  })

  function handleRowSaved(recordId: string) {
    setRemovedIds((prev) => new Set([...prev, recordId]))
  }

  function ownerKey(am: AmGroup): string {
    return am.ownerEmail?.toLowerCase() ?? `__no_owner__${am.ownerName ?? 'unknown'}`
  }

  // Filter removed records and empty accounts/AMs
  const filteredAms = (data?.ams ?? [])
    .map((am) => ({
      ...am,
      accounts: am.accounts
        .map((acct) => ({
          ...acct,
          records: acct.records.filter((r) => !removedIds.has(r.id)),
          totalCurrentArr: acct.records
            .filter((r) => !removedIds.has(r.id))
            .reduce((s, r) => s + r.currentArr, 0),
        }))
        .filter((acct) => acct.records.length > 0),
    }))
    .map((am) => ({
      ...am,
      totalLines: am.accounts.reduce((s, a) => s + a.records.length, 0),
      totalCurrentArr: am.accounts.reduce((s, a) => s + a.totalCurrentArr, 0),
    }))
    .filter((am) => am.accounts.length > 0)

  // Apply sort within each AM's accounts
  const sortedAms = filteredAms.map((am) => ({
    ...am,
    accounts: [...am.accounts].sort((a, b) => {
      if (sortMode === 'arr') return b.totalCurrentArr - a.totalCurrentArr
      // locations: sort by sum of currentLocationsCovered
      const sumA = a.records.reduce((s, r) => s + (r.currentLocationsCovered ?? 0), 0)
      const sumB = b.records.reduce((s, r) => s + (r.currentLocationsCovered ?? 0), 0)
      return sumB - sumA
    }),
  }))

  const totalReps = sortedAms.length
  const totalAccounts = sortedAms.reduce((s, am) => s + am.accounts.length, 0)
  const totalLines = sortedAms.reduce((s, am) => s + am.totalLines, 0)

  const selectedAms = sortedAms.filter((am) => checkedAms.has(ownerKey(am)))
  const canSend = selectedAms.length > 0 && !sendPromptMutation.isPending

  function handleSendAll() {
    for (const am of selectedAms) {
      sendPromptMutation.mutate({ am, ownerKey: ownerKey(am) })
    }
  }

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

      {/* Filter/sort bar */}
      {data && !isFetching && totalLines > 0 && (
        <div className="flex items-center justify-between mb-5 gap-4 flex-wrap">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Filter size={13} className="text-gray-400" />
            <span>
              <span className="font-semibold text-gray-800">{totalReps}</span> rep{totalReps !== 1 ? 's' : ''}&nbsp;·&nbsp;
              <span className="font-semibold text-gray-800">{totalAccounts}</span> account{totalAccounts !== 1 ? 's' : ''}&nbsp;·&nbsp;
              <span className="font-semibold text-gray-800">{totalLines}</span> line{totalLines !== 1 ? 's' : ''} needing data
            </span>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="ws-sort" className="text-xs text-gray-500 font-medium">Sort by:</label>
            <select
              id="ws-sort"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-300"
            >
              <option value="arr">Current ARR ↓</option>
              <option value="locations">Current Locations ↓</option>
            </select>
          </div>
        </div>
      )}

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

      {/* Empty state */}
      {data && !isFetching && totalLines === 0 && (
        <div className="mb-6 px-4 py-3 bg-green-50 border border-green-200 rounded-xl text-sm text-green-700 text-center">
          All expansion potential lines have Total Locations Fit filled in.
        </div>
      )}

      {/* AM cards */}
      {sortedAms.length > 0 && (
        <div className="space-y-3">
          {sortedAms.map((am) => {
            const key = ownerKey(am)
            return (
              <AmCard
                key={key}
                am={am}
                isChecked={checkedAms.has(key)}
                onCheckChange={(checked) => {
                  setCheckedAms((prev) => {
                    const next = new Set(prev)
                    if (checked) next.add(key)
                    else next.delete(key)
                    return next
                  })
                }}
                onRowSaved={handleRowSaved}
                sendSuccessKey={sendSuccessKeys.get(key) ?? null}
              />
            )
          })}
        </div>
      )}

      {/* Sticky action bar */}
      {data && !isFetching && totalLines > 0 && (
        <div className="sticky bottom-6 mt-6 flex justify-center">
          <div className="bg-white border border-gray-200 rounded-2xl shadow-lg px-5 py-3 flex items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Target size={14} className="text-brand-500" />
              {selectedAms.length === 0
                ? 'Select AMs to send prompts'
                : `${selectedAms.length} AM${selectedAms.length !== 1 ? 's' : ''} selected`}
            </div>
            <button
              onClick={handleSendAll}
              disabled={!canSend}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors',
                canSend
                  ? 'bg-brand-500 text-white hover:bg-brand-600'
                  : 'bg-gray-100 text-gray-400 cursor-not-allowed'
              )}
            >
              {sendPromptMutation.isPending ? (
                <RefreshCw size={13} className="animate-spin" />
              ) : (
                <Send size={13} />
              )}
              Send prompt to {selectedAms.length > 0 ? selectedAms.length : ''} selected
            </button>
            {selectedAms.length > 0 && (
              <div className="flex items-center gap-1 text-xs text-gray-400">
                <TrendingUp size={12} />
                {fmtCurrency(selectedAms.reduce((s, am) => s + am.totalCurrentArr, 0))} current ARR
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
