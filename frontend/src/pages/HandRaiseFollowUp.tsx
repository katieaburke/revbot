import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import {
  RefreshCw,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Megaphone,
  X,
} from 'lucide-react'
import clsx from 'clsx'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ContactEntry {
  id: string
  name: string
  email: string | null
  accountId: string | null
  accountName: string | null
  accountRecordType: string | null
  contactStage: string | null
  accountStage: string | null
  handRaiseDate: string | null
  typeOfHandRaise: string | null
  comment: string | null
  lastRepCommDate: string | null
  createdDate: string
  sfdcUrl: string
}

interface OwnerGroup {
  ownerName: string
  ownerEmail: string | null
  ownerRole: string | null
  contacts: ContactEntry[]
}

interface HandRaiseResponse {
  groups: OwnerGroup[]
  total: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function daysAgo(iso: string | null): number | null {
  if (!iso) return null
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
}

function daysAgoClass(days: number | null): string {
  if (days === null) return 'text-gray-400'
  if (days <= 3) return 'text-green-600 font-medium'
  if (days <= 7) return 'text-amber-600 font-medium'
  return 'text-red-600 font-medium'
}

function stageBadgeClass(stage: string | null): string {
  switch (stage) {
    case 'Sales Ready': return 'bg-green-100 text-green-700'
    case 'Working':     return 'bg-purple-100 text-purple-700'
    case 'Meeting':     return 'bg-blue-100 text-blue-700'
    case 'Nurture':     return 'bg-yellow-100 text-yellow-700'
    case 'Target':      return 'bg-gray-100 text-gray-500'
    case 'Pipeline':    return 'bg-indigo-100 text-indigo-700'
    default:            return 'bg-gray-100 text-gray-500'
  }
}

// ── OwnerCard ─────────────────────────────────────────────────────────────────

function OwnerCard({ group }: { group: OwnerGroup }) {
  const [open, setOpen] = useState(false)

  const displayName = group.ownerName || group.ownerEmail || 'Unknown Owner'
  const count = group.contacts.length

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-semibold text-gray-900 truncate">{displayName}</span>
          {group.ownerRole && (
            <span className="shrink-0 text-xs text-gray-400 truncate max-w-[200px]">
              {group.ownerRole}
            </span>
          )}
          <span className="shrink-0 text-xs font-medium px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
            {count} {count === 1 ? 'contact' : 'contacts'}
          </span>
        </div>
        <div className="shrink-0 ml-3 text-gray-400">
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-left">
                <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Contact</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Account</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Stage</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Hand Raise Date</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">Days Ago</th>
                <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Comment</th>
                <th className="px-4 py-2.5 w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {group.contacts.map((contact) => {
                const days = daysAgo(contact.handRaiseDate)
                const truncatedComment =
                  contact.comment && contact.comment.length > 120
                    ? contact.comment.slice(0, 120) + '…'
                    : (contact.comment ?? '')

                return (
                  <tr key={contact.id} className="hover:bg-gray-50/50">
                    {/* Contact name */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      <a
                        href={contact.sfdcUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-brand-600 hover:text-brand-700 hover:underline"
                      >
                        {contact.name}
                      </a>
                      {contact.email && (
                        <p className="text-xs text-gray-400 mt-0.5">{contact.email}</p>
                      )}
                    </td>

                    {/* Account */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      {contact.accountName ? (
                        <span className="text-gray-700 text-xs font-medium">{contact.accountName}</span>
                      ) : (
                        <span className="text-gray-400 text-xs">—</span>
                      )}
                      {contact.accountRecordType && (
                        <p className="text-[10px] text-gray-400 mt-0.5">{contact.accountRecordType}</p>
                      )}
                    </td>

                    {/* Contact Stage */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      {contact.contactStage ? (
                        <span className={clsx('inline-block text-xs font-medium px-2 py-0.5 rounded-full', stageBadgeClass(contact.contactStage))}>
                          {contact.contactStage}
                        </span>
                      ) : (
                        <span className="text-gray-400 text-xs">—</span>
                      )}
                    </td>

                    {/* Hand Raise Date */}
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap text-xs">
                      {formatDate(contact.handRaiseDate)}
                    </td>

                    {/* Days ago */}
                    <td className="px-4 py-3 whitespace-nowrap text-xs">
                      {days !== null ? (
                        <span className={daysAgoClass(days)}>{days}d</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>

                    {/* Comment */}
                    <td className="px-4 py-3 text-gray-500 text-xs max-w-xs">
                      {truncatedComment ? (
                        <span title={contact.comment ?? undefined}>{truncatedComment}</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>

                    {/* Open in SF */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      <a
                        href={contact.sfdcUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-gray-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
                        title="Open in Salesforce"
                      >
                        <ExternalLink size={13} />
                      </a>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── HandRaiseFollowUp page ────────────────────────────────────────────────────

export function HandRaiseFollowUp() {
  const qc = useQueryClient()

  const [maxDays, setMaxDays] = useState<number | ''>('')
  const [roleFilter, setRoleFilter] = useState<string>('')

  const { data, isFetching, isError, error } = useQuery<HandRaiseResponse>({
    queryKey: ['hand-raise-leads'],
    queryFn: () => api.get('/hand-raise/leads').then((r) => r.data),
    refetchOnWindowFocus: false,
  })

  // Client-side filtering on top of server-side filters
  const filteredGroups = (data?.groups ?? [])
    .map((group) => ({
      ...group,
      contacts: group.contacts.filter((c) => {
        if (maxDays !== '') {
          const days = daysAgo(c.handRaiseDate)
          if (days === null || days > maxDays) return false
        }
        return true
      }),
    }))
    .filter((group) => {
      if (group.contacts.length === 0) return false
      if (roleFilter.trim()) {
        const needle = roleFilter.trim().toLowerCase()
        if (!group.ownerRole?.toLowerCase().includes(needle)) return false
      }
      return true
    })

  const totalVisible = filteredGroups.reduce((s, g) => s + g.contacts.length, 0)
  const hasActiveFilters = maxDays !== '' || roleFilter.trim() !== ''

  function clearFilters() {
    setMaxDays('')
    setRoleFilter('')
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-start gap-3">
            <Megaphone size={22} className="text-orange-500 mt-0.5 shrink-0" />
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Hand Raise Follow Up</h1>
              <p className="text-sm text-gray-500 mt-0.5">
                Marketing-qualified hand raises in the last 30 days with no rep follow-up
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {data && (
              <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-orange-100 text-orange-700">
                {data.total} total
              </span>
            )}
            <button
              onClick={() => qc.invalidateQueries({ queryKey: ['hand-raise-leads'] })}
              disabled={isFetching}
              className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={14} className={clsx(isFetching && 'animate-spin')} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Filter bar */}
      <div className="bg-gray-50 border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-6 py-3 flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
              Max days since hand raise
            </label>
            <input
              type="number"
              min={0}
              placeholder="All"
              value={maxDays}
              onChange={(e) => setMaxDays(e.target.value === '' ? '' : Number(e.target.value))}
              className="w-28 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-brand-300 focus:border-brand-400"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
              Owner role contains
            </label>
            <input
              type="text"
              placeholder="e.g. New Business"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              className="w-44 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-brand-300 focus:border-brand-400"
            />
          </div>

          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 pb-0.5 transition-colors"
            >
              <X size={11} /> Clear
            </button>
          )}

          {data && hasActiveFilters && (
            <span className="text-xs text-gray-500 pb-0.5 ml-auto">
              Showing <span className="font-semibold text-gray-700">{totalVisible}</span> contact
              {totalVisible !== 1 ? 's' : ''} across{' '}
              <span className="font-semibold text-gray-700">{filteredGroups.length}</span> rep
              {filteredGroups.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-3">
        {isFetching && (
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-8 flex flex-col items-center gap-3 text-center">
            <RefreshCw size={28} className="animate-spin text-blue-500" />
            <div>
              <p className="font-medium text-blue-800">Loading hand raise data…</p>
              <p className="text-sm text-blue-600 mt-0.5">Fetching contacts from Salesforce</p>
            </div>
          </div>
        )}

        {isError && !isFetching && (
          <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            <strong>Failed to load:</strong>{' '}
            {String((error as { message?: string })?.message ?? error)}
          </div>
        )}

        {data && !isFetching && filteredGroups.length === 0 && (
          <div className="px-4 py-10 bg-green-50 border border-green-200 rounded-xl text-sm text-green-700 text-center">
            {hasActiveFilters
              ? 'No contacts match the current filters.'
              : 'No unmatched hand raises — great work! 🎉'}
          </div>
        )}

        {!isFetching && filteredGroups.map((group) => (
          <OwnerCard key={group.ownerEmail ?? group.ownerName} group={group} />
        ))}
      </div>
    </div>
  )
}
