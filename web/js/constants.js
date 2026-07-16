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

/**
 * Cross-dealer sanity band: a price this far from what a tool's OTHER dealers
 * charge is a bad read, not a bargain.
 *
 * This is the myflukestore trap's second line of defence — a link that reads a
 * $135 warranty add-on instead of the $725 meter is wrong EVERY time, so
 * comparing a listing to itself never catches it. Comparing it to its siblings
 * does.
 *
 * Used by `run.js` (flag the snapshot), the writer's `reflagOutliers` (re-judge
 * a revived link's history), and the discovery matcher (drop an obviously-wrong
 * candidate before it ever reaches him). The writer keeps its own literal copy
 * because the Edge Function can't import from /web — a test pins the two
 * together, so they can't drift.
 */
export const PRICE_SANITY_MAX_RATIO = 4;
export const PRICE_SANITY_MIN_RATIO = 0.25;
