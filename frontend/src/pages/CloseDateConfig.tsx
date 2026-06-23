import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useState } from 'react'
import { Pencil, Plus, X, Trash2 } from 'lucide-react'
import { useForm } from 'react-hook-form'
import clsx from 'clsx'
import { useDryRunSummary } from '../hooks/useDryRunSummary'

interface CloseDateRiskRule {
  id: string
  stageName: string
  opportunityType: string
  daysThreshold: number
  enabled: boolean
}

const OPP_TYPES = ['All', 'Initial', 'Renewal', 'Amendment']

export function CloseDateConfig() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<CloseDateRiskRule | 'new' | null>(null)
  const { data: dryRunSummary } = useDryRunSummary()

  const { data: rules = [], isLoading } = useQuery<CloseDateRiskRule[]>({
    queryKey: ['close-date-risk'],
    queryFn: () => api.get('/config/close-date-risk').then((r) => r.data),
  })

  const save = useMutation({
    mutationFn: (data: Partial<CloseDateRiskRule>) =>
      data.id
        ? api.put(`/config/close-date-risk/${data.id}`, data)
        : api.post('/config/close-date-risk', data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['close-date-risk'] }); setEditing(null) },
  })

  const saveMulti = useMutation({
    mutationFn: (records: Partial<CloseDateRiskRule>[]) =>
      Promise.all(records.map((r) => api.post('/config/close-date-risk', r))),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['close-date-risk'] }); setEditing(null) },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/config/close-date-risk/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['close-date-risk'] }),
  })

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">Close Date Risk</h2>
          <p className="text-sm text-gray-500 mt-1">
            Flag deals whose close date is approaching but are still in an early stage.
            Set the maximum number of days before close date that triggers an alert, per stage and opportunity type.
          </p>
          {dryRunSummary && (dryRunSummary.byAlertType['CLOSE_DATE_RISK'] ?? 0) > 0 && (
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-gray-100 text-gray-600 rounded-full text-xs font-medium mt-2">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
              {dryRunSummary.byAlertType['CLOSE_DATE_RISK']} flagged in last dry run
            </div>
          )}
        </div>
        <button
          onClick={() => setEditing('new')}
          className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600"
        >
          <Plus size={15} /> Add rule
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Stage</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Opp Type</th>
              <th className="text-center px-6 py-3 text-xs font-medium text-gray-500 uppercase">Alert if close date within</th>
              <th className="px-6 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading && (
              <tr><td colSpan={4} className="px-6 py-8 text-center text-sm text-gray-400">Loading...</td></tr>
            )}
            {rules.map((rule) => (
              <tr key={rule.id} className={clsx('hover:bg-gray-50', !rule.enabled && 'opacity-50')}>
                <td className="px-6 py-3 font-medium text-gray-900">{rule.stageName}</td>
                <td className="px-4 py-3">
                  <span className={clsx(
                    'inline-flex px-2 py-0.5 rounded-full text-xs font-medium',
                    rule.opportunityType === 'All' ? 'bg-gray-100 text-gray-500' :
                    rule.opportunityType === 'Initial' ? 'bg-blue-50 text-blue-700' :
                    rule.opportunityType === 'Renewal' ? 'bg-green-50 text-green-700' :
                    'bg-amber-50 text-amber-700'
                  )}>
                    {rule.opportunityType}
                  </span>
                </td>
                <td className="px-6 py-3 text-center">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 text-xs font-medium">
                    {rule.daysThreshold}d
                  </span>
                </td>
                <td className="px-6 py-3 flex items-center gap-1 justify-end">
                  <button onClick={() => setEditing(rule)} className="p-1.5 text-gray-400 hover:text-gray-700 rounded">
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => remove.mutate(rule.id)} className="p-1.5 text-gray-400 hover:text-red-500 rounded">
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rules.length === 0 && !isLoading && (
          <div className="px-6 py-8 text-center text-sm text-gray-400">
            No close date risk rules configured yet. Add a rule to start flagging deals whose
            close date is too soon for their current stage.
          </div>
        )}
      </div>

      <div className="mt-4 p-4 bg-rose-50 rounded-xl border border-rose-100 text-sm text-rose-700">
        <strong>How it works:</strong> If a deal's close date is within <em>X days</em> and it's still in the specified stage,
        the rep gets a Slack alert asking them to update the stage or push the close date.
        Rules match by stage + opp type; a rule set to <strong>All</strong> applies to every opp type in that stage unless a more specific rule exists.
      </div>

      {editing && (
        <CloseDateModal
          rule={editing === 'new' ? undefined : editing}
          onSave={(d) => save.mutate(d)}
          onSaveMulti={(records) => saveMulti.mutate(records)}
          onClose={() => setEditing(null)}
          saving={save.isPending || saveMulti.isPending}
        />
      )}
    </div>
  )
}

