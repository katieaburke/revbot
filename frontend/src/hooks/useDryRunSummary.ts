import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'

interface DryRunSummary {
  timestamp: string
  totalOpportunities: number
  byAlertType: Record<string, number>
  byStallRule: Record<string, number>
  byStageMismatchRule: Record<string, number>
}

export function useDryRunSummary() {
  return useQuery<DryRunSummary | null>({
    queryKey: ['last-dry-run-summary'],
    queryFn: () => api.get('/config/last-dry-run-summary').then((r) => r.data),
    staleTime: 30_000,
  })
}
