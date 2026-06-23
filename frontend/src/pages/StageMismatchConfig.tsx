import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useState } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import clsx from 'clsx'

interface StageMismatchRule {
  id: string
  name: string
  keywords: string[]
  stages: string[]
  enabled: boolean
}

const ALL_STAGES = [
  'Qualification',
  'Discovery',
  'Custom Demo',
  'Presentation/Proposal',
  'Decision/Negotiation',
  'Legal/Procurement',
]

export function StageMismatchConfig() {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)

  const { data: rules = [], isLoading } = useQuery<StageMismatchRule[]>({
    queryKey: ['stage-mismatch-rules'],
    queryFn: () => api.get('/config/stage-mismatch-rules').then((r) => r.data),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/config/stage-mismatch-rules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stage-mismatch-rules'] }),
  })

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled, name, keywords, stages }: StageMismatchRule) =>
      api.put(`/config/stage-mismatch-rules/${id}`, { name, keywords, stages, enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stage-mismatch-rules'] }),
  })

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">Stage Mismatch</h2>
          <p className="text-sm text-gray-500 mt-1">
            Flag opportunities whose Next Step text contains keywords that suggest a more advanced
            stage than the current Salesforce stage.
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600"
        >
          <Plus size={15} /> Add rule
        </button>
      </div>

      <div className="space-y-3">
        {isLoading && (
          <div className="text-sm text-gray-400 py-8 text-center">Loading...</div>
        )}
        {rules.map((rule) => (
          <div
            key={rule.id}
            className={clsx(
              'bg-white rounded-xl border border-gray-200 p-5 flex items-start justify-between gap-4',
              !rule.enabled && 'opacity-60'
            )}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-medium text-gray-900">{rule.name}</span>
                {!rule.enabled && (
                  <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                    Disabled
                  </span>
                )}
              </div>
              <div className="mb-2">
                <span className="text-xs font-medium text-gray-500 uppercase tracking-wider mr-2">
                  Keywords:
                </span>
                <span className="flex flex-wrap gap-1 mt-1">
                  {rule.keywords.map((kw) => (
                    <span
                      key={kw}
                      className="inline-block px-2 py-0.5 bg-violet-50 text-violet-700 rounded-full text-xs font-medium"
                    >
                      {kw}
                    </span>
                  ))}
                </span>
              </div>
              <div>
                <span className="text-xs font-medium text-gray-500 uppercase tracking-wider mr-2">
                  Applies to stages:
                </span>
                <span className="flex flex-wrap gap-1 mt-1">
                  {rule.stages.map((s) => (
                    <span
                      key={s}
                      className="inline-block px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full text-xs font-medium"
                    >
                      {s}
                    </span>
                  ))}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => toggleEnabled.mutate({ ...rule, enabled: !rule.enabled })}
                className={clsx(
                  'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none',
                  rule.enabled ? 'bg-brand-500' : 'bg-gray-200'
                )}
                title={rule.enabled ? 'Disable rule' : 'Enable rule'}
              >
                <span
                  className={clsx(
                    'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform',
                    rule.enabled ? 'translate-x-4' : 'translate-x-0'
                  )}
                />
              </button>
              <button
                onClick={() => remove.mutate(rule.id)}
                className="p-1.5 text-gray-400 hover:text-red-500 rounded"
                title="Delete rule"
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        ))}
        {rules.length === 0 && !isLoading && (
          <div className="bg-white rounded-xl border border-gray-200 px-6 py-10 text-center text-sm text-gray-400">
            No stage mismatch rules configured yet. Add a rule to start flagging deals whose next
            step text suggests a more advanced stage.
          </div>
        )}
      </div>

      <div className="mt-4 p-4 bg-violet-50 rounded-xl border border-violet-100 text-sm text-violet-700">
        <strong>How it works:</strong> For each rule, if an opportunity is in one of the specified{' '}
        <em>stages</em> and its Next Step contains any of the <em>keywords</em>, the rep receives
        a Slack alert prompting them to advance the stage.
      </div>

      {showForm && (
        <AddRuleModal
          onClose={() => setShowForm(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['stage-mismatch-rules'] })
            setShowForm(false)
          }}
        />
      )}
    </div>
  )
}

function AddRuleModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [keywordsRaw, setKeywordsRaw] = useState('')
  const [selectedStages, setSelectedStages] = useState<string[]>([])
  const [enabled, setEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleStage(stage: string) {
    setSelectedStages((prev) =>
      prev.includes(stage) ? prev.filter((s) => s !== stage) : [...prev, stage]
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const keywords = keywordsRaw
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
    if (!name.trim()) { setError('Rule name is required'); return }
    if (keywords.length === 0) { setError('At least one keyword is required'); return }
    if (selectedStages.length === 0) { setError('Select at least one stage'); return }

    setSaving(true)
    setError(null)
    try {
      await api.post('/config/stage-mismatch-rules', { name: name.trim(), keywords, stages: selectedStages, enabled })
      onSaved()
    } catch (err: any) {
      setError(err?.response?.data?.error ?? String(err))
      setSaving(false)
    }
  }

  const keywords = keywordsRaw
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-semibold text-gray-900">Add stage mismatch rule</h3>
          <button onClick={onClose}><X size={18} className="text-gray-400" /></button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Rule name */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Rule name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input w-full"
              placeholder="e.g. Proposal keyword in Qualification"
            />
          </div>

          {/* Keywords */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Keywords{' '}
              <span className="text-gray-400 font-normal">— comma-separated, case-insensitive</span>
            </label>
            <input
              value={keywordsRaw}
              onChange={(e) => setKeywordsRaw(e.target.value)}
              className="input w-full"
              placeholder="e.g. proposal, pricing, contract, signature"
            />
            {keywords.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {keywords.map((kw) => (
                  <span
                    key={kw}
                    className="inline-block px-2 py-0.5 bg-violet-50 text-violet-700 rounded-full text-xs font-medium"
                  >
                    {kw}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Stages */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Alert when opportunity is in these stages
            </label>
            <div className="flex flex-wrap gap-2">
              {ALL_STAGES.map((stage) => {
                const active = selectedStages.includes(stage)
                return (
                  <button
                    key={stage}
                    type="button"
                    onClick={() => toggleStage(stage)}
                    className={clsx(
                      'px-3 py-1.5 rounded-lg text-xs font-medium border transition-all',
                      active
                        ? 'bg-violet-50 text-violet-700 border-violet-300 ring-2 ring-offset-1 ring-violet-400'
                        : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300'
                    )}
                  >
                    {stage}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Enabled toggle */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setEnabled((e) => !e)}
              className={clsx(
                'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                enabled ? 'bg-brand-500' : 'bg-gray-200'
              )}
            >
              <span
                className={clsx(
                  'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform',
                  enabled ? 'translate-x-4' : 'translate-x-0'
                )}
              />
            </button>
            <span className="text-sm text-gray-600">{enabled ? 'Enabled' : 'Disabled'}</span>
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-brand-500 text-white text-sm font-medium rounded-lg hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Add rule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
