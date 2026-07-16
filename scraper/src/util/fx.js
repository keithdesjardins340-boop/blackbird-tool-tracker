// Currency → CAD conversion, so every price in the app is comparable.
//
// Source: the Bank of Canada's Valet API — official, free, no key, and CAD-based
// by definition (series are named FX<CUR>CAD). Rates are the daily noon-ish
// observation; that's the right granularity for a twice-daily price tracker.
//
// Fail-CLOSED on purpose: if a page declares a non-CAD price and we cannot get a
// rate, we THROW rather than store the raw number. Storing an unconverted USD
// amount in `price_cad` is worse than having no snapshot — it silently corrupts
// best-price, the 90-day average, and the anomaly gate. A missing snapshot is
// visible in the run report; a wrong one is not.

import { fetchText } from './http.js';

// Bank of Canada publishes FX<CUR>CAD for these. Anything else → unsupported.
const SERIES = {
  USD: 'FXUSDCAD', EUR: 'FXEURCAD', GBP: 'FXGBPCAD', AUD: 'FXAUDCAD',
  JPY: 'FXJPYCAD', CHF: 'FXCHFCAD', MXN: 'FXMXNCAD', CNY: 'FXCNYCAD',
};

const cache = new Map(); // CUR -> rate, for this process/run only

/** Normalize a currency string to a 3-letter code. Blank/unknown → null. */
export function normCurrency(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(s)) return s;
  if (s === '$' || s === 'C$' || s === 'CA$' || s === 'CAD$') return 'CAD';
  return null;
}

/** CAD per 1 unit of `cur`. Throws if we can't get a trustworthy rate. */
export async function rateToCad(cur) {
  if (cur === 'CAD') return 1;
  if (cache.has(cur)) return cache.get(cur);
  const series = SERIES[cur];
  if (!series) throw new Error(`no CAD conversion rate available for ${cur}`);
  const url = `https://www.bankofcanada.ca/valet/observations/${series}/json?recent=1`;
  const json = JSON.parse(await fetchText(url, { headers: { Accept: 'application/json' }, timeoutMs: 12000, retries: 2 }));
  const obs = (json.observations || [])[0];
  const rate = Number(obs?.[series]?.v);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`bad ${cur}→CAD rate from Bank of Canada`);
  cache.set(cur, rate);
  return rate;
}

/**
 * Convert a scrape result's prices to CAD.
 * Returns { price_cad, regular_price_cad, currency, price_original, fx_rate }.
 * An undeclared currency is assumed CAD (the status quo for Canadian dealers).
 */
export async function toCad({ price, regular_price, currency }) {
  const cur = normCurrency(currency) || 'CAD';
  const fx_rate = await rateToCad(cur); // throws on a non-CAD price we can't convert
  const conv = (v) => (v == null ? null : Math.round(v * fx_rate * 100) / 100);
  return {
    price_cad: conv(price),
    regular_price_cad: conv(regular_price),
    currency: cur,
    price_original: cur === 'CAD' ? null : price, // only worth storing when it differs
    fx_rate,
  };
}
