import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useState } from 'react'
import { Pencil, Plus, X, Trash2 } from 'lucide-react'
import { useForm } from 'react-hook-form'
import clsx from 'clsx'
import { useDryRunSummary } from '../hooks/useDryRunSummary'

interface StallThreshold {
  id: string
  stageName: string
  opportunityType: string
  enabled: boolean
  stageDurationThresholdDays: number | null
  dealAgeThresholdDays: number | null
}

const OPP_TYPES = ['All', 'Initial', 'Renewal', 'Amendment']

const STAGES = [
  'Qualification',
  'Discovery',
  'Custom Demo',
  'Presentation/Proposal',
  'Decision/Negotiation',
  'Legal/Procurement',
]

export function StallConfig() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<StallThreshold | 'new' | null>(null)
  const { data: dryRunSummary } = useDryRunSummary()

  const { data: thresholds = [], isLoading } = useQuery<StallThreshold[]>({
    queryKey: ['stall-thresholds'],
    queryFn: () => api.get('/config/stall-thresholds').then((r) => r.data),
  })

  const save = useMutation({
    mutationFn: (data: Partial<StallThreshold>) =>
      data.id
        ? api.put(`/config/stall-thresholds/${data.id}`, data)
        : api.post('/config/stall-thresholds', data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['stall-thresholds'] }); setEditing(null) },
  })

  const saveMulti = useMutation({
    mutationFn: (records: Partial<StallThreshold>[]) =>
      Promise.all(records.map((r) => api.post('/config/stall-thresholds', r))),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['stall-thresholds'] }); setEditing(null) },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/config/stall-thresholds/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stall-thresholds'] }),
  })

  // Sort by STAGES order, then by opp type
  const sorted = [...thresholds].sort((a, b) => {
    const stageDiff = STAGES.indexOf(a.stageName) - STAGES.indexOf(b.stageName)
    if (stageDiff !== 0) return stageDiff
    return OPP_TYPES.indexOf(a.opportunityType) - OPP_TYPES.indexOf(b.opportunityType)
  })

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">Stall Rules</h2>
          <p className="text-sm text-gray-500 mt-1">
            Set how long a deal can sit in each stage before flagging. Uses{' '}
            <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">Stage_Duration_current__c</code> and{' '}
            <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">Opportunity_Age__c</code> from Salesforce.
          </p>
          {dryRunSummary && (dryRunSummary.byAlertType['STALLED'] ?? 0) > 0 && (
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-gray-100 text-gray-600 rounded-full text-xs font-medium mt-2">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
              {dryRunSummary.byAlertType['STALLED']} flagged in last dry run
            </div>
          )}
        </div>
        <button
          onClick={() => setEditing('new')}
          className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600"
        >
          <Plus size={15} /> Add stage
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Stage</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Opp Type</th>
              <th className="text-center px-6 py-3 text-xs font-medium text-gray-500 uppercase">Max days in stage</th>
              <th className="text-center px-6 py-3 text-xs font-medium text-gray-500 uppercase">Max total deal age</th>
              <th className="px-6 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading && (
              <tr><td colSpan={4} className="px-6 py-8 text-center text-sm text-gray-400">Loading...</td></tr>
            )}
            {sorted.map((t) => {
              const stallCount = dryRunSummary?.byStallRule[t.id] ?? 0
              return (
              <tr key={t.id} className={clsx('hover:bg-gray-50', !t.enabled && 'opacity-50')}>
                <td className="px-6 py-3 font-medium text-gray-900">
                  <div className="flex items-center gap-2">
                    {t.stageName}
                    {stallCount > 0 && (
                      <span className="text-xs px-1.5 py-0.5 rounded-full bg-orange-50 text-orange-600 font-medium">
                        {stallCount} flagged
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className={clsx(
                    'inline-flex px-2 py-0.5 rounded-full text-xs font-medium',
                    t.opportunityType === 'All' ? 'bg-gray-100 text-gray-500' :
                    t.opportunityType === 'Initial' ? 'bg-blue-50 text-blue-700' :
                    t.opportunityType === 'Renewal' ? 'bg-green-50 text-green-700' :
                    'bg-amber-50 text-amber-700'
                  )}>
                    {t.opportunityType}
                  </span>
                </td>
                <td className="px-6 py-3 text-center">
                  {t.stageDurationThresholdDays != null ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-yellow-50 text-yellow-700 text-xs font-medium">
                      {t.stageDurationThresholdDays}d
                    </span>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                <td className="px-6 py-3 text-center">
                  {t.dealAgeThresholdDays != null ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-50 text-orange-700 text-xs font-medium">
                      {t.dealAgeThresholdDays}d
                    </span>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                <td className="px-6 py-3 flex items-center gap-1 justify-end">
                  <button onClick={() => setEditing(t)} className="p-1.5 text-gray-400 hover:text-gray-700 rounded">
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => remove.mutate(t.id)} className="p-1.5 text-gray-400 hover:text-red-500 rounded">
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            )})}
          </tbody>
        </table>
        {thresholds.length === 0 && !isLoading && (
          <div className="px-6 py-8 text-center text-sm text-gray-400">
            No stall thresholds configured yet. Add your stages above. Use <strong>All</strong> as the type to apply a rule to all opportunity types, or add type-specific overrides.
          </div>
        )}
      </div>

      {editing && (
        <StallModal
          threshold={editing === 'new' ? undefined : editing}
          onSave={(d) => save.mutate(d)}
          onSaveMulti={(records) => saveMulti.mutate(records)}
          onClose={() => setEditing(null)}
          saving={save.isPending || saveMulti.isPending}
        />
      )}
    </div>
  )
}

// When editing we pass the existing threshold; when creating we allow multi-type.
// onSaveMulti is called with an array of records to create (one per type).
function StallModal({ threshold, onSave, onSaveMulti, onClose, saving }: {
  threshold?: StallThreshold
  onSave: (d: Partial<StallThreshold>) => void
  onSaveMulti: (records: Partial<StallThreshold>[]) => void
  onClose: () => void
  saving: boolean
}) {
  const isEditing = !!threshold
  const { register, handleSubmit, watch } = useForm<{
    stageName: string
    stageDurationThresholdDays: number | null
    dealAgeThresholdDays: number | null
    opportunityType: string // used only when editing
  }>({
    defaultValues: {
      stageName: threshold?.stageName ?? '',
      stageDurationThresholdDays: threshold?.stageDurationThresholdDays ?? null,
      dealAgeThresholdDays: threshold?.dealAgeThresholdDays ?? null,
      opportunityType: threshold?.opportunityType ?? 'All',
    },
  })

  // Multi-select state for new rows
  const [selectedTypes, setSelectedTypes] = useState<string[]>(
    threshold ? [threshold.opportunityType] : ['All']
  )

  function toggleType(t: string) {
    setSelectedTypes((prev) => {
      if (t === 'All') return ['All']
      const without = prev.filter((x) => x !== 'All')
      return prev.includes(t) ? (without.filter((x) => x !== t).length ? without.filter((x) => x !== t) : ['All']) : [...without, t]
    })
  }

  function onSubmit(values: { stageName: string; stageDurationThresholdDays: number | null; dealAgeThresholdDays: number | null; opportunityType: string }) {
    const base = {
      stageName: values.stageName,
      stageDurationThresholdDays: values.stageDurationThresholdDays || null,
      dealAgeThresholdDays: values.dealAgeThresholdDays || null,
      enabled: true,
    }

    if (isEditing) {
      onSave({ ...threshold, ...base, opportunityType: values.opportunityType })
    } else {
      onSaveMulti(selectedTypes.map((t) => ({ ...base, opportunityType: t })))
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
            {isEditing ? `Edit: ${threshold.stageName}` : 'Add stage threshold'}
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
              list="stage-suggestions"
              className="input w-full"
              placeholder="e.g. Discovery"
            />
            <datalist id="stage-suggestions">
              {STAGES.map((s) => <option key={s} value={s} />)}
            </datalist>
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
              Max days in current stage
            </label>
            <div className="flex items-center gap-2">
              <input
                {...register('stageDurationThresholdDays', { valueAsNumber: true })}
                type="number"
                min={1}
                className="input w-32"
                placeholder="e.g. 21"
              />
              <span className="text-sm text-gray-400">days — leave blank to skip</span>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Max total deal age
            </label>
            <div className="flex items-center gap-2">
              <input
                {...register('dealAgeThresholdDays', { valueAsNumber: true })}
                type="number"
                min={1}
                className="input w-32"
                placeholder="e.g. 90"
              />
              <span className="text-sm text-gray-400">days — leave blank to skip</span>
            </div>
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
