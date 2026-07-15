// KMS Tools (kmstools.com) — Magento + Hyva storefront.
//
// - PRICE: product pages are server-rendered and expose a JSON-LD Product offer
//   (and itemprop=price), so plain fetch + cheerio works — no browser needed.
// - SEARCH: the Magento search path is WAF-blocked to non-browsers (403), but
//   KMS uses SearchSpring for search, whose JSON API is open and returns
//   name/url/price/sku directly. That makes SKU-based auto-mapping reliable.

import { makeLoader, findJsonLdProduct, offerFromProduct, metaPrice, result, parsePrice, mpnFromProduct } from './base.js';
import { fetchText } from '../util/http.js';

const SS_SITE = 'skg4w4'; // KMS SearchSpring siteId (from snapui.searchspring.io/skg4w4/bundle.js)

export async function searchSpring(query, limit = 8) {
  const url = `https://${SS_SITE}.a.searchspring.io/api/search/search.json`
    + `?siteId=${SS_SITE}&resultsFormat=native&pageSize=${limit}&q=${encodeURIComponent(query)}`;
  let data;
  try {
    data = JSON.parse(await fetchText(url, { headers: { Accept: 'application/json' } }));
  } catch {
    return [];
  }
  return (data.results || [])
    .map((r) => ({
      url: r.url,
      title: r.name,
      price: parsePrice(r.price),
      regular_price: parsePrice(r.msrp) || null,
      sku: r.sku || r.mfr_part_number || '',
      // Manufacturer part number, for harvesting onto no-PN tools (KMS JSON-LD is
      // JS-injected so scrape-time mpn extraction misses it — grab it here).
      mpn: r.mfr_part_number || r.sku || null,
    }))
    .filter((r) => r.url);
}

export default {
  dealer: 'KMS Tools',
  needsJs: false,
  autoMap: true, // reliable SearchSpring search → safe to auto-map

  async scrape(productUrl) {
    const $ = await makeLoader({ needsJs: false })(productUrl);
    const product = findJsonLdProduct($);
    const ld = offerFromProduct(product);
    const price = ld?.price ?? metaPrice($);
    if (price == null) throw new Error(`KMS price not found (${productUrl})`);
    const parse_via = ld?.price != null ? 'json-ld' : 'meta';

    // Hyva shows the pre-sale price as an "old price" when on sale.
    let regular_price = null;
    const oldTxt = $('[data-price-type="oldPrice"], .old-price .price, .price-box .old-price').first().text();
    const rp = parsePrice(oldTxt);
    if (rp && rp > price) regular_price = rp;

    return result({ price, regular_price, in_stock: ld?.in_stock ?? null, parse_via, mpn: mpnFromProduct(product) });
  },

  async search(model) {
    return searchSpring(model);
  },
};