function CloseDateModal({ rule, onSave, onSaveMulti, onClose, saving }: {
  rule?: CloseDateRiskRule
  onSave: (d: Partial<CloseDateRiskRule>) => void
  onSaveMulti: (records: Partial<CloseDateRiskRule>[]) => void
  onClose: () => void
  saving: boolean
}) {
  const isEditing = !!rule
  const { register, handleSubmit } = useForm<Partial<CloseDateRiskRule>>({
    defaultValues: rule ?? { enabled: true },
  })

  const [selectedTypes, setSelectedTypes] = useState<string[]>(
    rule ? [rule.opportunityType] : ['All']
  )

  function toggleType(t: string) {
    setSelectedTypes((prev) => {
      if (t === 'All') return ['All']
      const without = prev.filter((x) => x !== 'All')
      const next = prev.includes(t) ? without.filter((x) => x !== t) : [...without, t]
      return next.length ? next : ['All']
    })
  }

  function onSubmit(values: Partial<CloseDateRiskRule>) {
    if (isEditing) {
      onSave(values)
    } else {
      onSaveMulti(selectedTypes.map((t) => ({ ...values, opportunityType: t })))
    }
  }

  const typeColors: Record<string, string> = {
    All: 'bg-gray-100 text-gray-600 border-gray-200',
    'Initial': 'bg-blue-50 text-blue-700 border-blue-200',
    Renewal: 'bg-green-50 text-green-700 border-green-200',
    Amendment: 'bg-amber-50 text-amber-700 border-amber-200',
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-semibold text-gray-900">
            {isEditing ? `Edit: ${rule.stageName}` : 'Add close date risk rule'}
          </h3>
          <button onClick={onClose}><X size={18} className="text-gray-400" /></button>
        </div>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Stage name (must match SFDC exactly)
            </label>
            <input
              {...register('stageName')}
              required
              className="input w-full"
              placeholder="e.g. Qualification"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Opportunity type{!isEditing && <span className="text-gray-400 font-normal ml-1">— select one or more</span>}
            </label>
            {isEditing ? (
              <select {...register('opportunityType')} className="input w-full">
                {OPP_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            ) : (
              <div className="flex flex-wrap gap-2">
                {OPP_TYPES.map((t) => {
                  const active = selectedTypes.includes(t)
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggleType(t)}
                      className={clsx(
                        'px-3 py-1.5 rounded-lg text-xs font-medium border transition-all',
                        active
                          ? typeColors[t] + ' ring-2 ring-offset-1 ring-current'
                          : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300'
                      )}
                    >
                      {t}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Alert if close date is within
            </label>
            <div className="flex items-center gap-2">
              <input
                {...register('daysThreshold', { valueAsNumber: true })}
                type="number"
                min={1}
                required
                className="input w-28"
                placeholder="e.g. 30"
              />
              <span className="text-sm text-gray-500">days of today</span>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              e.g. 30 = flag any deal in this stage closing within 30 days
            </p>
          </div>

          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
            <button
              type="submit"
              disabled={saving || (!isEditing && selectedTypes.length === 0)}
              className="px-4 py-2 bg-brand-500 text-white text-sm font-medium rounded-lg hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Saving...' : isEditing ? 'Save' : `Add${selectedTypes.length > 1 ? ` ${selectedTypes.length} rules` : ''}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
