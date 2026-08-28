// Edge Studio — background service worker
// Covers: M1-1 (extension scaffold), M1-5/M1.5-6 (tab detection across
// ChatGPT, Claude and Gemini), M1-7/M1-8 (send-to-tab relay)

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Edge Studio] Installed.');
});

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[Edge Studio] setPanelBehavior failed:', error));

// --- M1-5 / M1.5-6: Tab detection ---
// The side panel asks the background worker for the current list of
// open chat tabs, since only the background worker has the "tabs"
// permission context needed to query across windows. Each tab carries
// its platform so the panel can badge it and so Optimize can default
// its target to whatever the worker tab already is.
const CHAT_PLATFORMS = [
  { platform: 'chatgpt', label: 'ChatGPT', urls: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] },
  { platform: 'claude', label: 'Claude', urls: ['https://claude.ai/*'] },
  { platform: 'gemini', label: 'Gemini', urls: ['https://gemini.google.com/*'] },
];

async function findChatTabs() {
  const found = [];
  for (const entry of CHAT_PLATFORMS) {
    const tabs = await chrome.tabs.query({ url: entry.urls });
    tabs.forEach((tab) =>
      found.push({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        windowId: tab.windowId,
        platform: entry.platform,
        platformLabel: entry.label,
      })
    );
  }
  return found;
}

// --- M1-7 / M1-8 / M2-1: Content-script relay ---
// The side panel is a separate extension context and can't message a
// content script directly, so the background worker relays the request.
// Everything that talks to the page — injecting a prompt, capturing a
// response, capturing a selection — goes through relayToTab so they all
// get the same recovery behaviour.
async function sendToAdapter(tabId, message) {
  const response = await chrome.tabs.sendMessage(tabId, message);
  return response ?? { success: false, reason: 'No response from content script.' };
}

async function relayToTab(tabId, message) {
  try {
    return await sendToAdapter(tabId, message);
  } catch (error) {
    // The content script isn't reachable on this tab. The usual cause is
    // a tab that was already open when the extension was installed or
    // reloaded: manifest content scripts only run on navigation, so
    // those tabs never got one.
    //
    // That's recoverable without asking Dan to reload anything — inject
    // the script programmatically, then retry the message. This is what
    // the "scripting" permission is for; only if this also fails do we
    // report failure and let the side panel use the M1-9 clipboard
    // fallback (genuine cases: the tab is on a URL we have no host
    // permission for, or it's mid-navigation).
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-scripts/chat-adapter.js'],
      });
      return await sendToAdapter(tabId, message);
    } catch (retryError) {
      return { success: false, reason: retryError.message };
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EDGE_STUDIO_GET_TABS') {
    findChatTabs().then(sendResponse);
    return true; // keep the message channel open for the async response
  }

  if (message.type === 'EDGE_STUDIO_SEND_TO_TAB') {
    relayToTab(message.tabId, {
      type: 'EDGE_STUDIO_INJECT_PROMPT',
      text: message.text,
    }).then(sendResponse);
    return true;
  }

  // --- M2-1 / M2-2 / CORE-8: capture relays ---
  if (
    message.type === 'EDGE_STUDIO_CAPTURE_RESPONSE' ||
    message.type === 'EDGE_STUDIO_CAPTURE_SELECTION' ||
    message.type === 'EDGE_STUDIO_CAPTURE_USAGE'
  ) {
    relayToTab(message.tabId, { type: message.type }).then(sendResponse);
    return true;
  }
});
