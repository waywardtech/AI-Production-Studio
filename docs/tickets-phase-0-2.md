# Far Edge Studio — Engineering Tickets (Phases 0–2)

Derived from `far-edge-studio-productivity-suite-spec.md`. Covers **Phase 0 (Core)**, **Phase 1 (Module 1 MVP)**, **Phase 1.5 (optimize step + Claude/Gemini injection)**, and **Phase 2 (Module 2: Response Manager & Archive)**.

---

## Epic: Phase 0 — Core Platform Layer

**CORE-1 — Google OAuth login flow**
Implement Google OAuth 2.0 sign-in scoped to Drive read/write, for dan@thefaredge.com.
*Acceptance:* User can sign in; token refresh handled silently; only Drive scopes requested.

**CORE-2 — Drive folder picker component**
Reusable component any module can call to select/target a specific Drive folder.
*Acceptance:* Returns a folder ID/path usable by the calling module.
*Depends on:* CORE-1

**CORE-3 — Project folder structure scaffolding**
Auto-create the standard project folder tree in Drive (subfolders: prompts / responses / visual-assets / archives) when a new project is started.
*Acceptance:* "New Project" produces the correct folder structure with no manual setup.

**CORE-4 — Repository schema & index**
Define and implement the schema for prompt blocks, saved prompts, saved responses, and chat archives. Documents are referenced by link (not duplicated); maintain an internal link index as fallback where a platform's Drive integration is unreliable.
*Acceptance:* CRUD works against the schema; every repository item resolves to a link, not a copy.

**CORE-5 — Tagging layer (system + custom tags)** ⚠️ *Partial — prompts and replies, local storage*
Gmail-labels-style tagging: one standard system tag, **Status** (Draft / In Review / Approved / Archived), always present, plus user-created custom tags on top. Applies to prompts, responses, and assets.
*Acceptance:* Every repository item carries a Status value; custom tags can be created, applied, removed, and filtered on.
*Built as:* Saved prompts and replies carry Status (Draft / In Review / Approved / Archived, editable on prompts). Prompts also take free-form tags, stored lowercase, filtered by chip and grouped by tag with multi-tag membership. Not yet applied to visual assets, and backed by local storage until CORE-4.

**CORE-6 — Chat export (transcript → Drive file)**
Capture a full chat transcript from a tracked tab and save it as a timestamped Drive file under the project's archive folder.
*Acceptance:* Exported file is readable and linked in the repository index.

**CORE-7 — Repository export/import (P1)**
Export/import the repository index as a portable JSON bundle (not the underlying Drive files, which stay in place).

**CORE-8 — Usage tab shell**
Build the Usage tab UI: per-service rows with a percentage/thermometer indicator.
*Acceptance:* Renders correctly with placeholder/manually-entered data; ready to receive live data as sources come online per-module.

**CORE-9 — Usage threshold settings**
Editable warning threshold per service, defaulting to 10% remaining.
*Depends on:* CORE-8

---

## Epic: Phase 1 — Module 1 MVP (Prompt Composer & Injection, Chrome / ChatGPT only)

**M1-1 — Chrome extension scaffold (Manifest V3)**
Base extension project: background service worker + content-script framework targeting chat.openai.com.
*Acceptance:* Extension installs, popup/side panel loads, content script confirmed active on ChatGPT.

**M1-2 — Block-based prompt builder UI**
Drag-and-drop canvas with block types: Scenario, Expertise/Persona, Ask. (Format block deferred to Phase 1.5.)
*Acceptance:* Blocks drag into the canvas, reorder, and assemble into a single prompt string.

**M1-3 — Prompt/block library (save/load)**
Wire the builder to the Core repository — save individual blocks or full prompts, browse and reuse.
*Depends on:* CORE-4

**M1-4 — Simple filter + flat list UI**
One filter control plus a flat list of blocks underneath — no nested categories yet, per the "keep it simple" call.
*Acceptance:* Filter narrows the visible list; no additional navigation layers.

