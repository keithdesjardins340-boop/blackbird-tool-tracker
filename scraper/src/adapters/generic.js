// Factory for a "standard" dealer adapter: try JSON-LD Product offer first,
// then meta/price selectors. Works for dealers that server-render price data
// (KMS, Home Depot CA). Set needsJs:true to route through Playwright instead.
//
// Each generated adapter still fits the shared interface, so failures at one
// dealer are isolated by the runner and never crash the batch.

import { makeLoader, parsePrice, findJsonLdProduct, offerFromProduct, metaPrice, result } from './base.js';

const CURRENCY_RE = /\$\s?([\d]{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})/g;
const pricesIn = (t) => (t ? [...t.matchAll(CURRENCY_RE)].map((m) => parsePrice(m[1])).filter((n) => n != null) : []);

export function makeJsonLdAdapter({
  dealer,
  origin,
  needsJs = false,
  priceSelector,          // optional CSS hint for the current price
  regularSelector,        // optional CSS hint for the struck/list price
  searchUrl,              // fn(query) -> search URL
  productHrefMatch = '/product/',
  waitFor,
}) {
  return {
    dealer,
    needsJs,

    async scrape(productUrl) {
      const load = makeLoader({ needsJs, waitFor: waitFor || priceSelector });
      const $ = await load(productUrl);

      // 1) JSON-LD Product
      const ld = offerFromProduct(findJsonLdProduct($));
      let price = ld?.price ?? null;
      let in_stock = ld?.in_stock ?? null;
      let regular_price = null;

      // 2) selector hints
      if (price == null && priceSelector) price = pricesIn($(priceSelector).first().text())[0] ?? null;
      if (regularSelector) regular_price = pricesIn($(regularSelector).first().text())[0] ?? null;

      // 3) meta fallback
      if (price == null) price = metaPrice($);

      if (price == null) throw new Error(`price not found for ${dealer} (${productUrl})`);

      if (in_stock == null) {
        const txt = ($('main').text() || $('body').text()).toLowerCase();
        if (/out of stock|sold out|unavailable|discontinued/.test(txt)) in_stock = false;
        else if (/add to cart|in stock|available/.test(txt)) in_stock = true;
      }
      return result({ price, regular_price, in_stock });
    },

    async search(modelNumber) {
      if (!searchUrl) return [];
      const load = makeLoader({ needsJs, waitFor: `a[href*="${productHrefMatch}"]` });
      let $;
      try { $ = await load(searchUrl(modelNumber)); } catch { return []; }
      const seen = new Set();
      const out = [];
      $(`a[href*="${productHrefMatch}"]`).each((_, el) => {
        let href = $(el).attr('href') || '';
        if (!href) return;
        if (href.startsWith('/')) href = origin + href;
        if (seen.has(href)) return;
        seen.add(href);
        const title = ($(el).text().trim() || $(el).attr('title') || '').slice(0, 160);
        out.push({ url: href, title, price: null });
      });
      return out.slice(0, 15);
    },
  };
}
