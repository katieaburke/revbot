import type { ExtensionSettings } from './types'

const SETTINGS_KEY = 'beacon_settings'

export async function getSettings(): Promise<ExtensionSettings | null> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(SETTINGS_KEY, (result) => {
      resolve(result[SETTINGS_KEY] ?? null)
    })
  })
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [SETTINGS_KEY]: settings }, resolve)
  })
}

export async function isConfigured(): Promise<boolean> {
  const s = await getSettings()
  return !!(s?.apiUrl && s?.apiKey)
}
