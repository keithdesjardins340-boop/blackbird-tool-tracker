// Auto-mapper: for each unmapped tool, search each auto-map-enabled dealer and
// create a tool_listing. Two paths, tried in order per dealer:
//   1) SKU path (high confidence) — the tool's part number appears in the result.
//   2) Description path (fuzzy) — for tools with NO usable part number, score the
//      result title against the tool name; auto-map only clear hits (source
//      'auto-desc', flagged in the app for the user to verify), medium scores go
//      to map_candidates for review, weak scores are ignored.
// Processes a capped batch per run so the CI backlog clears over a few cron
// cycles. Fully hands-off.
//
// Usage: node src/auto-map.js   (MAP_LIMIT caps tools/run, default 20;
//                                DESC_AUTO / DESC_MIN tune the fuzzy thresholds)

import { supabase } from './supabase.js';
import { getAdapter } from './adapters/index.js';
import { extractSkus, normSku } from './sku.js';
import { descQuery, bestByDescription } from './match.js';
import { normalizeUrl } from './util/url.js';
import { makeLoader } from './adapters/base.js';
import { randomDelay } from './util/http.js';
import { closeBrowser } from './util/browser.js';

const LIMIT = Number(process.env.MAP_LIMIT || 20);
const DESC_AUTO = Number(process.env.DESC_AUTO || 0.62); // auto-map at/above this
const DESC_MIN = Number(process.env.DESC_MIN || 0.42);   // save as review candidate

// Strong signal: the tool's SKU appears in a candidate's sku/title/url. Among
// matches, prefer the most specific (shortest) SKU — i.e. the base tool over kits.
function pickConfident(candidates, skus) {
  const nskus = skus.map(normSku).filter(Boolean);
  let best = null;
  for (const c of candidates) {
    const fields = [c.sku, c.title, c.url].map(normSku);
    for (const ns of nskus) {
      if (fields.some((f) => f && f.includes(ns))) {
        const spec = normSku(c.sku).length || 999;
        if (!best || spec < best.spec) best = { c, spec };
      }
    }
  }
  return best?.c || null;
}

// Fallback for dealers whose search results lack a SKU field: confirm the SKU is
// actually printed on the candidate product page before trusting it.
async function pageHasSku(adapter, url, skus) {
  try {
    const $ = await makeLoader({ needsJs: adapter.needsJs })(url);
    const hay = normSku($('body').text());
    return skus.some((s) => hay.includes(normSku(s)));
  } catch {
    return false;
  }
}

async function main() {
  const { data: dealers } = await supabase
    .from('dealers').select('id,name,scraper_status').in('scraper_status', ['active', 'beta']);
  const mapDealers = (dealers || []).filter((d) => getAdapter(d.name)?.autoMap && getAdapter(d.name)?.search);
  if (!mapDealers.length) { console.log('No auto-map-enabled dealers.'); return; }

  const { data: tools } = await supabase
    .from('tools').select('id,name,brand,model_number,pn')
    .is('auto_map_state', null).order('tier').limit(LIMIT);
  if (!tools?.length) { console.log('No unmapped tools left to process.'); return; }

  console.log(`Auto-mapping ${tools.length} tool(s) across: ${mapDealers.map((d) => d.name).join(', ')}`);

  const { data: existing } = await supabase
    .from('tool_listings').select('tool_id,dealer_id').in('tool_id', tools.map((t) => t.id));
  const alreadyMapped = new Set((existing || []).map((r) => `${r.tool_id}:${r.dealer_id}`));

  let mapped = 0, review = 0, noSku = 0, byDesc = 0;

  for (const tool of tools) {
    // Prefer the clean v2 part number; fall back to the messy model_number text.
    const skuSource = tool.pn && tool.pn.trim() && tool.pn.trim() !== 'VERIFY'
      ? tool.pn : tool.model_number;
    const skus = extractSkus(skuSource);

    let mappedAny = false;
    let anyCandidate = false;

    for (const dealer of mapDealers) {
      if (alreadyMapped.has(`${tool.id}:${dealer.id}`)) { mappedAny = true; continue; }
      const adapter = getAdapter(dealer.name);

      let chosen = null, source = null, matchScore = null, chosenSku = null;

      // --- 1) SKU path -------------------------------------------------
      if (skus.length) {
        let candidates = [];
        for (const sku of skus.slice(0, 2)) {
          try { candidates.push(...(await adapter.search(sku))); } catch { /* keep going */ }
          await randomDelay(700, 1800);
        }
        const seen = new Set();
        candidates = candidates.filter((c) => c.url && !seen.has(c.url) && seen.add(c.url));
        if (candidates.length) {
          chosen = pickConfident(candidates, skus);
          if (!chosen) {
            for (const c of candidates.slice(0, 4)) {
              if (await pageHasSku(adapter, c.url, skus)) { chosen = c; break; }
              await randomDelay(700, 1800);
            }
          }
          if (chosen) { source = 'auto-sku'; chosenSku = chosen.sku || skus[0]; }
        }
      }

      // --- 2) Description path (only if the SKU path didn't land) -------
      if (!chosen) {
        const q = descQuery(tool.name);
        let cands = [];
        if (q) {
          try { cands = await adapter.search(q); } catch { /* keep going */ }
          await randomDelay(700, 1800);
        }
        const best = bestByDescription(tool.name, tool.brand, cands || []);
        if (best && best.score >= DESC_AUTO) {
          chosen = best.c; source = 'auto-desc'; matchScore = best.score; chosenSku = best.c.sku || null;
        } else if (best && best.score >= DESC_MIN) {
          anyCandidate = true;
          for (const c of (cands || []).slice(0, 3)) {
            await supabase.from('map_candidates').upsert(
              { tool_id: tool.id, dealer_id: dealer.id, sku: c.sku || null, url: normalizeUrl(c.url), title: c.title, confident: false },
              { onConflict: 'tool_id,dealer_id,url' });
          }
          console.log(`  ? ${tool.name} @ ${dealer.name}: best desc ${best.score} < ${DESC_AUTO} → review`);
        }
      }

      if (chosen) {
        const listingUrl = normalizeUrl(chosen.url);
        await supabase.from('tool_listings').upsert(
          { tool_id: tool.id, dealer_id: dealer.id, product_url: listingUrl, sku: chosenSku, active: true, source, match_score: matchScore },
          { onConflict: 'dealer_id,product_url' });
        await supabase.from('map_candidates').upsert(
          { tool_id: tool.id, dealer_id: dealer.id, sku: chosenSku, url: listingUrl, title: chosen.title, confident: source === 'auto-sku' },
          { onConflict: 'tool_id,dealer_id,url' });
        mappedAny = true;
        if (source === 'auto-desc') byDesc++;
        console.log(`  ✓ ${tool.name} @ ${dealer.name} [${source}${matchScore ? ' ' + matchScore : ''}] → ${chosen.url}`);
      }
      await randomDelay();
    }

    const stateVal = mappedAny ? 'mapped' : (anyCandidate || skus.length ? 'review' : 'no_sku');
    await supabase.from('tools').update({ auto_map_state: stateVal }).eq('id', tool.id);
    if (mappedAny) mapped++;
    else if (stateVal === 'no_sku') noSku++;
    else review++;
  }

  console.log(`\nDone: ${mapped} mapped (${byDesc} by description), ${review} review, ${noSku} no-match. (${LIMIT}/run — re-runs continue the backlog.)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await closeBrowser(); });
