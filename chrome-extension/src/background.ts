// Service worker — handles extension icon badge updates when navigating SFDC

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return
  if (!tab.url) return

  const oppId = extractOpportunityId(tab.url)
  if (!oppId) {
    chrome.action.setBadgeText({ tabId, text: '' })
    return
  }

  // Notify content script that the page has finished loading
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PAGE_LOADED', opportunityId: oppId })
  } catch {
    // Content script not ready yet — it will init on its own
  }
})

function extractOpportunityId(url: string): string | null {
  const match = url.match(/\/lightning\/r\/Opportunity\/([a-zA-Z0-9]{15,18})\/view/)
  return match?.[1] ?? null
}

// Update the badge when content script reports alert count
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'UPDATE_BADGE' && sender.tab?.id) {
    const count: number = message.count
    if (count === 0) {
      chrome.action.setBadgeText({ tabId: sender.tab.id, text: '' })
    } else {
      chrome.action.setBadgeText({ tabId: sender.tab.id, text: String(count) })
      chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#ef4444' })
    }
  }
})
