// Canadian Tire (canadiantire.ca) — Phase 2, BEST-EFFORT. Heavy anti-bot +
// store-specific pricing; expect breakage. Marked 'beta' in the dealers table.
// Failures are isolated by the runner and logged to scrape_runs.
import { makeJsonLdAdapter } from './generic.js';

export default makeJsonLdAdapter({
  dealer: 'Canadian Tire',
  origin: 'https://www.canadiantire.ca',
  needsJs: true,
  waitFor: '[class*="price" i], [data-testid*="price" i]',
  priceSelector: '[data-testid*="price" i], [class*="price" i]',
  regularSelector: '[class*="was" i], [class*="regular" i], s, del',
  productHrefMatch: '/pdp/',
  searchUrl: (q) => `https://www.canadiantire.ca/en/search-results.html?q=${encodeURIComponent(q)}`,
});
