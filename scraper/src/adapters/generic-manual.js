// Catch-all adapter for MANUALLY PASTED dealer links (the "Other" dealer, and
// any dealer row without a dedicated adapter). It doesn't know the site's layout,
// so it tries, in order: JSON-LD Product offer → price meta tags → a currency
// amount inside any element whose class/id mentions "price". Most Canadian retail
// product pages expose at least one of these on a plain server-rendered fetch.
//
// No search()/autoMap — manual links are seeded by the user, not discovered.

import { makeLoader, parsePrice, findJsonLdProduct, offerFromProduct, metaPrice, metaCurrency, result, mpnFromProduct } from './base.js';

const CURRENCY_RE = /\$\s?([\d]{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})/;

// Sections whose prices are NOT this product's price: opt-in add-ons, warranty /
// calibration upsells, accessories, "customers also bought", related items. They
// are usually cheap, so grabbing one silently invents a bargain.
// Real example (myflukestore.ca): a $135 warranty checkbox inside `.incentives-`
// sits ABOVE the real <h2 class="productpage-price">$725.67</h2> in the DOM, so a
// naive first-match reads the add-on and reports the meter at $135.
const NOT_PRODUCT_PRICE = /incentive|add-?on|upsell|cross-?sell|related|recommend|accessor|warrant|bundle|also-?bought|you-?may|similar/i;

function inExcludedSection($, el) {
  return $(el).parents().toArray().some((p) => {
    const attrs = `${$(p).attr('class') || ''} ${$(p).attr('id') || ''}`;
    return NOT_PRODUCT_PRICE.test(attrs);
  });
}

// Heuristic: scan price-flavoured elements for a currency amount. Kept narrow
// (class/id/data-attr must mention "price") so we don't grab shipping thresholds
// or "you save" figures elsewhere on the page — and skipping add-on/related
// sections so we price the product, not an upsell.
function priceFromMarkup($) {
  let found = null;
  $('[data-price], [class*="price" i], [id*="price" i]').each((_, el) => {
    if (found != null) return;
    if (inExcludedSection($, el)) return;
    const dp = $(el).attr('data-price') || $(el).attr('content');
    if (dp) { const p = parsePrice(dp); if (p != null && p > 0) { found = p; return; } }
    const m = CURRENCY_RE.exec($(el).text());
    if (m) { const p = parsePrice(m[1]); if (p != null && p > 0) found = p; }
  });
  return found;
}

/**
 * Read a price out of an already-loaded page. Split from scrape() so the
 * extraction order (JSON-LD → meta → markup) and the add-on skipping can be
 * tested against a saved fixture — the myflukestore $135-warranty bug is a
 * pure parsing bug, and needs no network to catch.
 * `where` is only used for the error message.
 */
export function extractManualPrice($, where = 'manual link') {
  const product = findJsonLdProduct($);
  const ld = offerFromProduct(product);
  let price = ld?.price ?? null;
  let in_stock = ld?.in_stock ?? null;
  let parse_via = price != null ? 'json-ld' : null;
  // A pasted link can point anywhere, including US sites — so whatever the page
  // declares its currency to be, carry it through and let run.js convert to CAD.
  let currency = ld?.currency ?? null;

  if (price == null) { const m = metaPrice($); if (m != null) { price = m; parse_via = 'meta'; } }
  if (price == null) { const k = priceFromMarkup($); if (k != null) { price = k; parse_via = 'markup'; } }
  if (price == null) throw new Error(`price not found (${where})`);
  if (!currency) currency = metaCurrency($);

  if (in_stock == null) {
    const txt = ($('main').text() || $('body').text()).toLowerCase();
    if (/out of stock|sold out|unavailable|discontinued|back ?order/.test(txt)) in_stock = false;
    else if (/add to cart|in stock|available|buy now/.test(txt)) in_stock = true;
  }
  return result({ price, in_stock, parse_via, currency, mpn: mpnFromProduct(product) });
}

const genericManual = {
  dealer: 'Other',
  needsJs: false,

  async scrape(productUrl) {
    const $ = await makeLoader({ needsJs: false })(productUrl);
    return extractManualPrice($, productUrl);
  },
};

export default genericManual;
