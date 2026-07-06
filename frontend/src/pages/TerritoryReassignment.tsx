import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { RefreshCw, Send, ChevronDown, ChevronUp, Users, AlertCircle, X, Settings, Plus, Trash2 } from 'lucide-react'
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

interface RoutingRule {
  id: number
  description: string
  route: string
  suggestAna: boolean
  condition: string
}

interface Leader {
  name: string
  email: string
  region: string
}

interface RoutingConfig {
  leaders: Record<string, Leader>
  ana: { name: string; email: string }
  spanishSpeakingOwners: string[]
  northernEuropeOwners: string[]
  latamCountries: string[]
  rules: RoutingRule[]
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
  const [showDraft, setShowDraft] = useState(false)
  const [showRules, setShowRules] = useState(false)
  const [editSpanish, setEditSpanish] = useState<string[] | null>(null)
  const [editNorthernEurope, setEditNorthernEurope] = useState<string[] | null>(null)
  const [newNameSpanish, setNewNameSpanish] = useState('')
  const [newNameNorthernEurope, setNewNameNorthernEurope] = useState('')
  const queryClient = useQueryClient()

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
      setShowDraft(false)
    },
  })

  const { data: routingConfig } = useQuery<RoutingConfig>({
    queryKey: ['territory-routing-config'],
    queryFn: () => api.get('/territory/routing-config').then((r) => r.data),
    enabled: showRules,
    staleTime: 60_000,
  })

  const saveRulesMutation = useMutation({
    mutationFn: (payload: { spanishSpeakingOwners: string[]; northernEuropeOwners: string[] }) =>
      api.put('/territory/routing-config', payload).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['territory-routing-config'] })
      queryClient.invalidateQueries({ queryKey: ['territory-reassignment-preview'] })
      setEditSpanish(null)
      setEditNorthernEurope(null)
    },
  })

  function openRules() {
    setEditSpanish(null)
    setEditNorthernEurope(null)
    setNewNameSpanish('')
    setNewNameNorthernEurope('')
    setShowRules(true)
  }

  function saveRules() {
    if (!routingConfig) return
    saveRulesMutation.mutate({
      spanishSpeakingOwners: editSpanish ?? routingConfig.spanishSpeakingOwners,
      northernEuropeOwners: editNorthernEurope ?? routingConfig.northernEuropeOwners,
    })
  }

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
            onClick={openRules}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            <Settings size={14} />
            Rules
          </button>
          <button
            onClick={() => setShowDraft(true)}
            disabled={!preview || totalRouted === 0 || sent}
            className={clsx(
              'flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors',
              sent
                ? 'bg-green-50 text-green-700 border border-green-200 cursor-default'
                : 'bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-50'
            )}
          >
            <Send size={14} />
            {sent ? 'Sent ✓' : `Send Slack messages (${totalRouted})`}
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

      {/* Rules modal */}
      {showRules && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Routing Rules</h2>
                <p className="text-xs text-gray-500 mt-0.5">How accounts are routed to team leaders — rules apply in priority order</p>
              </div>
              <button onClick={() => setShowRules(false)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 px-6 py-4 space-y-6">
              {!routingConfig ? (
                <div className="text-center py-8 text-sm text-gray-400">Loading…</div>
              ) : (
                <>
                  {/* Routing rules list */}
                  <section>
                    <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Priority Rules</h3>
                    <div className="space-y-2">
                      {routingConfig.rules.map((rule) => (
                        <div key={rule.id} className="flex gap-3 p-3 rounded-lg border border-gray-100 bg-gray-50/50">
                          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-gray-200 text-gray-600 text-xs font-bold flex items-center justify-center">
                            {rule.id}
                          </span>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-800">{rule.description}</p>
                            <p className="text-xs text-gray-500 mt-0.5">{rule.condition}</p>
                            <p className="text-xs mt-1">
                              <span className="font-medium text-gray-700">→ {rule.route}</span>
                              {rule.suggestAna && (
                                <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-orange-50 text-orange-700 border border-orange-100">
                                  Suggest Ana Hernández
                                </span>
                              )}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  {/* Named rep sets */}
                  <section>
                    <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Named Rep Lists</h3>
                    <div className="space-y-4">
                      {/* Spanish-speaking owners */}
                      <NamedRepSet
                        label="🇪🇸 Spanish-speaking reps (Rule 1)"
                        description="Routes to Samy Benmeziane, suggests Ana Hernández"
                        names={editSpanish ?? routingConfig.spanishSpeakingOwners}
                        editing={editSpanish !== null}
                        newName={newNameSpanish}
                        onEdit={() => setEditSpanish([...routingConfig.spanishSpeakingOwners])}
                        onCancel={() => { setEditSpanish(null); setNewNameSpanish('') }}
                        onRemove={(name) => setEditSpanish((prev) => (prev ?? []).filter((n) => n !== name))}
                        onNewNameChange={setNewNameSpanish}
                        onAdd={() => {
                          const trimmed = newNameSpanish.trim()
                          if (trimmed) { setEditSpanish((prev) => [...(prev ?? []), trimmed]); setNewNameSpanish('') }
                        }}
                      />

                      {/* Northern Europe owners */}
                      <NamedRepSet
                        label="🌍 Northern Europe reps (Rule 4)"
                        description="Routes to Jo Billington"
                        names={editNorthernEurope ?? routingConfig.northernEuropeOwners}
                        editing={editNorthernEurope !== null}
                        newName={newNameNorthernEurope}
                        onEdit={() => setEditNorthernEurope([...routingConfig.northernEuropeOwners])}
                        onCancel={() => { setEditNorthernEurope(null); setNewNameNorthernEurope('') }}
                        onRemove={(name) => setEditNorthernEurope((prev) => (prev ?? []).filter((n) => n !== name))}
                        onNewNameChange={setNewNameNorthernEurope}
                        onAdd={() => {
                          const trimmed = newNameNorthernEurope.trim()
                          if (trimmed) { setEditNorthernEurope((prev) => [...(prev ?? []), trimmed]); setNewNameNorthernEurope('') }
                        }}
                      />
                    </div>
                  </section>

                  {/* Team leaders reference */}
                  <section>
                    <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Team Leaders</h3>
                    <div className="rounded-lg border border-gray-100 overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-400 uppercase">Name</th>
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-400 uppercase">Email</th>
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-400 uppercase">Region</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                          {Object.entries(routingConfig.leaders).map(([key, leader]) => (
                            <tr key={key} className="hover:bg-gray-50">
                              <td className="px-4 py-2.5">
                                <span className={clsx('inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border', LEADER_COLORS[key] ?? 'bg-gray-100 text-gray-600 border-gray-200')}>
                                  {leader.name}
                                </span>
                              </td>
                              <td className="px-4 py-2.5 text-gray-500 text-xs">{leader.email}</td>
                              <td className="px-4 py-2.5 text-gray-500 text-xs">{leader.region}</td>
                            </tr>
                          ))}
                          <tr className="hover:bg-gray-50 bg-orange-50/40">
                            <td className="px-4 py-2.5">
                              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border bg-orange-50 text-orange-700 border-orange-200">
                                {routingConfig.ana.name}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-gray-500 text-xs">{routingConfig.ana.email}</td>
                            <td className="px-4 py-2.5 text-gray-400 text-xs italic">Suggested for LATAM/Spanish</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </section>
                </>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-3">
              <p className="text-xs text-gray-400">Named rep list changes take effect on next preview refresh</p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowRules(false)}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-200 rounded-lg hover:bg-gray-50"
                >
                  Close
                </button>
                {(editSpanish !== null || editNorthernEurope !== null) && (
                  <button
                    onClick={saveRules}
                    disabled={saveRulesMutation.isPending}
                    className="flex items-center gap-2 px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
                  >
                    {saveRulesMutation.isPending ? <><RefreshCw size={14} className="animate-spin" /> Saving…</> : 'Save changes'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Draft preview modal */}
      {showDraft && preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Review messages before sending</h2>
                <p className="text-xs text-gray-500 mt-0.5">{Object.keys(preview.routedByLeader).length} Slack DMs will be sent</p>
              </div>
              <button onClick={() => setShowDraft(false)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>

            {/* Message previews */}
            <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
              {Object.entries(preview.routedByLeader).map(([leaderKey, accounts]) => {
                const anaGroup = accounts.filter((a) => a.suggestAna)
                const teamGroup = accounts.filter((a) => !a.suggestAna)
                const leader = accounts[0]
                const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
                const firstName = leader.leaderName.split(' ')[0]

                return (
                  <div key={leaderKey} className="rounded-xl border border-gray-200 overflow-hidden">
                    {/* Slack-style header */}
                    <div className={clsx(
                      'px-4 py-2.5 flex items-center gap-2 border-b border-gray-100',
                      LEADER_COLORS[leaderKey] ? 'bg-gray-50' : 'bg-gray-50'
                    )}>
                      <span className={clsx('inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border', LEADER_COLORS[leaderKey] ?? 'bg-gray-100 text-gray-600 border-gray-200')}>
                        {leader.leaderName}
                      </span>
                      <span className="text-xs text-gray-400">{leader.leaderEmail}</span>
                    </div>

                    {/* Message body */}
                    <div className="px-4 py-3 space-y-2 text-sm font-mono bg-white">
                      <p className="font-sans font-semibold text-gray-800 text-xs uppercase tracking-wide">📋 Customers to reassign — {date}</p>
                      <p className="font-sans text-gray-700">
                        Hi {firstName}! <strong>{accounts.length} customer account{accounts.length !== 1 ? 's' : ''}</strong> are owned by New Business reps and need to be moved to your team.
                      </p>

                      {anaGroup.length > 0 && (
                        <div className="pt-1">
                          <p className="font-sans font-semibold text-gray-700 text-xs mb-1">🇪🇸 Suggest assigning to Ana Hernández ({anaGroup.length})</p>
                          {anaGroup.slice(0, 5).map(({ account }) => (
                            <p key={account.id} className="text-gray-600 text-xs">
                              • <strong>{account.name}</strong> — {account.billingCountry ?? 'Unknown'} — {account.ownerName}
                            </p>
                          ))}
                          {anaGroup.length > 5 && <p className="text-xs text-gray-400 italic">…and {anaGroup.length - 5} more</p>}
                        </div>
                      )}

                      {teamGroup.length > 0 && (
                        <div className="pt-1">
                          <p className="font-sans font-semibold text-gray-700 text-xs mb-1">
                            {anaGroup.length > 0 ? `🌍 Assign to your team (${teamGroup.length})` : `Accounts to assign to your team`}
                          </p>
                          {teamGroup.slice(0, 5).map(({ account }) => (
                            <p key={account.id} className="text-gray-600 text-xs">
                              • <strong>{account.name}</strong> — {account.billingCountry ?? 'Unknown'} — {account.ownerName}
                            </p>
                          ))}
                          {teamGroup.length > 5 && <p className="text-xs text-gray-400 italic">…and {teamGroup.length - 5} more</p>}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-3">
              <p className="text-xs text-gray-400">Messages will be sent as Slack DMs from RevBot</p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowDraft(false)}
                  className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-200 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => sendMutation.mutate()}
                  disabled={sendMutation.isPending}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50"
                >
                  {sendMutation.isPending
                    ? <><RefreshCw size={14} className="animate-spin" /> Sending…</>
                    : <><Send size={14} /> Confirm &amp; Send ({Object.keys(preview.routedByLeader).length} DMs)</>
                  }
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Named rep set editor ──────────────────────────────────────────────────────

interface NamedRepSetProps {
  label: string
  description: string
  names: string[]
  editing: boolean
  newName: string
  onEdit: () => void
  onCancel: () => void
  onRemove: (name: string) => void
  onNewNameChange: (v: string) => void
  onAdd: () => void
}

function NamedRepSet({ label, description, names, editing, newName, onEdit, onCancel, onRemove, onNewNameChange, onAdd }: NamedRepSetProps) {
  return (
    <div className="rounded-lg border border-gray-100 p-4">
      <div className="flex items-start justify-between mb-2">
        <div>
          <p className="text-sm font-medium text-gray-800">{label}</p>
          <p className="text-xs text-gray-500">{description}</p>
        </div>
        {!editing
          ? <button onClick={onEdit} className="text-xs text-brand-600 hover:text-brand-700 font-medium">Edit</button>
          : <button onClick={onCancel} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
        }
      </div>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {names.map((name) => (
          <span key={name} className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-gray-100 text-gray-700 text-xs">
            {name}
            {editing && (
              <button onClick={() => onRemove(name)} className="text-gray-400 hover:text-red-500 ml-0.5">
                <Trash2 size={11} />
              </button>
            )}
          </span>
        ))}
        {names.length === 0 && <span className="text-xs text-gray-400 italic">No reps configured</span>}
      </div>
      {editing && (
        <div className="flex items-center gap-2 mt-3">
          <input
            type="text"
            value={newName}
            onChange={(e) => onNewNameChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onAdd() }}
            placeholder="Full name (must match Salesforce exactly)"
            className="flex-1 text-xs px-3 py-1.5 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
          <button
            onClick={onAdd}
            disabled={!newName.trim()}
            className="flex items-center gap-1 px-3 py-1.5 text-xs bg-gray-800 text-white rounded-lg hover:bg-gray-700 disabled:opacity-40"
          >
            <Plus size={12} /> Add
          </button>
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
