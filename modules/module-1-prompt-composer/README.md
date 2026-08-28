# Edge Studio

A working Chrome extension covering the Phase 1 ticket set and the first
three Phase 2 tickets from `../../docs/tickets-phase-0-2.md`. Load it,
use it on ChatGPT today, then keep building on top of it.

The extension is named **Edge Studio**; the directory keeps its
`module-1-prompt-composer` name because that's how the spec and ticket
docs refer to this module.

## Install (unpacked, Chrome only)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this `modules/module-1-prompt-composer` folder
5. Click the extension's toolbar icon to open the side panel
6. Open a `chatgpt.com` tab, click **Refresh open ChatGPT tabs** in the
   side panel, build a prompt, tick the tab, and click **Insert**
7. To pull work back out, tick a tab and use **Capture → Latest
   response** (or highlight text in the page and use **Selection**)

## What's implemented

| Ticket | Status | Notes |
|---|---|---|
| M1-1 Extension scaffold | ✅ | Manifest V3, service worker, side panel |
| M1-2 Block builder UI | ✅ | Drag Scenario / Expertise / Ask into the canvas, edit inline |
| M1-3 Prompt library (save/load) | ⚠️ Partial | Saves to `chrome.storage.local`, not Drive — see "What's stubbed" below |
| M1-4 Filter + flat list | ✅ | Single filter box over a flat library list |
| M1-5 ChatGPT tab detection | ✅ | Background worker queries open `chatgpt.com` / `chat.openai.com` tabs |
| M1-6 Manual tab labeling | ✅ | Editable label per tab, scoped to the browser session |
| M1-7 Destination picker | ✅ | Checkbox list, multi-tab select supported |
| M1-8 ChatGPT injection engine | ✅ | Multi-strategy (contenteditable + textarea), see caveat below |
| M1-9 Clipboard fallback | ✅ | Auto-triggers on injection failure with a clear toast |
| M1-10 Usage scrape (stretch) | ❌ Not started | Deferred — flagged as stretch/1.5 in the ticket doc |
| M1-11 Variable placeholders | ✅ | See below |
| M2-1 Response capture panel | ✅ | Captures the latest response, or the page selection, per ticked tab |
| M2-2 Select & save | ✅ | Staged captures are editable before saving, which is also how "save just this section" works |
| M2-3 Send to prompt | ✅ | Drops a capture or saved response into the builder as a Scenario block |
| M2-4 Gemini native save | ❌ Not started | Needs Gemini support (Phase 1.5) first |
| M2-5 Export-to-Drive fallback | ❌ Not started | Blocked on CORE-1/CORE-4, same as M1-3 |
| M2-6 Reformat pipeline | ❌ Not started | P1 |
| M2-7 Alternate export formats | ⚠️ Partial | **Copy MD** puts a saved response on the clipboard as Markdown; writing real files waits on Drive |

## Variable placeholders

A token inside `<angle brackets>` in a block — with or without a prefix
attached, e.g. `w<current-week>` or `<session-date>` — is a variable.
Templates keep the raw `<placeholder>` form when saved to the library.
On **Insert**, every unique variable in the assembled prompt is
collected and a small form asks for each value once; the same value
fills every occurrence.

Example: `Review w<current-week> session and compare it to the session
on <session-date>` prompts for `current-week` and `session-date`. Enter
`37` and `01-28-1969` and the text actually sent/copied becomes:
`Review w37 session and compare it to the session on 01-28-1969` — the
saved template is untouched, so it's reusable next time with new values.

**A name must look like an identifier.** It starts with a letter or
underscore, then letters, digits, hyphens or underscores. That keeps
things that merely sit inside angle brackets from being mistaken for
variables — `</closing>` tags, `<dan@thefaredge.com>`,
`<https://example.com>`, `Map<string,int>` are all left alone.

**Blank means "leave it as-is".** If you clear a field (or ignore it),
that token stays exactly as written instead of being deleted. This
matters for the cases a pattern can't tell apart: `<li>` and
`Array<string>` do look like variables, so they'll appear in the form —
leave them blank and they pass through untouched.