**M1-5 — ChatGPT tab detection**
Detect currently open ChatGPT tabs via the extension's tab APIs.
*Acceptance:* Open ChatGPT tabs are surfaced to the destination picker.

**M1-6 — Manual tab labeling**
Let Dan assign a custom label to a detected tab (e.g. "Client X") to tell same-platform tabs apart.
*Acceptance:* Labels persist per tab session and display in the destination picker.

**M1-7 — Destination picker (single/multi-tab)**
UI to select one or more labeled tabs as injection targets.
*Depends on:* M1-5, M1-6

**M1-8 — ChatGPT injection engine**
Content-script logic to insert the assembled prompt into ChatGPT's input field — native-setter-plus-fallback pattern, informed by the `universal-prompt-library` reference project.
*Acceptance:* Approved prompt text appears in ChatGPT's input, ready to send.

**M1-9 — "Insertion available" fallback**
When auto-injection isn't possible (mobile, permissions), copy the prompt to clipboard and show a clear "ready to paste" notification.
*Acceptance:* Fallback triggers correctly on injection failure; clipboard holds the exact approved prompt.

**M1-10 — Stretch: ChatGPT usage scrape**
First real usage-tracking source — scrape ChatGPT's own usage/quota indicator, feed into Core's Usage tab (CORE-8).
*Priority:* P1, can slip to Phase 1.5 if scraping proves fiddly.

**M1-11 — Variable placeholders in prompts** ✅ *Implemented*
Support `<name>` tokens (optionally prefixed, e.g. `w<current-week>`) inside blocks. On Insert, collect each unique variable via an in-panel form and substitute before injection/clipboard — the saved template keeps the raw placeholder for reuse.
*Acceptance:* Confirmed against the reference example (`w<current-week>` / `<session-date>` → `w37` / `01-28-1969`).
*Refined since:* Variable names must be identifier-shaped, so closing tags, emails and URLs in angle brackets are no longer mistaken for variables. A blank value leaves its token untouched rather than deleting it, `\<...\>` escapes brackets outright, and last-used values are prefilled on the next insert.

---

## Epic: Phase 1.5 — Optimize Step + Claude/Gemini Injection

**M1.5-1 — Format block (4th prompt component)** ✅ *Implemented*
Add "Format" as an optional block type in the composer, deferred from Phase 1.
*Acceptance:* Format block appears in the palette and is included in the assembled prompt when present.
*Built as:* Format ships as a default block type, and the palette is now editable — block types can be renamed, removed and added, and any block in the builder can be switched to another type without retyping its text.

**M1.5-2 — Optimize step UI** ✅ *Implemented*
"Optimize?" toggle in the composer flow. When yes, formats a platform-aware optimization request and hands it to whichever AI tab is already open — no bundled API call, per decision #4.
*Acceptance:* Optimize request generates and hands off (injection or clipboard) to an open tab.
*Built as:* Optimize button beside Insert. Dan picks which open chat runs the work and which platform (ChatGPT / Claude / Gemini) the result is tuned for. Injection fills the input but never presses send. Clipboard fallback if injection fails.

**M1.5-3 — Optimize result intake** ✅ *Implemented*
Bring the optimized result back into the tool; Dan can approve as-is, edit inline, or trigger another regeneration pass.
*Depends on:* M1.5-2
*Built as:* Polls the worker tab and waits for the answer to stop streaming before scraping, then strips the code fence and any preamble. The result is shown in an editable box with Copy and Replace builder. Re-running Optimize is the regeneration pass.

**M1.5-4 — Claude injection adapter** ✅ *Implemented*
Extend the injection engine (M1-8) with a DOM adapter for claude.ai's input field.
*Acceptance:* Approved prompt inserts correctly into an open Claude tab.
*Built as:* Shared `chat-adapter.js` handles all three platforms from one PLATFORMS table; Claude's ProseMirror composer uses the same contenteditable strategy as ChatGPT.

