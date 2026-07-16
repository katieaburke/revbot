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
  X,
  Users,
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
  contractEndDate: string | null
  totalCurrentArr: number
  totalCurrentLocations: number
  records: ProductCoverageRecord[]
}

interface AmGroup {
  ownerEmail: string | null
  ownerName: string | null
  ownerSlackUserId: string | null
  managerEmail: string | null
  managerName: string | null
  managerSlackUserId: string | null
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
  const [bulkValue, setBulkValue] = useState<string>('')
  const [bulkSuccess, setBulkSuccess] = useState(false)
  const [bulkError, setBulkError] = useState(false)
  const [bulkPending, setBulkPending] = useState(false)

  async function handleBulkApply() {
    if (!bulkValue || bulkPending) return
    const num = Number(bulkValue)
    if (isNaN(num) || num < 0) return
    setBulkPending(true)
    setBulkError(false)
    try {
      await Promise.all(
        account.records.map((r) =>
          api.patch(`/whitespace/product-coverage/${r.id}`, { totalLocationsFit: num })
        )
      )
      setBulkSuccess(true)
      setBulkValue('')
      setTimeout(() => {
        account.records.forEach((r) => onRowSaved(r.id))
      }, 600)
    } catch {
      setBulkError(true)
    } finally {
      setBulkPending(false)
    }
  }

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
          {account.contractEndDate && (
            <span className="shrink-0 text-xs text-gray-400">
              ends {new Date(account.contractEndDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
            </span>
          )}
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
        <div className="border-t border-gray-100">
          {/* Bulk apply row */}
          {account.records.length > 1 && (
            <div className="px-4 py-2.5 bg-amber-50 border-b border-amber-100 flex items-center gap-3 flex-wrap">
              <span className="text-xs text-amber-700 font-medium shrink-0">
                Apply same total locations to all {account.records.length} lines:
              </span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  placeholder="Total locations fit"
                  value={bulkValue}
                  onChange={(e) => { setBulkValue(e.target.value); setBulkSuccess(false); setBulkError(false) }}
                  onKeyDown={(e) => e.key === 'Enter' && handleBulkApply()}
                  className="w-36 text-xs border border-amber-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-amber-300 bg-white"
                  disabled={bulkPending || bulkSuccess}
                />
                <button
                  onClick={handleBulkApply}
                  disabled={!bulkValue || bulkPending || bulkSuccess}
                  className={clsx(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0',
                    bulkSuccess
                      ? 'bg-green-100 text-green-700'
                      : 'bg-amber-500 text-white hover:bg-amber-600'
                  )}
                >
                  {bulkPending ? (
                    <RefreshCw size={11} className="animate-spin" />
                  ) : bulkSuccess ? (
                    <Check size={11} />
                  ) : (
                    <Save size={11} />
                  )}
                  {bulkSuccess ? 'Saved all!' : `Apply to all ${account.records.length}`}
                </button>
              </div>
              {bulkError && (
                <p className="w-full text-xs text-red-600">Save failed — check Salesforce connection</p>
              )}
            </div>
          )}

          {/* Individual rows */}
          <div className="divide-y divide-gray-100">
            {account.records.map((record) => (
              <CoverageRow key={record.id} record={record} onSaved={() => onRowSaved(record.id)} />
            ))}
          </div>
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

// ── Message preview modal ─────────────────────────────────────────────────────

interface ActiveFilters {
  minArr: string
  minLocations: string
  contractEndBefore: string
}

function buildFilterLines(filters: ActiveFilters): string[] {
  const lines: string[] = []
  if (filters.contractEndBefore) {
    const d = new Date(filters.contractEndBefore)
    const formatted = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    lines.push(`📅 We're prioritising accounts with contracts expiring before *${formatted}* — these are most time-sensitive for capturing expansion potential ahead of renewal.`)
  }
  if (filters.minArr) {
    const val = Number(filters.minArr)
    if (!isNaN(val) && val > 0) {
      lines.push(`💰 Focused on accounts with at least *${fmtCurrency(val)}* in current ARR.`)
    }
  }
  if (filters.minLocations) {
    const val = Number(filters.minLocations)
    if (!isNaN(val) && val > 0) {
      lines.push(`📍 Focused on accounts with at least *${val} current locations*.`)
    }
  }
  return lines
}

function SlackMessagePreview({ am, filters }: { am: AmGroup; filters: ActiveFilters }) {
  const firstName = am.ownerName?.split(' ')[0] ?? am.ownerEmail ?? 'there'
  const lineWord = am.totalLines === 1 ? 'line' : 'lines'
  const accountWord = am.accounts.length === 1 ? 'account' : 'accounts'
  const hasArr = am.totalCurrentArr > 0
  const filterLines = buildFilterLines(filters)

  return (
    <div className="bg-[#1a1d21] rounded-xl p-4 text-sm font-sans">
      {/* Bot name */}
      <div className="flex items-center gap-2 mb-2">
        <div className="w-8 h-8 rounded-lg bg-brand-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">R</div>
        <span className="text-[#d1d2d3] font-semibold text-sm">RevBot</span>
        <span className="text-[#5c5f65] text-xs">App</span>
      </div>

      {/* Header block */}
      <div className="bg-[#222529] border-l-4 border-brand-500 rounded-r-lg px-3 py-2 mb-2">
        <p className="text-[#d1d2d3] font-bold text-sm">📊 Quick data request — expansion potential</p>
      </div>

      {/* Body */}
      <div className="text-[#d1d2d3] leading-relaxed space-y-2 px-1">
        <p>
          Hey <span className="font-semibold">{firstName}</span>! We're building out whitespace data across your book and need your help filling in a few gaps.
        </p>
        <p>
          You have <span className="font-semibold text-white">{am.totalLines} product coverage {lineWord}</span> across <span className="font-semibold text-white">{am.accounts.length} {accountWord}</span> where we're missing the total location fit count.
        </p>
        {hasArr && (
          <p>
            Your accounts represent <span className="font-semibold text-white">{fmtCurrency(am.totalCurrentArr)}</span> in current ARR — there may be significant expansion potential we're not capturing.
          </p>
        )}
        {filterLines.length > 0 && (
          <div className="my-1 py-2 px-2 border-l-2 border-[#7b8ec8] space-y-1.5">
            {filterLines.map((line, i) => (
              <p key={i} className="text-[#c8cdd4] text-xs leading-relaxed">
                {line.split(/(\*[^*]+\*)/).map((part, j) =>
                  part.startsWith('*') && part.endsWith('*')
                    ? <span key={j} className="font-semibold text-white">{part.slice(1, -1)}</span>
                    : part
                )}
              </p>
            ))}
          </div>
        )}
        <p className="text-[#b0b3b8]">
          <span className="font-semibold text-white">Can you fill these in?</span> It helps us calculate expansion potential and ARR opportunity across your accounts.
        </p>
      </div>

      {/* Button */}
      <div className="mt-3 px-1">
        <span className="inline-flex items-center px-3 py-1.5 bg-brand-500 text-white text-xs font-semibold rounded cursor-default">
          Fill in my accounts →
        </span>
      </div>

      {/* Context */}
      <p className="mt-2 px-1 text-[#5c5f65] text-xs">📋 Open in your RevBot portal</p>
    </div>
  )
}

function SendPreviewModal({
  selectedAms,
  filters,
  onConfirm,
  onCancel,
  isSending,
}: {
  selectedAms: AmGroup[]
  filters: ActiveFilters
  onConfirm: () => void
  onCancel: () => void
  isSending: boolean
}) {
  const [previewIdx, setPreviewIdx] = useState(0)
  const current = selectedAms[previewIdx]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h3 className="font-semibold text-gray-900">Review message drafts</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {selectedAms.length} message{selectedAms.length !== 1 ? 's' : ''} ready to send
            </p>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        {/* Rep tabs if multiple */}
        {selectedAms.length > 1 && (
          <div className="flex gap-1 px-4 pt-3 flex-wrap">
            {selectedAms.map((am, i) => (
              <button
                key={am.ownerEmail ?? i}
                onClick={() => setPreviewIdx(i)}
                className={clsx(
                  'px-3 py-1 rounded-full text-xs font-medium transition-colors',
                  i === previewIdx
                    ? 'bg-brand-500 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                )}
              >
                {am.ownerName?.split(' ')[0] ?? am.ownerEmail}
              </button>
            ))}
          </div>
        )}

        {/* Preview */}
        <div className="px-4 py-4 overflow-y-auto flex-1">
          <p className="text-xs text-gray-400 mb-2 font-medium">
            To: <span className="text-gray-700">{current.ownerName ?? current.ownerEmail}</span>
            {!current.ownerSlackUserId && (
              <span className="ml-2 text-amber-500">⚠ No Slack ID — message won't send</span>
            )}
          </p>

          {/* Active filter chips */}
          {(filters.contractEndBefore || filters.minArr || filters.minLocations) && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {filters.contractEndBefore && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200">
                  📅 Contract ends before {new Date(filters.contractEndBefore).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                </span>
              )}
              {filters.minArr && Number(filters.minArr) > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-50 text-green-700 border border-green-200">
                  💰 Min ARR {fmtCurrency(Number(filters.minArr))}
                </span>
              )}
              {filters.minLocations && Number(filters.minLocations) > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-purple-50 text-purple-700 border border-purple-200">
                  📍 Min {filters.minLocations} locations
                </span>
              )}
              <span className="text-[11px] text-gray-400 self-center">← included in message</span>
            </div>
          )}

          <SlackMessagePreview am={current} filters={filters} />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button
            onClick={onCancel}
            disabled={isSending}
            className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isSending}
            className="flex items-center gap-2 px-5 py-2 bg-brand-500 text-white text-sm font-medium rounded-xl hover:bg-brand-600 disabled:opacity-50"
          >
            {isSending ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />}
            Send {selectedAms.length} message{selectedAms.length !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Manager types ─────────────────────────────────────────────────────────────

interface ManagerEntry {
  managerEmail: string | null
  managerName: string | null
  managerSlackUserId: string | null
  repCount: number
  accountCount: number
  lineCount: number
}

// ── Manager Slack preview ─────────────────────────────────────────────────────

function ManagerSlackMessagePreview({ manager }: { manager: ManagerEntry }) {
  const firstName = manager.managerName?.split(' ')[0] ?? manager.managerEmail ?? 'there'
  const repWord = manager.repCount === 1 ? 'rep' : 'reps'
  const accountWord = manager.accountCount === 1 ? 'account' : 'accounts'
  const lineWord = manager.lineCount === 1 ? 'product coverage line' : 'product coverage lines'

  return (
    <div className="bg-[#1a1d21] rounded-xl p-4 text-sm font-sans">
      {/* Bot name */}
      <div className="flex items-center gap-2 mb-2">
        <div className="w-8 h-8 rounded-lg bg-brand-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">R</div>
        <span className="text-[#d1d2d3] font-semibold text-sm">RevBot</span>
        <span className="text-[#5c5f65] text-xs">App</span>
      </div>

      {/* Header block */}
      <div className="bg-[#222529] border-l-4 border-brand-500 rounded-r-lg px-3 py-2 mb-2">
        <p className="text-[#d1d2d3] font-bold text-sm">📊 Team data request — expansion potential</p>
      </div>

      {/* Body */}
      <div className="text-[#d1d2d3] leading-relaxed space-y-2 px-1">
        <p>
          Hey <span className="font-semibold">{firstName}</span>! Your team has{' '}
          <span className="font-semibold text-white">{manager.lineCount} {lineWord}</span> across{' '}
          <span className="font-semibold text-white">{manager.accountCount} {accountWord}</span> where we're missing total location fit data.
          This feeds into expansion potential and ARR opportunity calculations.
          Can you nudge your {manager.repCount} {repWord} to fill these in? They'll each get a separate request from RevBot.
        </p>
      </div>

      {/* Button */}
      <div className="mt-3 px-1">
        <span className="inline-flex items-center px-3 py-1.5 bg-brand-500 text-white text-xs font-semibold rounded cursor-default">
          View your team's whitespace →
        </span>
      </div>

      {/* Context */}
      <p className="mt-2 px-1 text-[#5c5f65] text-xs">📋 Open in your RevBot portal</p>
    </div>
  )
}

function ManagerSendPreviewModal({
  managers,
  onConfirm,
  onCancel,
  isSending,
}: {
  managers: ManagerEntry[]
  onConfirm: () => void
  onCancel: () => void
  isSending: boolean
}) {
  const [previewIdx, setPreviewIdx] = useState(0)
  const current = managers[previewIdx]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h3 className="font-semibold text-gray-900">Review manager message drafts</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {managers.length} message{managers.length !== 1 ? 's' : ''} ready to send
            </p>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        {/* Manager tabs if multiple */}
        {managers.length > 1 && (
          <div className="flex gap-1 px-4 pt-3 flex-wrap">
            {managers.map((mgr, i) => (
              <button
                key={mgr.managerEmail ?? i}
                onClick={() => setPreviewIdx(i)}
                className={clsx(
                  'px-3 py-1 rounded-full text-xs font-medium transition-colors',
                  i === previewIdx
                    ? 'bg-brand-500 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                )}
              >
                {mgr.managerName?.split(' ')[0] ?? mgr.managerEmail}
              </button>
            ))}
          </div>
        )}

        {/* Preview */}
        <div className="px-4 py-4 overflow-y-auto flex-1">
          <p className="text-xs text-gray-400 mb-2 font-medium">
            To: <span className="text-gray-700">{current.managerName ?? current.managerEmail}</span>
            {!current.managerSlackUserId && (
              <span className="ml-2 text-amber-500">⚠ No Slack ID — message won't send</span>
            )}
          </p>
          <ManagerSlackMessagePreview manager={current} />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button
            onClick={onCancel}
            disabled={isSending}
            className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isSending}
            className="flex items-center gap-2 px-5 py-2 bg-brand-500 text-white text-sm font-medium rounded-xl hover:bg-brand-600 disabled:opacity-50"
          >
            {isSending ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />}
            Send {managers.length} message{managers.length !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── WhitespaceHygiene page ────────────────────────────────────────────────────

export function WhitespaceHygiene() {
  const qc = useQueryClient()
  const [sortMode, setSortMode] = useState<SortMode>('arr')
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set())
  const [checkedAms, setCheckedAms] = useState<Set<string>>(new Set())
  // Filters
  const [minArr, setMinArr] = useState<string>('')
  const [minLocations, setMinLocations] = useState<string>('')
  const [contractEndBefore, setContractEndBefore] = useState<string>('')
  // map ownerKey -> timestamp of send success (for 3s checkmark)
  const [sendSuccessKeys, setSendSuccessKeys] = useState<Map<string, number>>(new Map())
  const [previewOpen, setPreviewOpen] = useState(false)
  const [managerPreviewOpen, setManagerPreviewOpen] = useState(false)

  const { data, isFetching, isError, error } = useQuery<ExpansionPotentialResponse>({
    queryKey: ['whitespace-expansion-potential'],
    queryFn: () => api.get('/whitespace/expansion-potential').then((r) => r.data),
    refetchOnWindowFocus: false,
  })

  const sendPromptMutation = useMutation({
    mutationFn: ({ am, filters }: { am: AmGroup; ownerKey: string; filters: ActiveFilters }) =>
      api.post('/whitespace/send-prompt', {
        repSlackUserId: am.ownerSlackUserId,
        repEmail: am.ownerEmail,
        repName: am.ownerName ?? am.ownerEmail,
        accountCount: am.accounts.length,
        lineCount: am.totalLines,
        currentArr: am.totalCurrentArr,
        filters,
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

  const sendManagerPromptMutation = useMutation({
    mutationFn: (manager: ManagerEntry) =>
      api.post('/whitespace/send-manager-prompt', {
        managerSlackUserId: manager.managerSlackUserId,
        managerEmail: manager.managerEmail,
        managerName: manager.managerName,
        repCount: manager.repCount,
        accountCount: manager.accountCount,
        lineCount: manager.lineCount,
      }),
  })

  function handleRowSaved(recordId: string) {
    setRemovedIds((prev) => new Set([...prev, recordId]))
  }

  function ownerKey(am: AmGroup): string {
    return am.ownerEmail?.toLowerCase() ?? `__no_owner__${am.ownerName ?? 'unknown'}`
  }

  // Parse active filter values
  const minArrVal = minArr !== '' ? Number(minArr) : null
  const minLocationsVal = minLocations !== '' ? Number(minLocations) : null
  const contractEndBeforeVal = contractEndBefore !== '' ? contractEndBefore : null // ISO date string YYYY-MM-DD

  // Filter removed records and empty accounts/AMs, then apply user filters
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
          totalCurrentLocations: acct.records
            .filter((r) => !removedIds.has(r.id))
            .reduce((s, r) => s + (r.currentLocationsCovered ?? 0), 0),
        }))
        .filter((acct) => {
          if (acct.records.length === 0) return false
          if (minArrVal !== null && acct.totalCurrentArr < minArrVal) return false
          if (minLocationsVal !== null && acct.totalCurrentLocations < minLocationsVal) return false
          if (contractEndBeforeVal !== null) {
            if (!acct.contractEndDate) return false
            if (acct.contractEndDate > contractEndBeforeVal) return false
          }
          return true
        }),
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
    setPreviewOpen(true)
  }

  const activeFilters: ActiveFilters = { minArr, minLocations, contractEndBefore }

  function handleConfirmSend() {
    for (const am of selectedAms) {
      sendPromptMutation.mutate({ am, ownerKey: ownerKey(am), filters: activeFilters })
    }
    setPreviewOpen(false)
  }

  // Compute unique managers from currently displayed sortedAms
  const uniqueManagers: ManagerEntry[] = (() => {
    const mgMap = new Map<string, ManagerEntry>()
    for (const am of sortedAms) {
      const mgKey = am.managerEmail?.toLowerCase() ?? am.managerName ?? '__no_manager__'
      if (!mgMap.has(mgKey)) {
        mgMap.set(mgKey, {
          managerEmail: am.managerEmail,
          managerName: am.managerName,
          managerSlackUserId: am.managerSlackUserId,
          repCount: 0,
          accountCount: 0,
          lineCount: 0,
        })
      }
      const entry = mgMap.get(mgKey)!
      entry.repCount += 1
      entry.accountCount += am.accounts.length
      entry.lineCount += am.totalLines
    }
    return Array.from(mgMap.values())
  })()

  function handleConfirmManagerSend() {
    for (const mgr of uniqueManagers) {
      sendManagerPromptMutation.mutate(mgr)
    }
    setManagerPreviewOpen(false)
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
      <div className="mb-5 space-y-3">
        {/* Filter row */}
        <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex flex-wrap items-end gap-4">
            <div className="flex items-center gap-1.5 text-xs text-gray-500 font-medium shrink-0">
              <Filter size={12} className="text-gray-400" />
              Filter accounts:
            </div>

            {/* Min ARR */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Min ARR (€)</label>
              <input
                type="number"
                min={0}
                placeholder="e.g. 10000"
                value={minArr}
                onChange={(e) => setMinArr(e.target.value)}
                className="w-32 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-300"
              />
            </div>

            {/* Min Locations */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Min Locations</label>
              <input
                type="number"
                min={0}
                placeholder="e.g. 50"
                value={minLocations}
                onChange={(e) => setMinLocations(e.target.value)}
                className="w-32 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-300"
              />
            </div>

            {/* Contract end before */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Contract ends before</label>
              <input
                type="date"
                value={contractEndBefore}
                onChange={(e) => setContractEndBefore(e.target.value)}
                className="w-36 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-300"
              />
            </div>

            {/* Clear filters */}
            {(minArr || minLocations || contractEndBefore) && (
              <button
                onClick={() => { setMinArr(''); setMinLocations(''); setContractEndBefore('') }}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 pb-0.5"
              >
                <X size={11} /> Clear
              </button>
            )}

            {/* Sort */}
            <div className="flex flex-col gap-1 ml-auto">
              <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Sort accounts by</label>
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
                className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-300"
              >
                <option value="arr">Current ARR ↓</option>
                <option value="locations">Current Locations ↓</option>
              </select>
            </div>
          </div>

          {/* Stats row */}
          {totalLines > 0 && (
            <div className="flex items-center gap-2 text-sm text-gray-500 px-1">
              <span>
                <span className="font-semibold text-gray-800">{totalReps}</span> rep{totalReps !== 1 ? 's' : ''}&nbsp;·&nbsp;
                <span className="font-semibold text-gray-800">{totalAccounts}</span> account{totalAccounts !== 1 ? 's' : ''}&nbsp;·&nbsp;
                <span className="font-semibold text-gray-800">{totalLines}</span> line{totalLines !== 1 ? 's' : ''} needing data
              </span>
            </div>
          )}
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

      {/* Manager sticky action bar */}
      {data && !isFetching && totalLines > 0 && uniqueManagers.length > 0 && (
        <div className="sticky bottom-6 mt-3 flex justify-center">
          <div className="bg-white border border-gray-200 rounded-2xl shadow-lg px-5 py-3 flex items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Users size={14} className="text-indigo-500" />
              {uniqueManagers.length} manager{uniqueManagers.length !== 1 ? 's' : ''} across {totalReps} reps
            </div>
            <button
              onClick={() => setManagerPreviewOpen(true)}
              disabled={sendManagerPromptMutation.isPending}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors',
                sendManagerPromptMutation.isPending
                  ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  : 'bg-indigo-600 text-white hover:bg-indigo-700'
              )}
            >
              {sendManagerPromptMutation.isPending ? (
                <RefreshCw size={13} className="animate-spin" />
              ) : (
                <Send size={13} />
              )}
              Send to managers
            </button>
          </div>
        </div>
      )}

      {/* Send preview modal */}
      {previewOpen && selectedAms.length > 0 && (
        <SendPreviewModal
          selectedAms={selectedAms}
          filters={activeFilters}
          onConfirm={handleConfirmSend}
          onCancel={() => setPreviewOpen(false)}
          isSending={sendPromptMutation.isPending}
        />
      )}

      {/* Manager send preview modal */}
      {managerPreviewOpen && uniqueManagers.length > 0 && (
        <ManagerSendPreviewModal
          managers={uniqueManagers}
          onConfirm={handleConfirmManagerSend}
          onCancel={() => setManagerPreviewOpen(false)}
          isSending={sendManagerPromptMutation.isPending}
        />
      )}
    </div>
  )
}
