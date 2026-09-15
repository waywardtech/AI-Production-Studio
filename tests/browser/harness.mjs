// Booting Chrome with the extension actually loaded.
//
// The Node tests cover everything that can be reasoned about without a
// browser. These cover what can't: IndexedDB, thumbnails, drag and drop,
// and the path a file takes from an extension page through the worker to
// a content script. That path is most of the file work and none of it is
// visible to a fake chrome.*, so it is worth the dependency.
//
// playwright-core is optional and not in package.json: these are run by
// hand, not in `npm test`. tests/browser/README.md says how.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXTENSION_DIR = fileURLToPath(new URL('../../extension/', import.meta.url));
export const TMP = fileURLToPath(new URL('../../.browser-test/', import.meta.url));

// Where Chrome is. Playwright's own download is the usual answer; the
// env var covers a system Chrome or a preinstalled one.
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export async function launchWithExtension({ profile = 'default' } = {}) {
  const { chromium } = await import('playwright-core');
  const userDataDir = path.join(TMP, profile);
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const executablePath = chromePath();
  if (!executablePath) {
    throw new Error('No Chrome found. Set CHROME_PATH to a Chrome or Chromium binary.');
  }

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      '--no-sandbox',
    ],
  });

  // The extension's id is only knowable once it's running; every page
  // URL is built from it.
  let [worker] = ctx.serviceWorkers();
  if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).host;

  return {
    ctx,
    extensionId,
    url: (page) => `chrome-extension://${extensionId}/${page}`,
    async close() {
      await ctx.close();
    },
  };
}

// Opens an extension page and collects anything it logs as an error, so
// a test never passes over a page that was quietly throwing.
export async function openPage(session, pagePath, { watch = true } = {}) {
  const page = await session.ctx.newPage();
  const errors = [];
  if (watch) {
    page.on('pageerror', (e) => errors.push(`${pagePath}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${pagePath}: ${m.text()}`);
    });
  }
  await page.goto(session.url(pagePath));
  await page.waitForTimeout(1200);
  page.collectedErrors = errors;
  return page;
}

// A chat page the content script will attach to, without touching the
// real site or an account. `body` is the markup under test.
export async function serveStandInChat(session, body, { host = 'https://chatgpt.com/**' } = {}) {
  await session.ctx.route(host, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: `<!DOCTYPE html><title>Stand-in chat</title>${body}` })
  );
}

export function makeRunner(name) {
  const failures = [];
  let passed = 0;

  return {
    async step(label, fn) {
      try {
        await fn();
        passed += 1;
        console.log(`  ok    ${label}`);
      } catch (error) {
        failures.push(`${label}: ${error.message}`);
        console.log(`  FAIL  ${label}\n        ${error.message}`);
      }
    },
    fail(message) {
      failures.push(message);
      console.log(`  FAIL  ${message}`);
    },
    finish() {
      console.log(`\n${passed} passed, ${failures.length} failed`);
      if (failures.length) process.exit(1);
    },
    get failures() {
      return failures;
    },
  };
}
