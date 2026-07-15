// Import the tool-list spreadsheet (exported to CSV) into the `tools` table.
// Idempotent: matches on (brand, model_number) case-insensitively and updates
// in place, so re-importing an updated sheet won't create duplicates.
//
// Expected columns (header names are matched flexibly / case-insensitively):
//   item name | brand | model/part number | category | tier | budget price
//
// Usage: node src/import-csv.js ./tools.csv

import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { supabase } from './supabase.js';

const FIELD_ALIASES = {
  name:         ['item name', 'checklist item', 'name', 'item', 'tool', 'description'],
  brand:        ['brand', 'make', 'manufacturer'],
  model_number: ['model / part #', 'model/part number', 'model', 'model number', 'part number', 'part', 'model/part', 'sku'],
  category:     ['category', 'cat', 'type'],
  tier:         ['tier', 'priority', 'level'],
  target_price: ['budget price', 'est cad', 'target price', 'budget', 'target', 'price', 'est'],
  notes:        ['notes', 'note', 'comments'],
};

function buildHeaderMap(headers) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const map = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const idx = headers.findIndex((h) => aliases.includes(norm(h)));
    if (idx >= 0) map[field] = headers[idx];
  }
  return map;
}

function toNumber(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^\d.,]/g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node src/import-csv.js ./tools.csv'); process.exit(1); }

  const raw = readFileSync(file, 'utf8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  if (!rows.length) { console.log('No rows found.'); return; }

  const hmap = buildHeaderMap(Object.keys(rows[0]));
  if (!hmap.name) { console.error('Could not find an "item name" column. Headers:', Object.keys(rows[0])); process.exit(1); }
  console.log('Column mapping:', hmap);

  let inserted = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    const tool = {
      name: row[hmap.name]?.trim(),
      brand: hmap.brand ? row[hmap.brand]?.trim() || null : null,
      model_number: hmap.model_number ? row[hmap.model_number]?.trim() || null : null,
      category: hmap.category ? row[hmap.category]?.trim() || null : null,
      tier: hmap.tier ? row[hmap.tier]?.trim() || null : null,
      target_price: hmap.target_price ? toNumber(row[hmap.target_price]) : null,
      notes: hmap.notes ? row[hmap.notes]?.trim() || null : null,
    };
    if (!tool.name) { skipped++; continue; }

    // Item name is the natural key for this list (model_number is descriptive,
    // not a unique SKU). Match case-insensitively.
    const { data } = await supabase.from('tools').select('id').ilike('name', tool.name).limit(1);
    const existing = data?.[0] || null;

    if (existing) {
      await supabase.from('tools').update({ ...tool, updated_at: new Date().toISOString() }).eq('id', existing.id);
      updated++;
    } else {
      const { error } = await supabase.from('tools').insert(tool);
      if (error) { console.warn(`  ! ${tool.name}: ${error.message}`); skipped++; }
      else inserted++;
    }
  }

  console.log(`\nDone. ${inserted} inserted, ${updated} updated, ${skipped} skipped.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
