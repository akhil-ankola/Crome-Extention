// background/background.js

// ── Context Menu ──────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'saveHighlight',
    title: '📝 Save as Highlight Note',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'saveHighlight' && info.selectionText) {
    chrome.tabs.sendMessage(tab.id, {
      action: 'saveHighlightFromContext',
      text: info.selectionText
    });
  }
});

// ── Keyboard Shortcut ─────────────────────────────────────
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-sidebar') {
    chrome.tabs.sendMessage(tab.id, { action: 'toggleSidebar' });
  }
});

// ── Badge Management ──────────────────────────────────────
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url) updateBadge(tabId, tab.url);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    updateBadge(tabId, tab.url);
  }
});

async function updateBadge(tabId, url) {
  const settings = await getSettings();
  if (settings.indicator !== 'badge') {
    chrome.action.setBadgeText({ text: '', tabId });
    return;
  }

  const data = await chrome.storage.local.get(['notes', 'highlights']);
  const hasNote = data.notes && data.notes[url];
  const highlights = data.highlights && data.highlights[url];
  const hasHighlight = highlights && highlights.length > 0;

  if (hasNote || hasHighlight) {
    const count = (hasNote ? 1 : 0) + (highlights ? highlights.length : 0);
    chrome.action.setBadgeText({ text: count > 9 ? '9+' : String(count), tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#6c63ff', tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }
}

async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get('settings', data =>
      resolve(data.settings || { theme: 'light', indicator: 'badge' })
    );
  });
}

// ── Message Relay ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'refreshBadge') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) updateBadge(tabs[0].id, tabs[0].url);
    });
  }
  if (msg.action === 'openNotesPage') {
    chrome.tabs.create({ url: chrome.runtime.getURL('notes/notes.html') });
  }
  if (msg.action === 'openOptions') {
    chrome.runtime.openOptionsPage();
  }
  return false;
});

// ── Storage Change Listener ────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.notes || changes.highlights)) {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) updateBadge(tabs[0].id, tabs[0].url);
    });
  }
});