**Escape with a backslash** to keep brackets literal and skip the
prompt entirely: `\<li\>` reaches the target as `<li>` and is never
offered as a variable.

**Values are remembered.** The last value you gave a variable is
prefilled (and pre-selected, so it's easy to overwrite) the next time
that name comes up, since most variables — a client name, a session
date — repeat across inserts.

## Capturing responses (M2-1 / M2-2 / M2-3)

**Capture** pulls work back out of the tabs ticked in **Send To**:

- **Latest response** grabs the most recent assistant message from each
  ticked tab.
- **Selection** grabs whatever you've highlighted in the page, which is
  how you save part of a response rather than all of it.

Captures are staged, not saved. Each one lands in an editable box so you
can trim it down first — that edit *is* the "save just this section"
step, so there's no separate selection UI to learn. From there:

- **Save** stores it under **Saved Responses**, tagged `Draft`, with a
  link back to the conversation it came from (the repository keeps
  references, not copies — CORE-4).
- **To prompt** drops the text into the builder as a Scenario block, so
  a response can feed the next prompt.
- **Copy MD** (on saved items) puts the response on the clipboard as
  Markdown with its source link.

Saved responses have their own filter, which matches on title, body text
and source tab.

## What's stubbed and why (CORE-1 / CORE-4)

The Phase 0 tickets call for Google OAuth login and a Drive-backed
repository. Both need a **Google Cloud project and OAuth client ID
registered under your own Google account** — that's not something that
can be generated on your behalf, it has to come from you.

So for this build, the prompt library and the saved responses both use
the extension's own local storage (`chrome.storage.local`) instead. They
work fully — save, load, filter, delete — they just aren't synced to
Drive yet, and they're scoped to this one browser profile.

**To wire in the real thing later:**
1. Create a project in Google Cloud Console, enable the Drive API
2. Create an OAuth 2.0 Client ID (type: Chrome Extension), using this
   extension's ID (visible on `chrome://extensions` once loaded)
3. Add `identity` to `manifest.json` permissions and the client ID under
   `oauth2`
4. Swap `getLibrary()` / `saveLibrary()` and `getResponses()` /
   `saveResponses()` in `sidepanel.js` for calls against the Drive API
   instead of `chrome.storage.local`

Everything else (blocks, tabs, injection, capture, fallback) doesn't
need to change when that happens. Saved responses already carry the
`source` link back to their conversation that CORE-4 expects.

## Tab labels are per browser session

Labels are keyed by Chrome's tab ID and stored in `chrome.storage.session`,
so they're cleared when the browser closes. That's deliberate: tab IDs
are only unique within a session and Chrome reissues them after a
restart, so a label persisted to disk would eventually reattach itself
to an unrelated tab. Labels that survive a restart need a stable key
(the conversation URL) — that's a change worth its own ticket, not a
silent behaviour.

## Tabs opened before the extension loaded

Manifest content scripts only run on navigation, so a ChatGPT tab that
was already open when the extension was installed or reloaded has no
content script and can't be injected into. The background worker now
detects that case and injects `chatgpt-adapter.js` programmatically via
`chrome.scripting`, then retries — no reload needed. The M1-9 clipboard
fallback still covers the cases that can't be recovered (tab
mid-navigation, or a URL outside the extension's host permissions).

## Known caveat: ChatGPT's DOM will change

`content-scripts/chatgpt-adapter.js` is the only file that touches
ChatGPT's markup, and it's the accepted screen-scraping tradeoff
documented in the spec (§7). Two functions are where a ChatGPT redesign
lands:

- `findChatGptInput()` — writing. Looks for `#prompt-textarea` or a
  `contenteditable` div, falling back to a plain `textarea`.
- `findAssistantTurns()` — reading. Looks for
  `[data-message-author-role="assistant"]`, falling back to
  `article[data-testid^="conversation-turn-"]` minus the user's turns.

## Next up

Per the ticket doc: Phase 1.5 (Format block, Optimize step, Claude +
Gemini injection adapters), then the rest of Phase 2 — M2-4/M2-5
(Drive-backed export, blocked on CORE-1/CORE-4) and M2-6 (reformat
pipeline).
