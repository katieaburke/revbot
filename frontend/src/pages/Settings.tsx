import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useForm } from 'react-hook-form'
import { useEffect } from 'react'

interface AppSettings {
  alertCron: string
  cooldownHours: number
  snoozeDays: number
  sfdcInstanceUrl: string
}

export function Settings() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: () => api.get('/config/settings').then((r) => r.data),
  })

  const { register, handleSubmit, reset } = useForm<AppSettings>()

  useEffect(() => {
    if (data) reset(data)
  }, [data, reset])

  const save = useMutation({
    mutationFn: (d: AppSettings) => api.put('/config/settings', d),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  })

  if (isLoading) return <div className="p-8 text-sm text-gray-400">Loading...</div>

  return (
    <div className="p-8 max-w-xl">
      <h2 className="text-2xl font-semibold text-gray-900 mb-1">Settings</h2>
      <p className="text-sm text-gray-500 mb-8">Global configuration for alert scheduling and behavior</p>

      <form onSubmit={handleSubmit((d) => save.mutate(d))} className="space-y-6">
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <h3 className="font-medium text-gray-900 text-sm">Alert Schedule</h3>

          <Field label="Cron expression" hint="When to run the alert check (default: Mon–Fri 8am)">
            <input {...register('alertCron')} className="input w-full" placeholder="0 8 * * 1-5" />
          </Field>

          <Field label="Cooldown (hours)" hint="Minimum hours before re-notifying for the same opp+type">
            <input {...register('cooldownHours', { valueAsNumber: true })} type="number" min={1} className="input w-40" />
          </Field>

          <Field label="Default snooze (days)" hint="How many days the snooze button suppresses a notification">
            <input {...register('snoozeDays', { valueAsNumber: true })} type="number" min={1} className="input w-40" />
          </Field>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          <h3 className="font-medium text-gray-900 text-sm">Salesforce</h3>
          <Field label="Instance URL" hint="Used to generate deep links in Slack messages">
            <input {...register('sfdcInstanceUrl')} className="input w-full" placeholder="https://yourorg.lightning.force.com" />
          </Field>
        </div>

        {save.isSuccess && (
          <div className="px-4 py-2 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
            ✅ Settings saved
          </div>
        )}

        <button
          type="submit"
          disabled={save.isPending}
          className="px-5 py-2 bg-brand-500 text-white text-sm font-medium rounded-lg hover:bg-brand-600 disabled:opacity-50"
        >
          {save.isPending ? 'Saving...' : 'Save settings'}
        </button>
      </form>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-0.5">{label}</label>
      {hint && <p className="text-xs text-gray-400 mb-1.5">{hint}</p>}
      {children}
    </div>
  )
}
