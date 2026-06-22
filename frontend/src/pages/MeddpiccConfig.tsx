import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useState } from 'react'
import { Pencil, Plus, X } from 'lucide-react'
import { useForm } from 'react-hook-form'
import clsx from 'clsx'

interface MeddpiccReq {
  id: string
  stageName: string
  opportunityType: string
  enabled: boolean
  requireMetrics: boolean
  requireEconomicBuyer: boolean
  requireDecisionCriteria: boolean
  requireDecisionProcess: boolean
  requirePaperProcess: boolean
  requireIdentifyPain: boolean
  requireChampion: boolean
  requireCompetition: boolean
  requireBudget: boolean
  requireAuthority: boolean
  requireNeed: boolean
  requireTiming: boolean
}

const MEDDPICC_FIELDS: { key: keyof MeddpiccReq; label: string; letter: string }[] = [
  { key: 'requireMetrics', label: 'Metrics', letter: 'M' },
  { key: 'requireEconomicBuyer', label: 'Economic Buyer', letter: 'E' },
  { key: 'requireDecisionCriteria', label: 'Decision Criteria', letter: 'D' },
  { key: 'requireDecisionProcess', label: 'Decision Process', letter: 'D' },
  { key: 'requirePaperProcess', label: 'Paper Process', letter: 'P' },
  { key: 'requireIdentifyPain', label: 'Identify/Implicate Pain', letter: 'I' },
  { key: 'requireChampion', label: 'Champion', letter: 'C' },
  { key: 'requireCompetition', label: 'Competition', letter: 'C' },
]

const BANT_FIELDS: { key: keyof MeddpiccReq; label: string; letter: string }[] = [
  { key: 'requireBudget', label: 'Budget', letter: 'B' },
  { key: 'requireAuthority', label: 'Authority', letter: 'A' },
  { key: 'requireNeed', label: 'Need', letter: 'N' },
  { key: 'requireTiming', label: 'Timing', letter: 'T' },
]

const OPP_TYPES = ['All', 'Initial', 'Renewal', 'Amendment']

