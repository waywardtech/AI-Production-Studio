# Browser harness

For driving the extension's pages in an ordinary browser tab, where
`chrome.*` doesn't exist.

- `chrome-stub.js` — an in-memory `chrome.storage`, and simulated chat
  tabs. Each tab's `input` is *replaced* on every write, the way the real
  adapter's select-all-and-insert behaves, so tests can see exactly what
  is sitting in a generator's prompt box at any moment.
- `seed-studio.js` — loads a production saved in the older format
  (legacy out-box clip entries, scenes with no profile tracking) when the
  page URL contains `?seed`.

To use: copy the extension folder somewhere, add
`<script src="…/chrome-stub.js"></script>` (and the seed, if wanted)
before the page's module script, serve it over HTTP, and open the page.
