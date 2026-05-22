import type { DealHealthResponse } from './types'
import { getSettings } from './storage'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const settings = await getSettings()
  if (!settings?.apiUrl || !settings?.apiKey) {
    throw new Error('Extension not configured')
  }

  const res = await fetch(`${settings.apiUrl.replace(/\/$/, '')}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Extension-Key': settings.apiKey,
      ...options?.headers,
    },
  })

  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${await res.text()}`)
  }

  return res.json() as Promise<T>
}

export async function fetchDealHealth(opportunityId: string): Promise<DealHealthResponse> {
  return request<DealHealthResponse>(`/api/extension/deal-health/${opportunityId}`)
}

export async function nudgeOwner(payload: {
  opportunityId: string
  opportunityName: string
  targetUserSlackId: string
  alertType: string
  customMessage?: string
  senderEmail: string
}): Promise<{ ok: boolean }> {
  return request('/api/extension/nudge', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
