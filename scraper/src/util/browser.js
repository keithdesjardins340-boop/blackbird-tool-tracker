// Lazily-created shared Playwright browser, only spun up when an adapter needs
// JS rendering (adapter.needsJs === true). Closed once at end of the batch.

import { randomUserAgent, sleep } from './http.js';

let _browser = null;

async function getBrowser() {
  if (_browser) return _browser;
  const { chromium } = await import('playwright');
  _browser = await chromium.launch({ headless: true });
  return _browser;
}

/**
 * Load a URL in a fresh context and return the fully-rendered HTML.
 * waitFor: optional selector to wait for before capturing.
 */
export async function renderHtml(url, { waitFor, timeoutMs = 30000 } = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: randomUserAgent(),
    locale: 'en-CA',
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: timeoutMs }).catch(() => {});
    }
    await sleep(500 + Math.floor(Math.random() * 1000));
    return await page.content();
  } finally {
    await context.close();
  }
}

export async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}
