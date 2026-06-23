import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useState, useEffect } from 'react'
import { Save } from 'lucide-react'
import { useDryRunSummary } from '../hooks/useDryRunSummary'

export function NextStepConfig() {
  const qc = useQueryClient()
  const [bufferDays, setBufferDays] = useState<string>('')
  const [saved, setSaved] = useState(false)
  const { data: dryRunSummary } = useDryRunSummary()

  const { data: settings } = useQuery<Record<string, unknown>>({
    queryKey: ['settings'],
    queryFn: () => api.get('/config/settings').then((r) => r.data),
  })

  useEffect(() => {
    if (settings?.nextStepBufferDays != null) {
      setBufferDays(String(settings.nextStepBufferDays))
    }
  }, [settings])

  const save = useMutation({
    mutationFn: () =>
      api.put('/config/settings', { nextStepBufferDays: bufferDays === '' ? 0 : Number(bufferDays) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-2xl font-semibold text-gray-900 mb-1">Next Step</h2>
      <p className="text-sm text-gray-500 mb-3">
        Every active opportunity should have a clear next step and a date for it.
        Beacon flags reps when these are missing or overdue.
      </p>
      {dryRunSummary && (dryRunSummary.byAlertType['NEXT_STEP_MISSING'] ?? 0) > 0 && (
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-gray-100 text-gray-600 rounded-full text-xs font-medium mb-5">
          <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
          {dryRunSummary.byAlertType['NEXT_STEP_MISSING']} flagged in last dry run
        </div>
      )}

      {/* Buffer setting */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <h3 className="font-medium text-gray-900 text-sm mb-1">Grace period for overdue next step date</h3>
        <p className="text-xs text-gray-500 mb-4">
          Don't flag an overdue next step date until it's been past due for at least this many days.
          Applies to <strong>Past Due Next Step</strong> only — missing dates and missing descriptions are always flagged.
          Set to 0 to flag immediately.
        </p>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              value={bufferDays}
              onChange={(e) => setBufferDays(e.target.value)}
              className="input w-24 text-center"
              placeholder="0"
            />
            <span className="text-sm text-gray-500">days</span>
          </div>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-500 text-white text-sm font-medium rounded-lg hover:bg-brand-600 disabled:opacity-50"
          >
            <Save size={13} />
            {saved ? 'Saved!' : 'Save'}
          </button>
        </div>
        <p className="text-xs text-gray-400 mt-3">
          Example: set to <strong>7</strong> and a next step date that passed yesterday won't trigger an alert until day 8.
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">

        <div>
          <h3 className="font-medium text-gray-900 text-sm mb-3">Rules by opportunity type</h3>
          <div className="space-y-4">
            <div className="flex gap-3">
              <span className="text-lg leading-none">📝</span>
              <div>
                <p className="text-sm font-medium text-gray-800">Initial &amp; Amendment</p>
                <p className="text-sm text-gray-600 mt-0.5">
                  Both <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">NextStep</code> (description) and{' '}
                  <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">Next_Step_Date__c</code> must be filled in
                  and the date must not be in the past — always, regardless of close date.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <span className="text-lg leading-none">🔁</span>
              <div>
                <p className="text-sm font-medium text-gray-800">Renewal</p>
                <p className="text-sm text-gray-600 mt-0.5">
                  Same fields required, but only checked when the booking date is
                  within the next <strong>90 days</strong>. Renewals further out are not flagged yet.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-gray-100 pt-5">
          <h3 className="font-medium text-gray-900 text-sm mb-3">What triggers an alert</h3>
          <ul className="space-y-2 text-sm text-gray-600">
            <li className="flex gap-2">
              <span className="text-red-400 font-bold">·</span>
              <span><strong>Missing description</strong> — <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">NextStep</code> is blank</span>
            </li>
            <li className="flex gap-2">
              <span className="text-red-400 font-bold">·</span>
              <span><strong>Missing date</strong> — <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">Next_Step_Date__c</code> is not set</span>
            </li>
            <li className="flex gap-2">
              <span className="text-red-400 font-bold">·</span>
              <span><strong>Overdue date</strong> — <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">Next_Step_Date__c</code> is in the past (grace period applies)</span>
            </li>
          </ul>
        </div>

        <div className="border-t border-gray-100 pt-5">
          <h3 className="font-medium text-gray-900 text-sm mb-2">Rep experience</h3>
          <p className="text-sm text-gray-600">
            Reps receive a Slack DM with an <strong>Update Next Step</strong> button. Clicking it opens a form
            where they can enter the next step description and pick a date — both fields save directly to Salesforce.
          </p>
        </div>

        <p className="text-xs text-gray-400 pt-1">
          Alert schedule follows the global cadence set in <strong>Settings</strong>.
          Alerts respect the same snooze and cooldown rules as other checks.
        </p>

      </div>
    </div>
  )
}
