import { getSettings, saveSettings } from './storage'

async function init() {
  const settings = await getSettings()

  const apiUrlEl = document.getElementById('apiUrl') as HTMLInputElement
  const apiKeyEl = document.getElementById('apiKey') as HTMLInputElement
  const slackEmailEl = document.getElementById('slackEmail') as HTMLInputElement
  const isRevOpsEl = document.getElementById('isRevOps') as HTMLInputElement
  const statusEl = document.getElementById('status') as HTMLDivElement
  const connectionEl = document.getElementById('connection-status') as HTMLDivElement

  if (settings) {
    apiUrlEl.value = settings.apiUrl
    apiKeyEl.value = settings.apiKey
    slackEmailEl.value = settings.slackEmail
    isRevOpsEl.checked = settings.isRevOps

    const connected = !!(settings.apiUrl && settings.apiKey)
    connectionEl.innerHTML = `
      <span class="connection-badge ${connected ? 'connected' : 'disconnected'}">
        ${connected ? '● Connected' : '● Not configured'}
      </span>
    `
  } else {
    connectionEl.innerHTML = `<span class="connection-badge disconnected">● Not configured</span>`
  }

  document.getElementById('save')?.addEventListener('click', async () => {
    const apiUrl = apiUrlEl.value.trim()
    const apiKey = apiKeyEl.value.trim()
    const slackEmail = slackEmailEl.value.trim()
    const isRevOps = isRevOpsEl.checked

    if (!apiUrl || !apiKey || !slackEmail) {
      showStatus('Please fill in all fields', 'error')
      return
    }

    // Quick connectivity test
    try {
      const res = await fetch(`${apiUrl.replace(/\/$/, '')}/health`, {
        headers: { 'X-Extension-Key': apiKey },
      })
      if (!res.ok) throw new Error(`Status ${res.status}`)
    } catch (err) {
      showStatus(`Cannot reach API: ${(err as Error).message}`, 'error')
      return
    }

    await saveSettings({ apiUrl, apiKey, slackEmail, isRevOps })
    showStatus('Settings saved ✓', 'success')

    connectionEl.innerHTML = `<span class="connection-badge connected">● Connected</span>`
  })

  function showStatus(msg: string, type: 'success' | 'error') {
    statusEl.textContent = msg
    statusEl.className = `status ${type}`
    setTimeout(() => { statusEl.className = 'status' }, 3000)
  }
}

init()
