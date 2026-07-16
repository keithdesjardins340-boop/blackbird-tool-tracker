// Deal discovery: search Google Shopping (via SerpApi) for tools already on the
// list, and drop candidate CHEAPER listings into a review inbox.
//
// It never attaches anything. Accepting a lead routes through the ordinary
// add-a-link path, so the price is established by the generic adapter and
// fail-closed FX — exactly like a link he pasted himself. Until then a lead is
// just a lead, and its price is shown as unverified.
//
// This is not the parked auto-map: that attached listings on its own, produced
// noise instead of purchases, and got rolled back. The difference is the review
// gate and the fact that the matcher fails closed.
//
// BUDGET IS A FEATURE HERE. SerpApi's free tier is ~250 searches/month and this
// spends one search per tool per run. The caller passes a cap; the weekly cron
// and the default cap are chosen so a full list stays inside the free tier (see
// discover.js). Going faster costs real money, which is his call, not ours.

import { matchCandidate } from './match.js';

const SERPAPI = 'https://serpapi.com/search.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One Google Shopping search. gl=ca asks for the Canadian market, which usually
 * means CAD — "usually" is why the price it returns is never trusted as a real
 * price and never becomes a snapshot.
 */
export async function serpShopping(q, apiKey, { fetchImpl = fetch } = {}) {
  const url = `${SERPAPI}?engine=google_shopping&gl=ca&hl=en`
    + `&q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    // 401 = bad key, 429 = out of credits. Both are worth saying plainly rather
    // than burying: "out of searches" looks identical to "found nothing".
    throw new Error(`serpapi HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data?.error) throw new Error(`serpapi: ${data.error}`);
  return { results: Array.isArray(data.shopping_results) ? data.shopping_results : [], raw: data };
}

/**
 * @param {object} store  see ./store.js — injected so this module stays testable
 * @param {object} env    { apiKey, cap, band:{minRatio,maxRatio}, dryRun, fetchImpl, delayMs }
 */
export async function runDiscovery(store, env) {
  const { apiKey, band, cap = 40, dryRun = false, fetchImpl = fetch, delayMs = 1200 } = env;
  if (!apiKey) {
    console.log('discovery: SERPAPI_KEY unset — nothing to do.');
    return { skipped: true, searched: 0, kept: 0, dropped: 0, errors: 0 };
  }

  const tools = await store.getToolsToSearch(cap);
  if (!tools.length) {
    console.log('discovery: no unowned tools to search.');
    return { skipped: false, searched: 0, kept: 0, dropped: 0, errors: 0 };
  }

  // Never resurrect something he already killed.
  const dismissed = await store.dismissedKeys(tools.map((t) => t.id));

  const rows = [];
  const reasons = {};
  let searched = 0;
  let errors = 0;

  for (const tool of tools) {
    const query = tool.discovery_query || tool.name;
    try {
      const { results, raw } = await serpShopping(query, apiKey, { fetchImpl });
      searched++;
      if (dryRun && searched === 1) {
        // The first search of a dry run prints the raw shape. Field names drift,
        // and this is the honest way to find out without guessing.
        console.log('discovery: raw first result for shape-checking:\n'
          + JSON.stringify((raw.shopping_results || []).slice(0, 2), null, 2));
      }
      for (const c of results) {
        const m = matchCandidate(tool, c, band);
        if (!m.ok) { reasons[m.reason] = (reasons[m.reason] || 0) + 1; continue; }

        const url = c.product_link || c.link;
        const merchant = c.source || c.merchant || '';
        if (!url || !merchant) { reasons['no-url'] = (reasons['no-url'] || 0) + 1; continue; }
        // Already tracking this dealer for this tool? Then it isn't news.
        if (tool.trackedUrls.has(url) || tool.trackedMerchants.has(merchant.toLowerCase())) {
          reasons['already-tracked'] = (reasons['already-tracked'] || 0) + 1; continue;
        }
        if (dismissed.has(`${tool.id} ${url}`)) {
          reasons.dismissed = (reasons.dismissed || 0) + 1; continue;
        }
        rows.push({
          tool_id: tool.id,
          source: 'serpapi_shopping',
          merchant,
          title: c.title || null,
          candidate_url: url,
          price_seen: typeof c.extracted_price === 'number' ? c.extracted_price : null,
          currency_seen: 'CAD?', // gl=ca implies it; never trusted. Verified on accept.
          second_hand: !!c.second_hand_condition,
        });
      }
    } catch (e) {
      errors++;
      console.error(`discovery: "${query}" failed — ${e.message}`);
    }
    await sleep(delayMs); // polite pacing; SerpApi is the fetcher, but still
  }

  // De-dupe within the run: one merchant can appear twice for a tool.
  const seen = new Set();
  const unique = rows.filter((r) => {
    const k = `${r.tool_id} ${r.candidate_url}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (!dryRun && unique.length) await store.recordSuggestions(unique);
  if (!dryRun) await store.markSearched(tools.map((t) => t.id));

  const dropped = Object.values(reasons).reduce((a, b) => a + b, 0);
  return { skipped: false, searched, kept: unique.length, dropped, errors, reasons, dryRun };
}
