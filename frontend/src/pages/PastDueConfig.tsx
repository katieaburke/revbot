import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useState, useEffect } from 'react'
import { Save } from 'lucide-react'
import { useDryRunSummary } from '../hooks/useDryRunSummary'

export function PastDueConfig() {
  const qc = useQueryClient()
  const [bufferDays, setBufferDays] = useState<string>('')
  const [saved, setSaved] = useState(false)
  const { data: dryRunSummary } = useDryRunSummary()

  const { data: settings } = useQuery<Record<string, unknown>>({
    queryKey: ['settings'],
    queryFn: () => api.get('/config/settings').then((r) => r.data),
  })

  useEffect(() => {
    if (settings?.pastDueBufferDays != null) {
      setBufferDays(String(settings.pastDueBufferDays))
    }
  }, [settings])

  const save = useMutation({
    mutationFn: () =>
      api.put('/config/settings', { pastDueBufferDays: bufferDays === '' ? 0 : Number(bufferDays) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    },
  })

  const pastDueCount =
    (dryRunSummary?.byAlertType['PAST_DUE_INITIAL'] ?? 0) +
    (dryRunSummary?.byAlertType['PAST_DUE_AMENDMENT'] ?? 0) +
    (dryRunSummary?.byAlertType['PAST_DUE_RENEWAL'] ?? 0)

  return (
    <div className="p-8 max-w-2xl">
      <h2 className="text-2xl font-semibold text-gray-900 mb-1">Past Due</h2>
      <p className="text-sm text-gray-500 mb-3">
        Opportunities with a Booking Date in the past that haven't been closed.
      </p>
      {dryRunSummary && pastDueCount > 0 && (
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-gray-100 text-gray-600 rounded-full text-xs font-medium mb-5">
          <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
          {pastDueCount} flagged in last dry run
        </div>
      )}

      {/* Buffer setting */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <h3 className="font-medium text-gray-900 text-sm mb-1">Grace period</h3>
        <p className="text-xs text-gray-500 mb-4">
          Don't flag an opp until it's been past due for at least this many days.
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
          Example: set to <strong>7</strong> and an opp that went past its booking date yesterday won't be flagged until day 8.
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h3 className="font-medium text-gray-900 text-sm">How it works</h3>
        <ul className="space-y-3 text-sm text-gray-600">
          <li className="flex gap-3">
            <span className="text-lg leading-none">📅</span>
            <span><strong>Initial / Amendment</strong> — rep is asked to update the close date in Salesforce.</span>
          </li>
          <li className="flex gap-3">
            <span className="text-lg leading-none">🔁</span>
            <span><strong>Renewal</strong> — rep is asked to close the renewal. If the account auto-renewed, they should close at the flat amount and open a separate amendment for any growth still in progress.</span>
          </li>
        </ul>
        <p className="text-xs text-gray-400 pt-2">
          Past due detection uses <code className="bg-gray-100 px-1 py-0.5 rounded">Booking_Date__c</code> from Salesforce.
          Opportunities without this field set are skipped.
        </p>
      </div>
    </div>
  )
}
