// Home Depot Canada (homedepot.ca) — Angular "acl" storefront on an Akamai edge.
//
// Reverse-engineered 2026-07-15: the PRODUCT PAGE is server-rendered with the
// price embedded as JSON — `"price":{"currencyIso":"CAD","value":328,
// "priceType":"BUY",...}` and a store `"displayPrice":{...,"value":328}` keyed
// by productId, plus `"inStock"`. Plain fetch of the product page works.
//
// The /search and /api/catalogsvc/* paths are Akamai-blocked (403) to
// non-browsers, so HD has NO auto-map search — listings are seeded via the link
// finder / web search, then priced automatically here. NOTE: this was validated
// from a residential IP; if GitHub Actions' datacenter IP also gets 403 on
// product pages, HD won't scrape from CI — watch the Health tab after first run.

import { fetchText } from '../util/http.js';
import { parsePrice, result } from './base.js';

function extractPrice(html, pid) {
  let price = null, regular_price = null, in_stock = null;

  // 1) Price object tied to this productId (store display price).
  if (pid) {
    const anchor = html.indexOf(`"productId":"${pid}"`);
    if (anchor >= 0) {
      const w = html.slice(Math.max(0, anchor - 100), anchor + 900);
      const dp = w.match(/"displayPrice":\{[^{}]*?"value":([0-9.]+)/);
      if (dp) price = parsePrice(dp[1]);
      const op = w.match(/"(?:originalPrice|wasPrice|regularPrice|strikeThroughPrice)":\{[^{}]*?"value":([0-9.]+)/);
      if (op) regular_price = parsePrice(op[1]);
    }
  }
  // 2) Fallback: the main product's BUY price.
  if (price == null) {
    const m = html.match(/"price":\{"currencyIso":"CAD","value":([0-9.]+),"priceType":"BUY"/);
    if (m) price = parsePrice(m[1]);
  }
  const sm = html.match(/"inStock":"([^"]*)"/i);
  if (sm) in_stock = /in\s*stock/i.test(sm[1]);
  if (regular_price != null && price != null && regular_price <= price) regular_price = null;

  return { price, regular_price, in_stock };
}

export default {
  dealer: 'Home Depot Canada',
  needsJs: false,
  // autoMap intentionally omitted — HD search is Akamai-blocked; seed listings
  // via the link finder, then this adapter keeps them priced.

  async scrape(productUrl) {
    const html = await fetchText(productUrl, { timeoutMs: 30000 });
    const m = productUrl.match(/\/(\d{6,})(?:[/?#]|$)/);
    const { price, regular_price, in_stock } = extractPrice(html, m ? m[1] : null);
    if (price == null) throw new Error(`HD price not found (page structure changed or blocked): ${productUrl}`);
    return result({ price, regular_price, in_stock, parse_via: 'json-embed' });
  },
};
