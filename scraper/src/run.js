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

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function scrapeDealer(dealer) {
  // Falls back to the generic manual-link adapter for any dealer without a
  // dedicated one, so pasted links from arbitrary sites still get priced.
  const adapter = getScrapeAdapter(dealer.name);

  const { data: listings, error: lErr } = await supabase
    .from('tool_listings')
    .select('id, product_url, tool_id')
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
      const { error: sErr } = await supabase.from('price_snapshots').insert({
        listing_id: listing.id,
        price_cad: res.price,
        regular_price_cad: res.regular_price,
        on_sale: res.on_sale,
        in_stock: res.in_stock,
      });
      if (sErr) throw sErr;
      ok++;
      console.log(`  ok  listing ${listing.id}  $${res.price}${res.on_sale ? ' (sale)' : ''}`);
    } catch (err) {
      fail++;
      const entry = { listing_id: listing.id, url: listing.product_url, error: String(err?.message || err) };
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
