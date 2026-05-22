import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { api } from '../lib/api'
import { Plus, Pencil, Trash2, X } from 'lucide-react'
import clsx from 'clsx'

interface StallRule {
  id: string
  name: string
  enabled: boolean
  dealAgeThresholdDays: number | null
  stageDurationThresholdDays: number | null
  gongInactivityDays: number | null
  flagSingleThreaded: boolean
  flagGongRedFlags: boolean
  filterStages: string[]
  filterOppTypes: string[]
  filterSegments: string[]
}

export function StallRules() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<StallRule | 'new' | null>(null)

  const { data: rules = [], isLoading } = useQuery<StallRule[]>({
    queryKey: ['stall-rules'],
    queryFn: () => api.get('/config/stall-rules').then((r) => r.data),
  })

  const save = useMutation({
    mutationFn: (data: Partial<StallRule>) =>
      data.id ? api.put(`/config/stall-rules/${data.id}`, data) : api.post('/config/stall-rules', data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['stall-rules'] }); setEditing(null) },
  })

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/config/stall-rules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stall-rules'] }),
  })

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.put(`/config/stall-rules/${id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stall-rules'] }),
  })

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">Stall Rules</h2>
          <p className="text-sm text-gray-500 mt-1">Define when a deal is considered stalled</p>
        </div>
        <button
          onClick={() => setEditing('new')}
          className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white rounded-lg text-sm font-medium hover:bg-brand-600"
        >
          <Plus size={15} /> Add rule
        </button>
      </div>

      <div className="space-y-3">
        {isLoading && <div className="text-sm text-gray-400">Loading...</div>}
        {rules.map((rule) => (
          <div key={rule.id} className={clsx('bg-white rounded-xl border p-5', rule.enabled ? 'border-gray-200' : 'border-gray-100 opacity-60')}>
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2">
                  <span className="font-medium text-gray-900">{rule.name}</span>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) => toggle.mutate({ id: rule.id, enabled: e.target.checked })}
                      className="rounded"
                    />
                    <span className="text-xs text-gray-500">{rule.enabled ? 'Active' : 'Disabled'}</span>
                  </label>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  {rule.dealAgeThresholdDays && (
                    <Chip label={`Deal age > ${rule.dealAgeThresholdDays}d`} />
                  )}
                  {rule.stageDurationThresholdDays && (
                    <Chip label={`Stage duration > ${rule.stageDurationThresholdDays}d`} />
                  )}
                  {rule.gongInactivityDays && (
                    <Chip label={`Gong inactivity > ${rule.gongInactivityDays}d`} />
                  )}
                  {rule.flagSingleThreaded && <Chip label="Single-threaded" color="yellow" />}
                  {rule.flagGongRedFlags && <Chip label="Gong red flags" color="red" />}
                  {rule.filterStages.length > 0 && (
                    <Chip label={`Stages: ${rule.filterStages.join(', ')}`} color="blue" />
                  )}
                  {rule.filterOppTypes.length > 0 && (
                    <Chip label={`Types: ${rule.filterOppTypes.join(', ')}`} color="blue" />
                  )}
                </div>
              </div>
              <div className="flex gap-2 ml-4">
                <button onClick={() => setEditing(rule)} className="p-1.5 text-gray-400 hover:text-gray-700 rounded">
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => { if (confirm('Delete this rule?')) del.mutate(rule.id) }}
                  className="p-1.5 text-gray-400 hover:text-red-600 rounded"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <RuleModal
          rule={editing === 'new' ? undefined : editing}
          onSave={(data) => save.mutate(data)}
          onClose={() => setEditing(null)}
          saving={save.isPending}
        />
      )}
    </div>
  )
}

function Chip({ label, color = 'gray' }: { label: string; color?: string }) {
  const colors: Record<string, string> = {
    gray: 'bg-gray-100 text-gray-600',
    yellow: 'bg-yellow-100 text-yellow-700',
    red: 'bg-red-100 text-red-700',
    blue: 'bg-blue-100 text-blue-700',
  }
  return <span className={clsx('px-2 py-0.5 rounded-full font-medium', colors[color] ?? colors.gray)}>{label}</span>
}

function RuleModal({ rule, onSave, onClose, saving }: {
  rule?: StallRule
  onSave: (data: Partial<StallRule>) => void
  onClose: () => void
  saving: boolean
}) {
  const { register, handleSubmit } = useForm({
    defaultValues: {
      id: rule?.id,
      name: rule?.name ?? '',
      enabled: rule?.enabled ?? true,
      dealAgeThresholdDays: rule?.dealAgeThresholdDays ?? '',
      stageDurationThresholdDays: rule?.stageDurationThresholdDays ?? '',
      gongInactivityDays: rule?.gongInactivityDays ?? '',
      flagSingleThreaded: rule?.flagSingleThreaded ?? false,
      flagGongRedFlags: rule?.flagGongRedFlags ?? false,
      filterStages: rule?.filterStages.join(', ') ?? '',
      filterOppTypes: rule?.filterOppTypes.join(', ') ?? '',
      filterSegments: rule?.filterSegments.join(', ') ?? '',
    },
  })

  function onSubmit(values: Record<string, unknown>) {
    onSave({
      ...values,
      dealAgeThresholdDays: values.dealAgeThresholdDays ? Number(values.dealAgeThresholdDays) : null,
      stageDurationThresholdDays: values.stageDurationThresholdDays ? Number(values.stageDurationThresholdDays) : null,
      gongInactivityDays: values.gongInactivityDays ? Number(values.gongInactivityDays) : null,
      filterStages: (values.filterStages as string).split(',').map((s: string) => s.trim()).filter(Boolean),
      filterOppTypes: (values.filterOppTypes as string).split(',').map((s: string) => s.trim()).filter(Boolean),
      filterSegments: (values.filterSegments as string).split(',').map((s: string) => s.trim()).filter(Boolean),
    } as Partial<StallRule>)
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-semibold text-gray-900">{rule ? 'Edit rule' : 'New stall rule'}</h3>
          <button onClick={onClose}><X size={18} className="text-gray-400" /></button>
        </div>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Field label="Rule name">
            <input {...register('name')} required className="input" placeholder="e.g. Enterprise stall — 90 days" />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Deal age (days)">
              <input {...register('dealAgeThresholdDays')} type="number" min={1} className="input" placeholder="e.g. 90" />
            </Field>
            <Field label="Stage duration (days)">
              <input {...register('stageDurationThresholdDays')} type="number" min={1} className="input" placeholder="e.g. 30" />
            </Field>
            <Field label="Gong inactivity (days)">
              <input {...register('gongInactivityDays')} type="number" min={1} className="input" placeholder="e.g. 14" />
            </Field>
          </div>
          <div className="flex gap-6">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input {...register('flagSingleThreaded')} type="checkbox" className="rounded" />
              Flag single-threaded deals
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input {...register('flagGongRedFlags')} type="checkbox" className="rounded" />
              Flag Gong red flags
            </label>
          </div>
          <Field label="Filter: Stages (comma-separated, leave blank for all)">
            <input {...register('filterStages')} className="input" placeholder="e.g. Discovery, Proposal" />
          </Field>
          <Field label="Filter: Opp types (comma-separated)">
            <input {...register('filterOppTypes')} className="input" placeholder="e.g. New Business, Renewal" />
          </Field>
          <Field label="Filter: Segments (comma-separated)">
            <input {...register('filterSegments')} className="input" placeholder="e.g. Enterprise, Mid-Market" />
          </Field>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 bg-brand-500 text-white text-sm font-medium rounded-lg hover:bg-brand-600 disabled:opacity-50">
              {saving ? 'Saving...' : 'Save rule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  )
}
