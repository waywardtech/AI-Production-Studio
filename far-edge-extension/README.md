# Far Edge Studio — Prompt Composer (Phase 1 MVP)

A working Chrome extension covering the Phase 1 ticket set from
`far-edge-studio-phase0-1-tickets.md`. Load it, use it on ChatGPT today,
then keep building on top of it.

## Install (unpacked, Chrome only)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this `far-edge-extension` folder
5. Click the extension's toolbar icon to open the side panel
6. Open a `chatgpt.com` tab, click **Refresh open ChatGPT tabs** in the
   side panel, build a prompt, select the tab, and click **Insert**

## What's implemented

| Ticket | Status | Notes |
|---|---|---|
| M1-1 Extension scaffold | ✅ | Manifest V3, service worker, side panel |
| M1-2 Block builder UI | ✅ | Drag Scenario / Expertise / Ask into the canvas, edit inline |
| M1-3 Prompt library (save/load) | ⚠️ Partial | Saves to `chrome.storage.local`, not Drive — see "What's stubbed" below |
| M1-4 Filter + flat list | ✅ | Single filter box over a flat library list |
| M1-5 ChatGPT tab detection | ✅ | Background worker queries open `chatgpt.com` / `chat.openai.com` tabs |
| M1-6 Manual tab labeling | ✅ | Editable label per tab, persisted locally |
| M1-7 Destination picker | ✅ | Checkbox list, multi-tab select supported |
| M1-8 ChatGPT injection engine | ✅ | Multi-strategy (contenteditable + textarea), see caveat below |
| M1-9 Clipboard fallback | ✅ | Auto-triggers on injection failure with a clear toast |
| M1-10 Usage scrape (stretch) | ❌ Not started | Deferred — flagged as stretch/1.5 in the ticket doc |

## What's stubbed and why (CORE-1 / CORE-4)

The Phase 0 tickets call for Google OAuth login and a Drive-backed
repository. Both need a **Google Cloud project and OAuth client ID
registered under your own Google account** — that's not something that
can be generated on your behalf, it has to come from you.

So for this build, the prompt library uses the extension's own local
storage (`chrome.storage.local`) instead. It works fully — save, load,
filter, delete — it just isn't synced to Drive yet, and it's scoped to
this one browser profile.

**To wire in the real thing later:**
1. Create a project in Google Cloud Console, enable the Drive API
2. Create an OAuth 2.0 Client ID (type: Chrome Extension), using this
   extension's ID (visible on `chrome://extensions` once loaded)
3. Add `identity` to `manifest.json` permissions and the client ID under
   `oauth2`
4. Swap `getLibrary()` / `saveLibrary()` in `sidepanel.js` for calls
   against the Drive API instead of `chrome.storage.local`

Everything else (blocks, tabs, injection, fallback) doesn't need to
change when that happens.

## Known caveat: ChatGPT's DOM will change

`content-scripts/chatgpt-inject.js` looks for `#prompt-textarea` or a
`contenteditable` div, falling back to a plain `textarea`. This is the
accepted screen-scraping tradeoff documented in the spec (§7) — when
OpenAI changes their input markup, `findChatGptInput()` is the one
function that needs updating.

## Next up

Per the ticket doc: Phase 1.5 (Format block, Optimize step, Claude +
Gemini injection adapters), then Phase 2 (Module 2: Response Manager).
