// Batch runner: for each active dealer, scrape every active listing sequentially
// (per-dealer concurrency = 1), write a price_snapshot per success, and log every
// failure into a scrape_runs row. One listing or dealer breaking never aborts
// the batch.
//
// Usage:
//   node src/run.js                      # all active + beta dealers
//   node src/run.js --dealer "KMS Tools" # single dealer

import { supabase } from './supabase.js';
import { getScrapeAdapter } from './adapters/index.js';
import { randomDelay } from './util/http.js';
import { closeBrowser } from './util/browser.js';
import { toCad } from './util/fx.js';
import { fxStore } from './util/fx-store.js';
// The same band the discovery matcher and the writer's reflagOutliers use — one
// definition of "that price is a bad read, not a bargain".
import { PRICE_SANITY_MAX_RATIO, PRICE_SANITY_MIN_RATIO } from '../../web/js/constants.js';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

// Guard against a bad parse poisoning the stats: flag a price that's non-positive
// or wildly off the listing's recent (clean) median. Flagged snapshots are still
// recorded but excluded from every stats view. Needs >=3 points of history to
// judge, so genuine early price moves aren't mistaken for errors.
async function isAnomaly(listingId, price) {
  if (price == null || price <= 0) return true;
  const { data } = await supabase
    .from('price_snapshots')
    .select('price_cad')
    .eq('listing_id', listingId)
    .eq('is_anomaly', false)
    .order('scraped_at', { ascending: false })
    .limit(5);
  const prices = (data || []).map((r) => Number(r.price_cad)).filter((n) => n > 0).sort((a, b) => a - b);
  if (prices.length < 3) return false;
  const median = prices[Math.floor(prices.length / 2)];
  return median > 0 && (price > median * 5 || price < median * 0.2);
}

// Cross-dealer sanity: the gate above only compares a listing to ITSELF, so a link
// that is wrong EVERY time (a parser grabbing an add-on, an accessory, a deposit)
// looks perfectly stable and would be crowned "best price". Compare against what
// other dealers charge for the SAME tool instead — a price wildly out of line with
// its siblings is a bad read, not a bargain. Needs >=2 siblings to have an opinion.
async function isOutlierVsSiblings(listingId, toolId, price) {
  if (!toolId || price == null || price <= 0) return false;
  const { data: sibs } = await supabase
    .from('tool_listings').select('id')
    .eq('tool_id', toolId).eq('active', true).neq('id', listingId);
  const ids = (sibs || []).map((s) => s.id);
  if (ids.length < 2) return false;
  const { data: snaps } = await supabase
    .from('price_snapshots').select('listing_id,price_cad,scraped_at')
    .in('listing_id', ids).eq('is_anomaly', false)
    .order('scraped_at', { ascending: false });
  const latest = new Map(); // newest clean price per sibling listing
  for (const s of snaps || []) if (!latest.has(s.listing_id)) latest.set(s.listing_id, Number(s.price_cad));
  const prices = [...latest.values()].filter((n) => n > 0).sort((a, b) => a - b);
  if (prices.length < 2) return false;
  const median = prices[Math.floor(prices.length / 2)];
  return median > 0
    && (price > median * PRICE_SANITY_MAX_RATIO || price < median * PRICE_SANITY_MIN_RATIO);
}

