// Far Edge Studio — background service worker
// Covers: M1-1 (extension scaffold), M1-5 (tab detection), M1-7/M1-8 (send-to-tab relay)

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Far Edge Studio] Installed.');
});

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[Far Edge Studio] setPanelBehavior failed:', error));

// --- M1-5: Tab detection ---
// The side panel asks the background worker for the current list of
// open ChatGPT tabs, since only the background worker has the "tabs"
// permission context needed to query across windows.
async function findChatGptTabs() {
  const tabs = await chrome.tabs.query({
    url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  });
  return tabs.map((tab) => ({
    id: tab.id,
    title: tab.title,
    url: tab.url,
    windowId: tab.windowId,
  }));
}

// --- M1-7 / M1-8: Injection relay ---
// The side panel is a separate extension context and can't message a
// content script directly, so the background worker relays the request.
async function sendInjectMessage(tabId, text) {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: 'FAR_EDGE_INJECT_PROMPT',
    text,
  });
  return response ?? { success: false, reason: 'No response from content script.' };
}

async function injectIntoTab(tabId, text) {
  try {
    return await sendInjectMessage(tabId, text);
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
        files: ['content-scripts/chatgpt-inject.js'],
      });
      return await sendInjectMessage(tabId, text);
    } catch (retryError) {
      return { success: false, reason: retryError.message };
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FAR_EDGE_GET_TABS') {
    findChatGptTabs().then(sendResponse);
    return true; // keep the message channel open for the async response
  }

  if (message.type === 'FAR_EDGE_SEND_TO_TAB') {
    injectIntoTab(message.tabId, message.text).then(sendResponse);
    return true;
  }
});
