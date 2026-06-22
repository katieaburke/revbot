import { fetchDealHealth, nudgeOwner } from './api'
import { isConfigured, getSettings } from './storage'
import { ALERT_LABELS, ALERT_COLORS, type DealHealthResponse, type ActiveAlert } from './types'

const PANEL_ID = 'beacon-panel'

// ─── Opportunity ID extraction ─────────────────────────────────────────────

function getOpportunityId(): string | null {
  const match = window.location.pathname.match(/\/lightning\/r\/Opportunity\/([a-zA-Z0-9]{15,18})\/view/)
  return match?.[1] ?? null
}

// ─── Panel lifecycle ───────────────────────────────────────────────────────

function removePanel() {
  document.getElementById(PANEL_ID)?.remove()
}

function createPanel(): HTMLElement {
  removePanel()
  const panel = document.createElement('div')
  panel.id = PANEL_ID
  Object.assign(panel.style, {
    position: 'fixed',
    top: '72px',
    right: '16px',
    width: '320px',
    zIndex: '999999',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: '13px',
    lineHeight: '1.4',
  })
  document.body.appendChild(panel)
  return panel
}

function renderLoading(panel: HTMLElement) {
  panel.innerHTML = `
    <div style="${cardStyle()}">
      <div style="display:flex;align-items:center;gap:8px;color:#6b7280;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
        </svg>
        Loading deal health...
      </div>
    </div>
    <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
  `
}

function renderNotConfigured(panel: HTMLElement) {
  panel.innerHTML = `
    <div style="${cardStyle()}">
      <div style="font-weight:600;margin-bottom:6px;">Beacon</div>
      <div style="color:#6b7280;margin-bottom:10px;font-size:12px;">Set up your API connection to see deal health here.</div>
      <button id="pn-open-settings" style="${btnStyle('#4f5df7')}">Open Settings</button>
    </div>
  `
  panel.querySelector('#pn-open-settings')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_POPUP' })
  })
}

function renderError(panel: HTMLElement, message: string) {
  panel.innerHTML = `
    <div style="${cardStyle()}">
      <div style="color:#ef4444;font-size:12px;">⚠️ ${message}</div>
    </div>
  `
}

function renderHealthPanel(panel: HTMLElement, data: DealHealthResponse, isRevOps: boolean) {
  const alerts = data.activeAlerts.filter((a) => a.status === 'SENT' || a.status === 'SNOOZED')

  const gongSection = buildGongSection(data)
  const alertsSection = alerts.length > 0 ? buildAlertsSection(alerts, data, isRevOps) : ''
  const allClearSection = alerts.length === 0 ? buildAllClear() : ''

  panel.innerHTML = `
    <div style="${cardStyle()}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <span style="font-weight:600;font-size:13px;">Beacon</span>
        <button id="pn-collapse" style="background:none;border:none;cursor:pointer;padding:0;color:#9ca3af;" title="Close">✕</button>
      </div>
      ${gongSection}
      ${alertsSection}
      ${allClearSection}
    </div>
  `

  panel.querySelector('#pn-collapse')?.addEventListener('click', () => {
    collapsePanel(panel)
  })

  // Wire up nudge buttons
  panel.querySelectorAll('[data-nudge]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const alertId = (btn as HTMLElement).dataset.nudge!
      const alert = alerts.find((a) => a.id === alertId)
      if (!alert) return
      await handleNudge(panel, data, alert)
    })
  })
}

function buildGongSection(data: DealHealthResponse): string {
  const lastCall = data.gongLastCallDate
    ? `${daysSince(data.gongLastCallDate)}d ago`
    : 'No calls'
  const callCount = data.gongTotalCalls
  const singleThreaded = data.gongSingleThreaded

  return `
    <div style="background:#f9fafb;border-radius:8px;padding:10px 12px;margin-bottom:10px;">
      <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Gong Activity</div>
      <div style="display:flex;gap:16px;">
        <div>
          <div style="font-weight:600;">${lastCall}</div>
          <div style="font-size:11px;color:#9ca3af;">Last call</div>
        </div>
        <div>
          <div style="font-weight:600;">${callCount}</div>
          <div style="font-size:11px;color:#9ca3af;">Total calls</div>
        </div>
        ${singleThreaded ? `<div style="display:flex;align-items:center;gap:4px;color:#f59e0b;font-size:11px;font-weight:600;">⚠️ Single-threaded</div>` : ''}
      </div>
    </div>
  `
}

function buildAlertsSection(alerts: ActiveAlert[], data: DealHealthResponse, isRevOps: boolean): string {
  return alerts.map((alert) => {
    const color = ALERT_COLORS[alert.alertType] ?? '#6b7280'
    const label = ALERT_LABELS[alert.alertType] ?? alert.alertType
    const detail = buildAlertDetail(alert)
    const snoozed = alert.status === 'SNOOZED'

    return `
      <div style="border-left:3px solid ${color};padding:8px 10px;background:#fafafa;border-radius:0 6px 6px 0;margin-bottom:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px;">
          <span style="font-weight:600;font-size:12px;color:${color};">${label}</span>
          ${snoozed ? `<span style="font-size:10px;color:#9ca3af;">snoozed</span>` : ''}
        </div>
        <div style="font-size:12px;color:#374151;">${detail}</div>
        ${isRevOps && !snoozed ? `
          <button data-nudge="${alert.id}" style="${btnStyle('#4f5df7', true)}">
            Nudge owner
          </button>
        ` : ''}
      </div>
    `
  }).join('')
}

