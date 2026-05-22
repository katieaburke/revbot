import axios from 'axios'
import { config } from '../config'

const GONG_BASE = 'https://api.gong.io/v2'

const client = axios.create({
  baseURL: GONG_BASE,
  auth: {
    username: config.GONG_ACCESS_KEY,
    password: config.GONG_ACCESS_SECRET,
  },
  headers: { 'Content-Type': 'application/json' },
})

export interface GongDeal {
  crm_id: string // SFDC Opportunity ID
  title: string
  stage: string
  close_date: string
  amount: number
  warnings: GongWarning[]
  last_interaction_time?: string
  next_action_due_date?: string
  contacts: GongContact[]
}

export interface GongWarning {
  type: string // 'single-threaded', 'long-time-in-stage', 'no-next-step', 'red-flag', etc.
  description: string
  severity: 'low' | 'medium' | 'high'
}

export interface GongContact {
  crm_id: string
  name: string
  title: string
  email: string
}

export interface GongActivity {
  crm_id: string // SFDC Opportunity ID
  last_call_date?: string
  last_email_date?: string
  total_calls: number
  total_emails: number
  unique_contact_count: number
}

// Fetch deal boards/forecast data for all open deals
export async function fetchGongDeals(): Promise<GongDeal[]> {
  try {
    const response = await client.post('/deals', {
      filter: {
        forcastingCategories: ['pipeline', 'best_case', 'commit'],
      },
      pagination: { cursor: null },
    })
    return response.data?.deals ?? []
  } catch (err) {
    console.error('Gong fetchDeals error:', err)
    return []
  }
}

// Get activity summary keyed by SFDC opportunity ID
export async function fetchGongActivityBySfdcId(
  sfdcIds: string[]
): Promise<Map<string, GongActivity>> {
  if (sfdcIds.length === 0) return new Map()

  try {
    const response = await client.post('/deals/activity', {
      filter: { crmIds: sfdcIds },
    })

    const activities: GongActivity[] = response.data?.activities ?? []
    return new Map(activities.map((a) => [a.crm_id, a]))
  } catch (err) {
    console.error('Gong fetchActivity error:', err)
    return new Map()
  }
}

// Get warnings (red flags, single-threaded, etc.) keyed by SFDC ID
export async function fetchGongWarningsBySfdcId(
  sfdcIds: string[]
): Promise<Map<string, GongWarning[]>> {
  if (sfdcIds.length === 0) return new Map()

  try {
    const deals = await fetchGongDeals()
    const map = new Map<string, GongWarning[]>()
    for (const deal of deals) {
      if (sfdcIds.includes(deal.crm_id)) {
        map.set(deal.crm_id, deal.warnings ?? [])
      }
    }
    return map
  } catch (err) {
    console.error('Gong fetchWarnings error:', err)
    return new Map()
  }
}

export function isSingleThreaded(activity: GongActivity): boolean {
  return activity.unique_contact_count <= 1 && activity.total_calls > 0
}

export function hasRedFlags(warnings: GongWarning[]): boolean {
  return warnings.some((w) => w.type === 'red-flag' || w.severity === 'high')
}

export function daysSinceLastGongActivity(activity: GongActivity): number | null {
  const lastDate = activity.last_call_date ?? activity.last_email_date
  if (!lastDate) return null
  return Math.floor((Date.now() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24))
}
