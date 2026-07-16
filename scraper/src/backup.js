// Weekly backup: dump the database to JSON for an Actions artifact.
//
// His tool list is hand-built, one paste at a time — it is the one thing here
// that cannot be regenerated. The only backup that existed was taken by hand,
// once, before the wipe. This runs on a cron so there is always a recent one.
//
// Deliberate choices:
// - Output matches backups/blackbird-FULL-BACKUP-pre-wipe.json exactly (same
//   keys, same shape), so ONE documented restore path works for both files.
// - Price history is included in full, not just the latest price. It is small
//   today (see the row counts it prints), and it is what the 90-day average and
//   all-time-low are made of — those take weeks of scraping to rebuild, and
//   they're the app's actual product. Revisit at the ~250k-row mark (ROADMAP 3.3).
// - app_secrets is NEVER dumped: it holds the writer token. A backup that leaks
//   a credential is worse than no backup, and this artifact outlives the run.
//
// Read-only. Prints a Markdown summary on stdout for the run report.

import { writeFileSync } from 'node:fs';
import { supabase } from './supabase.js';

// PostgREST caps a response at 1000 rows. Paging is not optional: without it a
// backup silently truncates at row 1000 and looks perfectly healthy — you'd
// find out while restoring, which is the worst possible moment.
const PAGE = 1000;

async function dumpAll(table) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break; // short page = last page
  }
  return rows;
}

async function main() {
  const outPath = process.argv[2] || 'backup.json';

  // The same five tables the pre-wipe backup carries.
  const tables = ['tools', 'tool_listings', 'price_snapshots', 'map_candidates', 'dealers'];
  const dump = {
    exported_at: new Date().toISOString(),
    source: 'https://keithdesjardins340-boop.github.io/blackbird-tool-tracker/',
  };
  const counts = {};
  for (const t of tables) {
    const rows = await dumpAll(t);
    dump[t] = rows;
    counts[t] = rows.length;
  }

  const json = JSON.stringify(dump, null, 2);
  writeFileSync(outPath, json);

  // A backup of an empty database is a real thing that can happen (bad
  // credentials, a wipe) — and it would quietly overwrite nothing, then sit
  // there looking like a backup. Say so loudly instead.
  const empty = counts.tools === 0;
  const L = [];
  L.push('## 💾 Backup', '');
  L.push('| Table | Rows |', '|---|---|');
  for (const t of tables) L.push(`| ${t} | ${counts[t]} |`);
  L.push('', `**${(json.length / 1024).toFixed(0)} KB** → \`${outPath}\``);
  if (empty) L.push('', '> ⚠️ **No tools in the database.** This backup is empty — check before relying on it.');
  console.log(L.join('\n'));

  if (empty) process.exitCode = 1;
}

main().catch((e) => {
  console.error('backup failed:', e?.message || e);
  process.exit(1);
});
