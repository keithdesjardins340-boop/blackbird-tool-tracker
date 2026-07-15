// Home Depot Canada (homedepot.ca) — React storefront with anti-bot measures.
// Price is often client-rendered, so route through Playwright (needsJs:true).
// Best-effort; expect to refine selectors after the first CI run.
import { makeJsonLdAdapter } from './generic.js';

export default makeJsonLdAdapter({
  dealer: 'Home Depot Canada',
  origin: 'https://www.homedepot.ca',
  needsJs: true,
  waitFor: '[class*="price" i], [data-testid*="price" i]',
  priceSelector: '[data-testid*="price" i], [class*="price" i]',
  regularSelector: '[class*="was" i], [class*="regular" i], s, del',
  productHrefMatch: '/product/',
  searchUrl: (q) => `https://www.homedepot.ca/search?q=${encodeURIComponent(q)}`,
});
