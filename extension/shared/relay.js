// The relay from an extension page to the content script on a chat or
// generator tab.
//
// Pages can't message a content script directly, so the background
// worker passes requests along. Everything that touches a page goes
// through here — inserting a prompt, capturing a reply, attaching a
// file, the page check — which makes it the one place a tab that has
// stopped responding can be noticed.
//
// The rule it enforces: relayToTab always answers, and always within a
// bound. A tab that never replies used to leave the caller waiting with
// no error to react to, so Insert never reached its clipboard fallback.
// Now the wait ends as `{ success: false, timedOut: true, reason }`,
// which is the failure every caller already handles.
//
// chrome.* is injected so this can be tested without a browser.

import { StallError, formatDuration, withDeadline } from './watchdog.js';

// How long a content script may take to answer. Everything asked of it
// is quick — reading the composer, decoding a 2 MB chunk — so a tab
// that hasn't answered in this long isn't busy, it's stuck.
export const RELAY_TIMEOUT_MS = 15 * 1000;
// Injecting the script into a tab that never received it.
export const INJECT_TIMEOUT_MS = 10 * 1000;

export const ADAPTER_FILE = 'content-scripts/chat-adapter.js';

export function createRelay({
  sendMessage,
  executeScript,
  timeoutMs = RELAY_TIMEOUT_MS,
  injectTimeoutMs = INJECT_TIMEOUT_MS,
  timers = globalThis,
}) {
  const stalled = (error) => ({
    success: false,
    timedOut: true,
    reason:
      `That tab didn't answer within ${formatDuration(error.afterMs)} — it may be frozen or still loading. ` +
      'If the page recovers, try again.',
  });

  async function ask(tabId, message) {
    const response = await withDeadline(() => sendMessage(tabId, message), {
      ms: timeoutMs,
      what: 'The tab',
      timers,
    });
    return response ?? { success: false, reason: 'No response from content script.' };
  }

  // Never throws and never waits forever: every path out of here is a
  // response object.
  return async function relayToTab(tabId, message) {
    try {
      return await ask(tabId, message);
    } catch (error) {
      // The script is there but the page isn't answering. Injecting a
      // second copy into a frozen page would only hang as well, and
      // double the wait before the caller can fall back.
      if (error instanceof StallError) return stalled(error);

      // Otherwise the content script isn't reachable on this tab. The
      // usual cause is a tab that was already open when the extension
      // was installed or reloaded: manifest content scripts only run on
      // navigation, so those tabs never got one.
      //
      // That's recoverable without asking Dan to reload anything —
      // inject the script programmatically, then retry the message. Only
      // if this also fails do we report failure and let the caller use
      // its fallback (genuine cases: the tab is on a URL we have no host
      // permission for, or it's mid-navigation).
      try {
        await withDeadline(() => executeScript({ target: { tabId }, files: [ADAPTER_FILE] }), {
          ms: injectTimeoutMs,
          what: 'Reaching the tab',
          timers,
        });
        return await ask(tabId, message);
      } catch (retryError) {
        if (retryError instanceof StallError) return stalled(retryError);
        return { success: false, reason: retryError.message };
      }
    }
  };
}
