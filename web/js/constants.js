// Thresholds shared by the dashboard AND the scraper. ONE definition.
//
// This lives under /web because GitHub Pages only serves this directory — the
// dashboard imports it over HTTP, and the scraper imports the same file by
// relative path (../../web/js/constants.js) in Actions. Two copies of a
// threshold is how the Deals tab and the run report end up disagreeing about
// what a deal is, which is the bug class this project keeps getting bitten by.
//
// Deliberately NOT user-configurable: the scraper cannot read a browser's
// localStorage, so a settable threshold would be split-brain by construction.
// A fixed number both halves agree on beats a knob that only one half can see.

/** Percent vs the 90-day average that counts as a deal. Negative = cheaper. */
export const DEAL_PCT = -10;

/**
 * How stale a MANUAL (bookmarklet-captured) price may be and still win BEST.
 * Scraped prices refresh twice a day; captured ones only when he sweeps, so an
 * old capture can otherwise hold the BEST tag against fresh scraped prices.
 */
export const STALE_MANUAL_DAYS = 21;
