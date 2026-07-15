// Polite HTTP: rotating desktop UA, randomized delays, retry with backoff.

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
];

export function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Random delay in [min, max] ms — call between requests to a dealer. */
export function randomDelay(min = 1500, max = 4500) {
  return sleep(min + Math.floor(Math.random() * (max - min)));
}

/**
 * fetch() with timeout, retry, and exponential backoff + jitter.
 * Retries on network errors and 429/5xx. Returns the response text on success.
 */
export async function fetchText(url, {
  retries = 3,
  timeoutMs = 20000,
  headers = {},
} = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': randomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-CA,en;q=0.9',
          ...headers,
        },
      });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) {
        // 4xx (not 429) — non-retryable
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        err.retryable = false;
        throw err;
      }
      return await res.text();
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      if (err.retryable === false) throw err;
      if (attempt === retries) break;
      const backoff = Math.min(1000 * 2 ** attempt, 15000) + Math.floor(Math.random() * 750);
      await sleep(backoff);
      attempt++;
    }
  }
  throw lastErr;
}
