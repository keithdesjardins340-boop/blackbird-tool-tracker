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
 *
 * `tool_market_status` enforces this too, and SQL can't import a JS constant —
 * so migration 0017 hardcodes the same number and a DB test asserts the two
 * still agree. Change it here and the test will tell you to change the view.
 */
export const STALE_MANUAL_DAYS = 21;

/**
 * How old a displayed price has to be before we put its age on screen. Under
 * this, the age is noise (everything is a day old); over it, it's the first
 * thing worth knowing about the number.
 */
export const PRICE_AGE_CHIP_DAYS = 7;

/**
 * How long the tool list has to get before a search box earns its place.
 * Below this the whole list fits on a screen and a search box is just chrome.
 */
export const SEARCH_FROM_TOOLS = 15;
