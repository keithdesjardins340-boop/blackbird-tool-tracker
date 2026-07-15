// Shared adapter interface + HTML extraction helpers.
//
// Every dealer adapter is an object:
//   { dealer, needsJs, async scrape(url, ctx), async search(model, ctx) }
// - scrape(url) -> { price, regular_price, on_sale, in_stock }
// - search(model) -> [{ url, title, price }]   (optional; powers the link finder)
//
// ctx provides { load }: load(url) returns a cheerio $ using plain fetch, or
// Playwright rendering when the adapter declares needsJs.

import * as cheerio from 'cheerio';
import { fetchText } from '../util/http.js';
import { renderHtml } from '../util/browser.js';

/** Parse a price string like "$1,299.99" / "1 299,99 $" into a number. */
export function parsePrice(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (!s) return null;
  // Strip currency words/symbols, keep digits + separators.
  s = s.replace(/[^\d.,]/g, '');
  if (!s) return null;
  // Handle "1 299,99" / "1,299.99" / "1299.99" / "1299,99".
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    // comma is decimal sep
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    // dot is decimal sep (or none)
    s = s.replace(/,/g, '');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Build a cheerio loader bound to an adapter's rendering mode. */
export function makeLoader({ needsJs = false, waitFor } = {}) {
  return async function load(url) {
    const html = needsJs
      ? await renderHtml(url, { waitFor })
      : await fetchText(url);
    return cheerio.load(html);
  };
}

/**
 * Extract all JSON-LD blocks and return the first object matching @type Product.
 * Handles arrays and @graph containers.
 */
export function findJsonLdProduct($) {
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text();
    if (!txt) return;
    try {
      const parsed = JSON.parse(txt);
      blocks.push(parsed);
    } catch {
      /* ignore malformed JSON-LD */
    }
  });
  const flat = [];
  const push = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(push);
    if (Array.isArray(o['@graph'])) o['@graph'].forEach(push);
    flat.push(o);
  };
  blocks.forEach(push);
  const isProduct = (o) => {
    const t = o['@type'];
    return t === 'Product' || (Array.isArray(t) && t.includes('Product'));
  };
  return flat.find(isProduct) || null;
}

/** Pull a normalized offer {price, in_stock} out of a JSON-LD Product node. */
export function offerFromProduct(product) {
  if (!product) return null;
  let offers = product.offers;
  if (Array.isArray(offers)) offers = offers[0];
  if (!offers || typeof offers !== 'object') return null;
  const price = parsePrice(offers.price ?? offers.lowPrice ?? offers.highPrice);
  const avail = String(offers.availability || '').toLowerCase();
  let in_stock = null;
  if (avail) in_stock = avail.includes('instock') || avail.includes('in_stock') || avail.includes('limited');
  return { price, in_stock };
}

/** Meta-tag price fallback (og:price / product:price / itemprop). */
export function metaPrice($) {
  const sel = [
    'meta[property="product:price:amount"]',
    'meta[property="og:price:amount"]',
    'meta[itemprop="price"]',
    '[itemprop="price"]',
  ];
  for (const s of sel) {
    const el = $(s).first();
    if (!el.length) continue;
    const val = el.attr('content') || el.attr('value') || el.text();
    const p = parsePrice(val);
    if (p != null) return p;
  }
  return null;
}

/** Standard result shape, with nulls for anything we couldn't read. parse_via
 * records which extraction strategy produced the price (for diagnostics). */
export function result({ price = null, regular_price = null, on_sale = null, in_stock = null, parse_via = null } = {}) {
  // Infer on_sale when we have both prices and no explicit flag.
  if (on_sale == null && price != null && regular_price != null) {
    on_sale = price < regular_price;
  }
  return { price, regular_price, on_sale, in_stock, parse_via };
}