**M1.5-5 — Gemini injection adapter** ✅ *Implemented*
Extend the injection engine with a DOM adapter for Gemini's contenteditable/rich-textarea input, informed by the `Ask-Gemini-Extension` reference project's multi-strategy approach.
*Acceptance:* Approved prompt inserts correctly into an open Gemini tab.
*Built as:* Same shared adapter; Gemini's Quill editor is reached via `rich-textarea .ql-editor` with contenteditable fallbacks.

**M1.5-6 — Claude + Gemini tab detection & labeling** ✅ *Implemented*
Extend M1-5/M1-6 detection and manual labeling to claude.ai and gemini.google.com.
*Acceptance:* Claude/Gemini tabs appear in the destination picker alongside ChatGPT tabs.
*Built as:* The background worker queries all three platforms and tags each tab with its platform; the panel badges them and labels them the same way.

**M1.5-7 — Multi-platform destination picker** ✅ *Implemented*
Update the destination picker (M1-7) to support selecting targets across all three platforms in a single send.
*Depends on:* M1.5-4, M1.5-5, M1.5-6
*Built as:* The Chat tabs list is platform-agnostic — tick tabs across platforms and Insert reaches all of them in one send.

**M1.5-8 — Claude + Gemini usage scrape (P1)**
Extend usage tracking (CORE-8/M1-10) to scrape Claude's and Gemini's own usage indicators.

---

## Epic: Phase 2 — Module 2: Response Manager & Archive

**M2-1 — Response capture panel** ✅ *Implemented (all three platforms)*
Surface the latest response from each tracked, open tab in a dedicated panel.
*Depends on:* M1.5-6 for full 3-platform coverage (can ship ChatGPT-only first and extend)
*Acceptance:* Panel shows current response text per open, labeled tab.
*Built as:* Capture section on the Replies tab, pulling from the ticked Chat tabs. Captures either the latest assistant message or the current page selection. Reading uses the same shared page adapter as injection, so it covers ChatGPT, Claude and Gemini.

**M2-2 — Select & save (full response or selection)** ✅ *Implemented (local storage)*
Let Dan select all or part of a response and save it to the repository, tagged and linked to its source tab/project.
*Depends on:* CORE-4, CORE-5
*Acceptance:* Saved item appears in the repository, correctly tagged (Status) and linked to source.
*Built as:* Staged captures are editable before saving, so trimming a capture down is the same action as saving a selection. Saved items carry Status `Draft` and a `source` link (platform, tab label, conversation URL). Backed by `chrome.storage.local` until CORE-4 lands, same stand-in as M1-3.

**M2-3 — "Send to prompt" action** ✅ *Implemented*
Route a saved response, or a selection, back into the Prompt Composer (M1-2) as input for a follow-up.
*Depends on:* M1-2, M2-2
*Built as:* "To prompt" on either a staged capture or a saved response, appending the text to the builder as a Scenario block.

**M2-4 — Gemini native-save integration (first pass)**
Where Gemini's native save-to-Drive works, use it as the default path per decision #5 ("start with whichever's easiest").
*Acceptance:* Gemini responses saved via the native path land in the correct project folder.

**M2-5 — Extension-controlled export fallback**
For ChatGPT/Claude (and Gemini if native save proves unreliable), implement the extension's own export-to-Drive path so storage stays consistent across platforms — the migration target from decision #5.
*Acceptance:* Exported response lands in the correct project/data-type folder regardless of source platform.

**M2-6 — Reformat pipeline (P1)**
Select content → specify a reformat instruction → send to another chat/task → auto-file the result to the correct Drive location.

**M2-7 — Alternate export formats (P1)** ⚠️ *Partial*
Export saved responses to plain text/Markdown/PDF in addition to the default.
*Built as:* "Copy MD" puts a saved response on the clipboard as Markdown, including its source link. Writing actual files waits on the Drive work in CORE-4/M2-5.

---

*Sizing and sprint assignment intentionally left open — this is a first ticket breakdown for review, not a committed sprint plan.*