function buildAllClear(): string {
  return `
    <div style="display:flex;align-items:center;gap:6px;color:#10b981;font-size:12px;">
      <span>✓</span> No active alerts on this deal
    </div>
  `
}

function buildAlertDetail(alert: ActiveAlert): string {
  const d = alert.alertDetails as Record<string, unknown>
  switch (alert.alertType) {
    case 'PAST_DUE_INITIAL':
    case 'PAST_DUE_AMENDMENT':
      return `Close date ${d.closeDate as string} — ${d.daysOverdue as number}d overdue`
    case 'PAST_DUE_RENEWAL':
      return `Renewal due ${d.closeDate as string} — ${d.daysOverdue as number}d overdue`
    case 'STALLED': {
      const reasons = (d.triggeredBy as Array<{ type: string; days?: number; threshold?: number }>) ?? []
      return reasons.map((r) => {
        if (r.type === 'deal_age') return `Open ${r.days}d (>${r.threshold}d)`
        if (r.type === 'stage_duration') return `In stage ${r.days}d (>${r.threshold}d)`
        if (r.type === 'gong_inactivity') return `No Gong activity ${r.days}d`
        if (r.type === 'single_threaded') return 'Single-threaded'
        if (r.type === 'red_flag') return 'Gong risk phrases'
        return r.type
      }).join(' · ')
    }
    case 'MEDDPICC_MISSING': {
      const missing = (d.missingFields as string[]) ?? []
      return `Missing: ${missing.map(humanizeMeddpicc).join(', ')}`
    }
    default:
      return ''
  }
}

function humanizeMeddpicc(field: string): string {
  const map: Record<string, string> = {
    metrics: 'M', economicBuyer: 'EB', decisionCriteria: 'DC',
    decisionProcess: 'DP', identifyPain: 'IP', champion: 'Ch', competition: 'Co',
  }
  return map[field] ?? field
}

// ─── Nudge flow ────────────────────────────────────────────────────────────

async function handleNudge(panel: HTMLElement, data: DealHealthResponse, alert: ActiveAlert) {
  const settings = await getSettings()
  if (!settings) return

  const customMessage = prompt(
    `Send a follow-up nudge to ${alert.owner.slackName ?? alert.owner.slackEmail} about "${data.opportunityName}".\n\nOptional custom note (leave blank for default):`,
    ''
  )
  if (customMessage === null) return // cancelled

  const btn = panel.querySelector(`[data-nudge="${alert.id}"]`) as HTMLButtonElement | null
  if (btn) { btn.textContent = 'Sending...'; btn.disabled = true }

  try {
    await nudgeOwner({
      opportunityId: data.opportunityId,
      opportunityName: data.opportunityName,
      targetUserSlackId: alert.owner.slackUserId,
      alertType: alert.alertType,
      customMessage: customMessage || undefined,
      senderEmail: settings.slackEmail,
    })
    if (btn) { btn.textContent = '✓ Sent' }
    setTimeout(() => initPanel(), 2000)
  } catch (err) {
    if (btn) { btn.textContent = 'Failed — retry'; btn.disabled = false }
    console.error('[Beacon] Nudge failed:', err)
  }
}

// ─── Collapsed state ───────────────────────────────────────────────────────

function collapsePanel(panel: HTMLElement) {
  panel.innerHTML = `
    <button id="pn-expand" style="
      background:#4f5df7;color:#fff;border:none;border-radius:8px;
      padding:6px 12px;cursor:pointer;font-size:12px;font-weight:600;
      box-shadow:0 2px 8px rgba(79,93,247,.4);
    ">🔔 Beacon</button>
  `
  panel.querySelector('#pn-expand')?.addEventListener('click', () => initPanel())
}

// ─── Main init ─────────────────────────────────────────────────────────────

async function initPanel() {
  const oppId = getOpportunityId()
  if (!oppId) return

  const panel = createPanel()

  const configured = await isConfigured()
  if (!configured) {
    renderNotConfigured(panel)
    return
  }

  renderLoading(panel)

  try {
    const [data, settings] = await Promise.all([
      fetchDealHealth(oppId),
      getSettings(),
    ])

    const activeCount = data.activeAlerts.filter((a) => a.status === 'SENT').length
    chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', count: activeCount })

    renderHealthPanel(panel, data, settings?.isRevOps ?? false)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    renderError(panel, msg)
    chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', count: 0 })
  }
}

// ─── Style helpers ─────────────────────────────────────────────────────────

function cardStyle(): string {
  return `
    background:#fff;
    border:1px solid #e5e7eb;
    border-radius:12px;
    padding:14px;
    box-shadow:0 4px 16px rgba(0,0,0,.08);
  `
}

function btnStyle(color: string, small = false): string {
  return `
    background:${color};color:#fff;border:none;border-radius:6px;
    padding:${small ? '4px 8px' : '7px 14px'};
    font-size:${small ? '11px' : '12px'};font-weight:600;
    cursor:pointer;margin-top:${small ? '6px' : '8px'};
    display:inline-block;
  `
}

function daysSince(isoDate: string): number {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24))
}

// ─── Boot ──────────────────────────────────────────────────────────────────

// SFDC Lightning is a SPA — watch for URL changes
let lastUrl = window.location.href
new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href
    removePanel()
    // Small delay for Lightning page transition to settle
    setTimeout(() => initPanel(), 1200)
  }
}).observe(document.body, { childList: true, subtree: true })

// Initial load
initPanel()
