import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useForm } from 'react-hook-form'
import { useEffect, useState } from 'react'
import { RefreshCw, Copy, CheckCircle, FlaskConical, X } from 'lucide-react'

interface AppSettings {
  alertCron: string
  cooldownHours: number
  snoozeDays: number
  sfdcInstanceUrl: string
  extensionApiKey?: string
  slackTestRecipient?: string
}

export function Settings() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: () => api.get('/config/settings').then((r) => r.data),
  })

  const [copied, setCopied] = useState(false)
  const [sfdcConnected, setSfdcConnected] = useState(false)

  const { data: sfdcStatus } = useQuery<{ connected: boolean }>({
    queryKey: ['sfdc-status'],
    queryFn: () => api.get('/config/sfdc-status').then((r) => r.data),
  })
  const isConnected = sfdcConnected || !!sfdcStatus?.connected

  function connectSalesforce() {
    const popup = window.open(
      `${import.meta.env.VITE_API_URL ?? 'http://localhost:3001'}/auth/sfdc/admin-start`,
      'sfdc-connect',
      'width=600,height=700'
    )

    // Listen for postMessage from the popup
    const handler = (e: MessageEvent) => {
      if (e.data === 'sfdc-connected') {
        setSfdcConnected(true)
        window.removeEventListener('message', handler)
        popup?.close()
      }
    }
    window.addEventListener('message', handler)

    // Also poll for popup close — if user manually closes it, check connection status
    const poll = setInterval(async () => {
      if (popup?.closed) {
        clearInterval(poll)
        window.removeEventListener('message', handler)
        try {
          const res = await api.get('/config/sfdc-status')
          if (res.data?.connected) setSfdcConnected(true)
        } catch { /* ignore */ }
      }
    }, 500)
  }
  const { register, handleSubmit, reset } = useForm<AppSettings>()

  useEffect(() => {
    if (data) reset(data)
  }, [data, reset])

  const save = useMutation({
    mutationFn: (d: AppSettings) => api.put('/config/settings', d),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  })

  const [testEmail, setTestEmail] = useState('')
  const isTestModeOn = !!data?.slackTestRecipient

  const enableTestMode = useMutation({
    mutationFn: (email: string) => api.put('/config/settings', { slackTestRecipient: email }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings'] }); setTestEmail('') },
  })

  const disableTestMode = useMutation({
    mutationFn: () => api.put('/config/settings', { slackTestRecipient: '' }),
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
            <input {...register('sfdcInstanceUrl')} className="input w-full" placeholder="https://uberall.lightning.force.com/" />
          </Field>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-0.5">RevOps connection</label>
            <p className="text-xs text-gray-400 mb-2">Connect your Salesforce account so the app can read pipeline data for dry runs and alert evaluation.</p>
            {isConnected ? (
              <div className="flex items-center gap-2 text-sm text-green-600">
                <CheckCircle size={15} /> Salesforce connected successfully!
              </div>
            ) : (
              <button
                type="button"
                onClick={connectSalesforce}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
              >
                Connect Salesforce
              </button>
            )}
          </div>
        </div>

        {/* ── Test Mode ───────────────────────────────────────────── */}
        <div className={`rounded-xl border p-6 space-y-4 ${isTestModeOn ? 'bg-amber-50 border-amber-300' : 'bg-white border-gray-200'}`}>
          <div className="flex items-center gap-2">
            <FlaskConical size={16} className={isTestModeOn ? 'text-amber-600' : 'text-gray-400'} />
            <h3 className="font-medium text-gray-900 text-sm">Test mode</h3>
            {isTestModeOn && (
              <span className="ml-auto text-xs font-medium px-2 py-0.5 rounded-full bg-amber-200 text-amber-800">
                Active
              </span>
            )}
          </div>

          {isTestModeOn ? (
            <div className="space-y-3">
              <p className="text-sm text-amber-800">
                All Slack alerts are being sent to <strong>{data.slackTestRecipient}</strong> instead of the actual rep.
                Each message includes a banner so you can see who the real recipient would be.
              </p>
              <button
                type="button"
                onClick={() => disableTestMode.mutate()}
                disabled={disableTestMode.isPending}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-amber-300 text-amber-800 text-sm font-medium rounded-lg hover:bg-amber-100 disabled:opacity-50"
              >
                <X size={13} />
                {disableTestMode.isPending ? 'Disabling...' : 'Disable test mode — send to real reps'}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-gray-500">
                Route all Slack alerts to one email address for testing. A banner will note who the real recipient would be.
                Flip it off when you're ready to go live.
              </p>
              <div className="flex gap-2">
                <input
                  type="email"
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  className="input flex-1"
                  placeholder="e.g. katie.burke@uberall.com"
                />
                <button
                  type="button"
                  onClick={() => enableTestMode.mutate(testEmail)}
                  disabled={!testEmail || enableTestMode.isPending}
                  className="px-4 py-2 bg-amber-500 text-white text-sm font-medium rounded-lg hover:bg-amber-600 disabled:opacity-50"
                >
                  {enableTestMode.isPending ? 'Saving...' : 'Enable'}
                </button>
              </div>
            </div>
          )}
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

      {/* Chrome Extension API Key */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4 mt-6">
        <h3 className="font-medium text-gray-900 text-sm">Chrome Extension</h3>
        <p className="text-xs text-gray-500">
          Generate an API key and paste it into the Beacon Chrome extension settings.
        </p>
        {data?.extensionApiKey ? (
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-gray-50 border border-gray-200 rounded px-3 py-2 text-xs font-mono truncate">
              {data.extensionApiKey}
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(data.extensionApiKey!)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              }}
              className="p-2 text-gray-400 hover:text-gray-700 rounded-lg border border-gray-200"
              title="Copy"
            >
              <Copy size={14} />
            </button>
            {copied && <span className="text-xs text-green-600">Copied!</span>}
          </div>
        ) : null}
        <button
          onClick={async () => {
            await api.post('/config/settings/generate-extension-key')
            qc.invalidateQueries({ queryKey: ['settings'] })
          }}
          className="flex items-center gap-2 px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50"
        >
          <RefreshCw size={13} />
          {data?.extensionApiKey ? 'Regenerate key' : 'Generate key'}
        </button>
      </div>
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