async function scrapeDealer(dealer) {
  // Falls back to the generic manual-link adapter for any dealer without a
  // dedicated one, so pasted links from arbitrary sites still get priced.
  const adapter = getScrapeAdapter(dealer.name);

  const { data: listings, error: lErr } = await supabase
    .from('tool_listings')
    .select('id, product_url, tool_id, mpn')
    .eq('dealer_id', dealer.id)
    .eq('active', true);
  if (lErr) throw lErr;

  console.log(`\n=== ${dealer.name}: ${listings?.length || 0} active listing(s) ===`);

  // Open a run row.
  const { data: run, error: rErr } = await supabase
    .from('scrape_runs')
    .insert({ dealer_id: dealer.id })
    .select('id')
    .single();
  if (rErr) throw rErr;

  let ok = 0;
  let fail = 0;
  const errorLog = [];

  for (const listing of listings || []) {
    try {
      const res = await adapter.scrape(listing.product_url);
      // Normalize to CAD first — everything downstream (anomaly gate, best price,
      // 90-day average) assumes price_cad really is CAD. A non-CAD price we can't
      // convert throws here and is logged as a failure rather than stored wrong.
      // fxStore lets a Valet outage fall back to the last rate we saw (up to a
      // week old, recorded as such) instead of losing every non-CAD price in the
      // run. Still fails closed beyond that.
      const fx = await toCad(res, fxStore);
      const anomaly = (await isAnomaly(listing.id, fx.price_cad))
        || (await isOutlierVsSiblings(listing.id, listing.tool_id, fx.price_cad));
      const { error: sErr } = await supabase.from('price_snapshots').insert({
        listing_id: listing.id,
        price_cad: fx.price_cad,
        regular_price_cad: fx.regular_price_cad,
        on_sale: res.on_sale,
        in_stock: res.in_stock,
        is_anomaly: anomaly,
        parse_via: res.parse_via ?? null,
        currency: fx.currency,
        price_original: fx.price_original,
        fx_rate: fx.fx_rate,
      });
      if (sErr) throw sErr;
      // Harvest the manufacturer part number off the page (for the app's
      // one-tap "Set part #" on tools that still have no PN).
      if (res.mpn && res.mpn !== listing.mpn) {
        await supabase.from('tool_listings').update({ mpn: res.mpn }).eq('id', listing.id);
      }
      ok++;
      const conv = fx.currency !== 'CAD' ? `  (${fx.price_original} ${fx.currency} @ ${fx.fx_rate})` : '';
      console.log(`  ok  listing ${listing.id}  $${fx.price_cad} CAD${conv}${res.on_sale ? ' (sale)' : ''}${anomaly ? '  !! ANOMALY (excluded from stats)' : ''}`);
    } catch (err) {
      fail++;
      const entry = { listing_id: listing.id, url: listing.product_url, error: String(err?.message || err) };
      // Link rot: a 404/410 means the product page is gone for good — stop
      // tracking this listing (its price history is kept) and note it in the run.
      if (err?.status === 404 || err?.status === 410) {
        await supabase.from('tool_listings').update({ active: false }).eq('id', listing.id);
        entry.deactivated = `HTTP ${err.status}`;
        console.warn(`  DEAD listing ${listing.id} (HTTP ${err.status}) → deactivated`);
      }
      errorLog.push(entry);
      console.warn(`  FAIL listing ${listing.id}: ${entry.error}`);
    }
    await randomDelay(); // polite pacing between requests to this dealer
  }

  await supabase
    .from('scrape_runs')
    .update({ finished_at: new Date().toISOString(), ok_count: ok, fail_count: fail, error_log: errorLog })
    .eq('id', run.id);

  // Health signal only — the runner still retries 'broken' dealers so they can
  // recover. Flag broken when every listing failed; heal back to active on any
  // success. Never downgrade a 'beta' dealer.
  const hadListings = (listings?.length || 0) > 0;
  if (hadListings && ok === 0 && dealer.scraper_status !== 'beta') {
    await supabase.from('dealers').update({ scraper_status: 'broken' }).eq('id', dealer.id);
    console.warn(`  ! ${dealer.name} flagged 'broken' (0/${listings.length} succeeded)`);
  } else if (ok > 0 && dealer.scraper_status === 'broken') {
    await supabase.from('dealers').update({ scraper_status: 'active' }).eq('id', dealer.id);
    console.log(`  ~ ${dealer.name} recovered → active`);
  }

  console.log(`  --> ${dealer.name}: ${ok} ok, ${fail} fail`);
}

async function main() {
  const only = arg('--dealer');
  let q = supabase.from('dealers').select('id, name, scraper_status');
  // Include 'broken' so a dealer that failed once still gets retried and can
  // self-heal — otherwise one transient failure disables it forever.
  if (only) q = q.eq('name', only);
  else q = q.in('scraper_status', ['active', 'beta', 'broken']);

  const { data: dealers, error } = await q;
  if (error) throw error;
  if (!dealers?.length) {
    console.log('No dealers to scrape.');
    return;
  }

  // Dealers processed one at a time (keeps total load low + honors concurrency 1).
  for (const dealer of dealers) {
    try {
      await scrapeDealer(dealer);
    } catch (err) {
      console.error(`!! Dealer "${dealer.name}" crashed the run wrapper: ${err?.message || err}`);
      // isolate: continue to next dealer no matter what
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await closeBrowser(); });