export function MeddpiccConfig() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<MeddpiccReq | 'new' | null>(null)

  const { data: reqs = [], isLoading } = useQuery<MeddpiccReq[]>({
    queryKey: ['meddpicc'],
    queryFn: () => api.get('/config/meddpicc').then((r) => r.data),
  })

  const save = useMutation({
    mutationFn: (data: Partial<MeddpiccReq>) =>
      data.id ? api.put(`/config/meddpicc/${data.id}`, data) : api.post('/config/meddpicc', data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['meddpicc'] }); setEditing(null) },
  })

  const saveMulti = useMutation({
    mutationFn: (records: Partial<MeddpiccReq>[]) =>
      Promise.all(records.map((r) => api.post('/config/meddpicc', r))),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['meddpicc'] }); setEditing(null) },
  })

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">MEDDPICC + BANT Config</h2>
          <p className="text-sm text-gray-500 mt-1">Set which fields are required per stage</p>
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
              <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Type</th>
              <th colSpan={8} className="text-center px-2 py-3 text-xs font-medium text-gray-400 uppercase border-r border-gray-200">MEDDPICC</th>
              <th colSpan={4} className="text-center px-2 py-3 text-xs font-medium text-gray-400 uppercase">BANT</th>
              <th className="px-6 py-3" />
            </tr>
            <tr>
              <th /><th />
              {MEDDPICC_FIELDS.map((f) => (
                <th key={f.key} className="text-center px-2 py-2 text-xs font-medium text-gray-500 uppercase" title={f.label}>
                  {f.letter}
                </th>
              ))}
              {BANT_FIELDS.map((f) => (
                <th key={f.key} className="text-center px-2 py-2 text-xs font-medium text-purple-500 uppercase" title={f.label}>
                  {f.letter}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading && (
              <tr><td colSpan={15} className="px-6 py-8 text-center text-sm text-gray-400">Loading...</td></tr>
            )}
            {reqs.map((req) => (
              <tr key={req.id} className={clsx('hover:bg-gray-50', !req.enabled && 'opacity-50')}>
                <td className="px-6 py-3 font-medium text-gray-900">{req.stageName}</td>
                <td className="px-4 py-3">
                  <span className={clsx(
                    'inline-flex px-2 py-0.5 rounded-full text-xs font-medium',
                    req.opportunityType === 'All' ? 'bg-gray-100 text-gray-500' :
                    req.opportunityType === 'Initial' ? 'bg-blue-50 text-blue-700' :
                    req.opportunityType === 'Renewal' ? 'bg-green-50 text-green-700' :
                    'bg-amber-50 text-amber-700'
                  )}>
                    {req.opportunityType ?? 'All'}
                  </span>
                </td>
                {MEDDPICC_FIELDS.map((f) => (
                  <td key={f.key} className="text-center px-2 py-3">
                    {req[f.key] ? (
                      <span className="inline-block w-4 h-4 rounded-full bg-brand-500" title={`${f.label} required`} />
                    ) : (
                      <span className="inline-block w-4 h-4 rounded-full bg-gray-100" />
                    )}
                  </td>
                ))}
                {BANT_FIELDS.map((f) => (
                  <td key={f.key} className="text-center px-2 py-3">
                    {req[f.key] ? (
                      <span className="inline-block w-4 h-4 rounded-full bg-purple-400" title={`${f.label} required`} />
                    ) : (
                      <span className="inline-block w-4 h-4 rounded-full bg-gray-100" />
                    )}
                  </td>
                ))}
                <td className="px-6 py-3">
                  <button onClick={() => setEditing(req)} className="p-1.5 text-gray-400 hover:text-gray-700 rounded">
                    <Pencil size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {reqs.length === 0 && !isLoading && (
          <div className="px-6 py-8 text-center text-sm text-gray-400">
            No stages configured. Add your Salesforce stages above.
          </div>
        )}
      </div>

      {editing && (
        <StageModal
          req={editing === 'new' ? undefined : editing}
          onSave={(d) => save.mutate(d)}
          onSaveMulti={(records) => saveMulti.mutate(records)}
          onClose={() => setEditing(null)}
          saving={save.isPending || saveMulti.isPending}
        />
      )}
    </div>
  )
}

const TYPE_COLORS: Record<string, string> = {
  All: 'bg-gray-100 text-gray-600 border-gray-200',
  'Initial': 'bg-blue-50 text-blue-700 border-blue-200',
  Renewal: 'bg-green-50 text-green-700 border-green-200',
  Amendment: 'bg-amber-50 text-amber-700 border-amber-200',
}

function StageModal({ req, onSave, onSaveMulti, onClose, saving }: {
  req?: MeddpiccReq
  onSave: (d: Partial<MeddpiccReq>) => void
  onSaveMulti: (records: Partial<MeddpiccReq>[]) => void
  onClose: () => void
  saving: boolean
}) {
  const isEditing = !!req
  const { register, handleSubmit } = useForm<Partial<MeddpiccReq>>({
    defaultValues: req ?? { enabled: true },
  })

  const [selectedTypes, setSelectedTypes] = useState<string[]>(
    req ? [req.opportunityType] : ['All']
  )

  function toggleType(t: string) {
    setSelectedTypes((prev) => {
      if (t === 'All') return ['All']
      const without = prev.filter((x) => x !== 'All')
      const next = prev.includes(t) ? without.filter((x) => x !== t) : [...without, t]
      return next.length ? next : ['All']
    })
  }

  function onSubmit(values: Partial<MeddpiccReq>) {
    if (isEditing) {
      onSave(values)
    } else {
      onSaveMulti(selectedTypes.map((t) => ({ ...values, opportunityType: t })))
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-semibold text-gray-900">{req ? `Edit: ${req.stageName}` : 'New stage'}</h3>
          <button onClick={onClose}><X size={18} className="text-gray-400" /></button>
        </div>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Stage name (must match SFDC exactly)</label>
            <input {...register('stageName')} required className="input w-full" placeholder="e.g. Stage 3 - Proposal" />
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
                          ? TYPE_COLORS[t] + ' ring-2 ring-offset-1 ring-current'
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
            <label className="block text-xs font-medium text-gray-600 mb-2">Required MEDDPICC fields at this stage</label>
            <div className="space-y-1">
              {MEDDPICC_FIELDS.map((f) => (
                <label key={f.key} className="flex items-center gap-3 cursor-pointer p-2 rounded-lg hover:bg-gray-50">
                  <input {...register(f.key)} type="checkbox" className="rounded" />
                  <span className="text-sm">{f.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-2">Required BANT fields at this stage</label>
            <div className="space-y-1">
              {BANT_FIELDS.map((f) => (
                <label key={f.key} className="flex items-center gap-3 cursor-pointer p-2 rounded-lg hover:bg-gray-50">
                  <input {...register(f.key)} type="checkbox" className="rounded" />
                  <span className="text-sm">{f.label}</span>
                </label>
              ))}
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
