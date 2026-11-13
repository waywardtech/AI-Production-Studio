# Browser tests

The tests in `tests/` run in Node against a fake `chrome.*`, which covers
everything that can be reasoned about without a browser. These cover what
can't be: IndexedDB, thumbnails, file drops, and the path a file takes
from an extension page, through the background worker, into a content
script on a page.

They load the unpacked extension into a real Chrome.

```
npm install --no-save playwright-core
npm run test:browser
```

`CHROME_PATH=/path/to/chrome` if Chrome isn't somewhere obvious. Scratch
files go to `.browser-test/`, which is ignored.

## What each one covers

| File | Covers |
|---|---|
| `intake.browser.mjs` | Importing a mixed batch: what becomes an asset, what becomes an In-box script, where the bytes go, thumbnails, delete, and the Drive permission message |
| `page-check.browser.mjs` | **Check page** against a page the content script really runs on |
| `attachments.browser.mjs` | A file going all the way from the studio into a page's file input, including one larger than a single message |
| `stall-relay.browser.mjs` | A tab whose main thread is genuinely locked: Insert gives up on it at the relay's deadline and reaches the clipboard fallback. Takes ~20 s, because the real 15 s deadline has to run out |
| `roundtrip.browser.mjs` | A whole round trip through a chat tab: Optimize writes its request, the waiting dialog ignores the answer already on screen, waits out one that is still streaming, and hands it over whole |

## The stand-in chat page

`serveStandInChat` routes `chatgpt.com` to markup the test controls, so
the content script runs for real without touching the site or an account.

That makes these tests honest about their limits: they prove the
machinery — chunking, reassembly, `DataTransfer`, the change event — and
say nothing about whether ChatGPT's own markup still looks like the
selectors in `chat-adapter.js`. **Check page** in the side panel is the
tool for that, run against the real sites.
