// Princess Auto adapter.
//
// princessauto.com is a Next.js SPA (SAP Commerce/Hybris backend). The price is
// rendered client-side and is NOT in the initial HTML, so this adapter needs JS
// rendering (needsJs = true) — Playwright loads the page, we wait for a price
// element, then parse the rendered DOM with cheerio.
//
// CSS class names are hashed (CSS modules like `_price_eyx1e_1`), so we do NOT
// rely on exact class names. Instead we target elements whose class CONTAINS
// "price" and read currency-formatted text. This survives class-hash changes.
//
// NOTE: selectors were derived from the live DOM structure but could not be
// exercised end-to-end from the build machine (no Node here). Verify the first
// CI run's snapshot; tweak CURRENCY_RE / price selection if a dealer redesign
// shifts things.

import { makeLoader, parsePrice, findJsonLdProduct, offerFromProduct, metaPrice, result } from './base.js';

const CURRENCY_RE = /\$\s?([\d]{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})/g;

function pricesIn(text) {
  if (!text) return [];
  return [...text.matchAll(CURRENCY_RE)].map((m) => parsePrice(m[1])).filter((n) => n != null);
}

function extractPrices($) {
  // 1) Prefer JSON-LD Product offer if present (future-proofing; today PA only
  //    ships an Organization block, so this is usually null).
  const ld = offerFromProduct(findJsonLdProduct($));
  if (ld && ld.price != null) return { price: ld.price, regular_price: null, in_stock: ld.in_stock };

  // 2) Elements whose class mentions "price". Struck / "was" / "regular" nodes
  //    are the regular price; the remaining prominent one is the current price.
  const priceNodes = $('[class*="price" i], [data-testid*="price" i]');
  let current = null;
  let regular = null;

  priceNodes.each((_, el) => {
    const $el = $(el);
    const cls = ($el.attr('class') || '').toLowerCase();
    const testid = ($el.attr('data-testid') || '').toLowerCase();
    const tag = el.tagName?.toLowerCase();
    const isStruck =
      tag === 'del' || tag === 's' ||
      /strike|regular|was|old|list|compare/.test(cls + ' ' + testid) ||
      $el.find('del, s').length > 0;
    const vals = pricesIn($el.text());
    if (!vals.length) return;
    const v = vals[0];
    if (isStruck) {
      if (regular == null || v > regular) regular = v;
    } else if (current == null) {
      current = v;
    }
  });

  // 3) Meta fallback.
  if (current == null) current = metaPrice($);

  // 4) Last resort: scan the whole document text; smallest is usually the sale
  //    price, largest the regular — but only trust this if we found nothing else.
  if (current == null) {
    const all = pricesIn($('main').text() || $('body').text());
    if (all.length) {
      current = Math.min(...all);
      if (all.length > 1) regular = Math.max(...all);
    }
  }

  return { price: current, regular_price: regular, in_stock: null };
}

function extractStock($) {
  const txt = ($('main').text() || $('body').text()).toLowerCase();
  // Enabled add-to-cart or "available" => in stock. Explicit OOS phrases => out.
  if (/out of stock|sold out|unavailable|no longer available|discontinued/.test(txt)) return false;
  if (/add to cart|in stock|available for pickup|ship to|available online|available\b/.test(txt)) return true;
  return null;
}

export default {
  dealer: 'Princess Auto',
  needsJs: true,

  async scrape(productUrl) {
    const load = makeLoader({ needsJs: true, waitFor: '[class*="price" i]' });
    const $ = await load(productUrl);
    const { price, regular_price, in_stock } = extractPrices($);
    if (price == null) {
      throw new Error('price not found (page structure may have changed)');
    }
    const stock = in_stock != null ? in_stock : extractStock($);
    return result({ price, regular_price, in_stock: stock });
  },

  // Best-effort site search for the link finder. Returns candidate product URLs.
  async search(modelNumber) {
    const q = encodeURIComponent(modelNumber);
    const searchUrl = `https://www.princessauto.com/en/search?text=${q}`;
    const load = makeLoader({ needsJs: true, waitFor: 'a[href*="/product/"]' });
    let $;
    try {
      $ = await load(searchUrl);
    } catch {
      return [];
    }
    const seen = new Set();
    const out = [];
    $('a[href*="/product/"]').each((_, el) => {
      let href = $(el).attr('href') || '';
      if (!href) return;
      if (href.startsWith('/')) href = 'https://www.princessauto.com' + href;
      if (!/\/product\//.test(href) || seen.has(href)) return;
      seen.add(href);
      const title = $(el).text().trim() || $(el).attr('title') || '';
      const price = pricesIn($(el).closest('[class*="product" i], li, article').text())[0] ?? null;
      out.push({ url: href, title: title.slice(0, 160), price });
    });
    return out.slice(0, 15);
  },
};
