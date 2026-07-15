// Link finder (CLI): pick a tool, search each dealer for its model number, and
// interactively approve/reject candidate product URLs. Approved ones are written
// as tool_listings rows — this is how the mapping table gets populated without
// manual searching.
//
// Usage:
//   node src/link-finder.js                 # walk unmapped tools, all dealers
//   node src/link-finder.js --tool 42       # one tool by id
//   node src/link-finder.js --dealer "KMS Tools"
//   node src/link-finder.js --model PF12345 # ad-hoc search, no tool row needed

import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { supabase } from './supabase.js';
import { adapters, getAdapter } from './adapters/index.js';
import { closeBrowser } from './util/browser.js';
import { randomDelay } from './util/http.js';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const rl = readline.createInterface({ input, output });
const ask = (q) => rl.question(q);

async function dealerRows(onlyName) {
  let q = supabase.from('dealers').select('id, name, scraper_status');
  if (onlyName) q = q.eq('name', onlyName);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function existingListingUrls(toolId) {
  const { data } = await supabase.from('tool_listings').select('product_url').eq('tool_id', toolId);
  return new Set((data || []).map((r) => r.product_url));
}

async function approveListing({ toolId, dealerId, url }) {
  const { error } = await supabase
    .from('tool_listings')
    .upsert({ tool_id: toolId, dealer_id: dealerId, product_url: url, active: true }, { onConflict: 'dealer_id,product_url' });
  if (error) console.warn(`  ! could not save: ${error.message}`);
  else console.log('  saved as listing.');
}

async function findForTool(tool, dealers) {
  console.log(`\n############ ${tool.name}  [${tool.brand || '-'} ${tool.model_number || '-'}]`);
  const query = tool.model_number || tool.name;
  const already = await existingListingUrls(tool.id);

  for (const dealer of dealers) {
    const adapter = getAdapter(dealer.name);
    if (!adapter?.search) { console.log(`  (${dealer.name}: no search support)`); continue; }
    process.stdout.write(`  searching ${dealer.name} for "${query}" ... `);
    let candidates = [];
    try {
      candidates = await adapter.search(query);
    } catch (e) {
      console.log(`error: ${e.message}`);
      continue;
    }
    candidates = candidates.filter((c) => !already.has(c.url));
    console.log(`${candidates.length} candidate(s)`);

    for (const c of candidates) {
      console.log(`\n    ${c.title || '(no title)'}${c.price ? `  ~$${c.price}` : ''}`);
      console.log(`    ${c.url}`);
      const a = (await ask('    approve? [y]es / [n]o / [s]kip dealer / [q]uit: ')).trim().toLowerCase();
      if (a === 'y') await approveListing({ toolId: tool.id, dealerId: dealer.id, url: c.url });
      else if (a === 's') break;
      else if (a === 'q') return false;
    }
    await randomDelay();
  }
  return true;
}

async function main() {
  const onlyDealer = arg('--dealer');
  const toolId = arg('--tool');
  const model = arg('--model');
  const dealers = await dealerRows(onlyDealer);

  if (model) {
    // Ad-hoc: just print candidates, no DB writes.
    for (const dealer of dealers) {
      const adapter = getAdapter(dealer.name);
      if (!adapter?.search) continue;
      console.log(`\n== ${dealer.name} ==`);
      try {
        const cands = await adapter.search(model);
        cands.forEach((c) => console.log(`  ${c.url}\n    ${c.title}`));
      } catch (e) { console.log(`  error: ${e.message}`); }
      await randomDelay();
    }
    return;
  }

  let q = supabase.from('tools').select('id, name, brand, model_number').order('id');
  if (toolId) q = q.eq('id', Number(toolId));
  const { data: tools, error } = await q;
  if (error) throw error;

  for (const tool of tools || []) {
    const cont = await findForTool(tool, dealers);
    if (!cont) break;
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { rl.close(); await closeBrowser(); });
