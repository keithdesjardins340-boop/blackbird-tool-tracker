// KMS Tools (kmstools.com) — Shopify-style storefront, typically ships Product
// JSON-LD, so plain fetch + cheerio works (needsJs:false). Verify first CI run.
import { makeJsonLdAdapter } from './generic.js';

export default makeJsonLdAdapter({
  dealer: 'KMS Tools',
  origin: 'https://www.kmstools.com',
  needsJs: false,
  priceSelector: '[class*="price" i], .price__current, [data-product-price]',
  regularSelector: '.price__was, s, del, [class*="compare" i]',
  productHrefMatch: '/products/',
  searchUrl: (q) => `https://www.kmstools.com/search?q=${encodeURIComponent(q)}`,
});
