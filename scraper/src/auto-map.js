// Auto-mapper: for each unmapped tool that has a real part number, search each
// auto-map-enabled dealer and create a tool_listing for high-confidence matches
// (the SKU appears in the result's sku/title/url). Uncertain results are saved
// to map_candidates with confident=false for optional review. Processes a capped
// batch per run so the CI backlog clears over a few cron cycles — fully hands-off.
//
// Usage: node src/auto-map.js        (MAP_LIMIT env caps tools per run, default 20)

import { supabase } from './supabase.js';
import { getAdapter } from './adapters/index.js';
import { extractSkus, normSku } from './sku.js';
import { makeLoader } from './adapters/base.js';
import { randomDelay } from './util/http.js';
import { closeBrowser } from './util/browser.js';

const LIMIT = Number(process.env.MAP_LIMIT || 20);

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
    .from('tools').select('id,name,model_number,pn')
    .is('auto_map_state', null).order('tier').limit(LIMIT);
  if (!tools?.length) { console.log('No unmapped tools left to process.'); return; }

  console.log(`Auto-mapping ${tools.length} tool(s) across: ${mapDealers.map((d) => d.name).join(', ')}`);

  const { data: existing } = await supabase
    .from('tool_listings').select('tool_id,dealer_id').in('tool_id', tools.map((t) => t.id));
  const alreadyMapped = new Set((existing || []).map((r) => `${r.tool_id}:${r.dealer_id}`));

  let mapped = 0, review = 0, noSku = 0;

  for (const tool of tools) {
    // Prefer the clean v2 part number; fall back to the messy model_number text.
    const skuSource = tool.pn && tool.pn.trim() && tool.pn.trim() !== 'VERIFY'
      ? tool.pn : tool.model_number;
    const skus = extractSkus(skuSource);
    if (!skus.length) {
      await supabase.from('tools').update({ auto_map_state: 'no_sku' }).eq('id', tool.id);
      noSku++;
      console.log(`  - ${tool.name}: no part number → skipped`);
      continue;
    }

    let mappedAny = false;
    for (const dealer of mapDealers) {
      if (alreadyMapped.has(`${tool.id}:${dealer.id}`)) { mappedAny = true; continue; }
      const adapter = getAdapter(dealer.name);

      let candidates = [];
      for (const sku of skus.slice(0, 2)) {
        try { candidates.push(...(await adapter.search(sku))); } catch { /* keep going */ }
        await randomDelay(700, 1800);
      }
      const seen = new Set();
      candidates = candidates.filter((c) => c.url && !seen.has(c.url) && seen.add(c.url));
      if (!candidates.length) continue;

      let chosen = pickConfident(candidates, skus);
      if (!chosen) {
        for (const c of candidates.slice(0, 4)) {
          if (await pageHasSku(adapter, c.url, skus)) { chosen = c; break; }
          await randomDelay(700, 1800);
        }
      }

      if (chosen) {
        await supabase.from('tool_listings').upsert(
          { tool_id: tool.id, dealer_id: dealer.id, product_url: chosen.url, sku: chosen.sku || skus[0], active: true },
          { onConflict: 'dealer_id,product_url' });
        await supabase.from('map_candidates').upsert(
          { tool_id: tool.id, dealer_id: dealer.id, sku: chosen.sku || skus[0], url: chosen.url, title: chosen.title, confident: true },
          { onConflict: 'tool_id,dealer_id,url' });
        mappedAny = true;
        console.log(`  ✓ ${tool.name} @ ${dealer.name} → ${chosen.url}`);
      } else {
        for (const c of candidates.slice(0, 3)) {
          await supabase.from('map_candidates').upsert(
            { tool_id: tool.id, dealer_id: dealer.id, sku: skus[0], url: c.url, title: c.title, confident: false },
            { onConflict: 'tool_id,dealer_id,url' });
        }
        console.log(`  ? ${tool.name} @ ${dealer.name}: ${candidates.length} candidate(s), none confident → review`);
      }
      await randomDelay();
    }

    await supabase.from('tools').update({ auto_map_state: mappedAny ? 'mapped' : 'review' }).eq('id', tool.id);
    if (mappedAny) mapped++; else review++;
  }

  console.log(`\nDone: ${mapped} mapped, ${review} for review, ${noSku} no-SKU. (${LIMIT}/run — re-runs continue the backlog.)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await closeBrowser(); });
