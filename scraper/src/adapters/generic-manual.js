// Catch-all adapter for MANUALLY PASTED dealer links (the "Other" dealer, and
// any dealer row without a dedicated adapter). It doesn't know the site's layout,
// so it tries, in order: JSON-LD Product offer → price meta tags → a currency
// amount inside any element whose class/id mentions "price". Most Canadian retail
// product pages expose at least one of these on a plain server-rendered fetch.
//
// No search()/autoMap — manual links are seeded by the user, not discovered.

import { makeLoader, parsePrice, findJsonLdProduct, offerFromProduct, metaPrice, result } from './base.js';

const CURRENCY_RE = /\$\s?([\d]{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})/;

// Heuristic: scan price-flavoured elements for a currency amount. Kept narrow
// (class/id/data-attr must mention "price") so we don't grab shipping thresholds
// or "you save" figures elsewhere on the page.
function priceFromMarkup($) {
  let found = null;
  $('[data-price], [class*="price" i], [id*="price" i]').each((_, el) => {
    if (found != null) return;
    const dp = $(el).attr('data-price') || $(el).attr('content');
    if (dp) { const p = parsePrice(dp); if (p != null && p > 0) { found = p; return; } }
    const m = CURRENCY_RE.exec($(el).text());
    if (m) { const p = parsePrice(m[1]); if (p != null && p > 0) found = p; }
  });
  return found;
}

const genericManual = {
  dealer: 'Other',
  needsJs: false,

  async scrape(productUrl) {
    const $ = await makeLoader({ needsJs: false })(productUrl);

    const ld = offerFromProduct(findJsonLdProduct($));
    let price = ld?.price ?? null;
    let in_stock = ld?.in_stock ?? null;

    if (price == null) price = metaPrice($);
    if (price == null) price = priceFromMarkup($);
    if (price == null) throw new Error(`price not found (manual link) ${productUrl}`);

    if (in_stock == null) {
      const txt = ($('main').text() || $('body').text()).toLowerCase();
      if (/out of stock|sold out|unavailable|discontinued|back ?order/.test(txt)) in_stock = false;
      else if (/add to cart|in stock|available|buy now/.test(txt)) in_stock = true;
    }
    return result({ price, in_stock });
  },
};

export default genericManual;
