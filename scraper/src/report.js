// Print a Markdown run report to stdout (piped into $GITHUB_STEP_SUMMARY by the
// workflow) so each scrape's outcome — dealer health, snapshot volume, anomalies,
// and current deals — is visible at a glance without opening the dashboard.
// Read-only.

import { supabase } from './supabase.js';
// Same file the dashboard imports — the report and the Deals tab must agree on
// what a deal IS, or one of them is lying to him.
import { DEAL_PCT } from '../../web/js/constants.js';

const money = (v) => (v == null ? '—' : `$${Number(v).toFixed(2)}`);
const fmt = (s) => (s ? new Date(s).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—');

async function main() {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const { data: health } = await supabase.from('dealer_health').select('*');
  const { data: priced } = await supabase
    .from('tool_market_status')
    .select('name, best_price, best_dealer, pct_vs_avg_90d, at_all_time_low')
    .not('best_price', 'is', null);
  const { count: snapsToday } = await supabase
    .from('price_snapshots').select('*', { count: 'exact', head: true }).gte('scraped_at', since);
  const { count: anomToday } = await supabase
    .from('price_snapshots').select('*', { count: 'exact', head: true }).gte('scraped_at', since).eq('is_anomaly', true);

  // Unpriced links: active listings with NO fresh snapshot in the window — i.e. a
  // dead or blocked pasted link. In manual-first this is the key signal (a bad
  // link should be visible now, not discovered at buy time).
  const { data: activeListings } = await supabase
    .from('tool_listings')
    .select('id, tool:tools(name), dealer:dealers(name)')
    .eq('active', true);
  // listing_latest_price is ONE row per listing, so this can't outgrow the Data
  // API's silent 1000-row cap the way `select listing_id from price_snapshots`
  // did — that pulled every snapshot in the window (2 per listing per day) and
  // would have started inventing "unpriced links" out of truncation once the
  // list got big. A report that cries wolf is worse than no report.
  const { data: latest } = await supabase
    .from('listing_latest_price').select('listing_id, scraped_at').gte('scraped_at', since);
  const fresh = new Set((latest || []).map((s) => s.listing_id));
  const unpriced = (activeListings || []).filter((l) => !fresh.has(l.id));

  const L = [];
  L.push('## 🛠️ Blackbird scrape run', '');

  L.push('### Dealers');
  L.push('| Dealer | Status | Last run | ok / fail |', '|---|---|---|---|');
  for (const d of health || []) {
    L.push(`| ${d.name} | ${d.scraper_status} | ${fmt(d.last_run_at)} | ${d.ok_count ?? 0} / ${d.fail_count ?? 0} |`);
  }

  L.push('', `**${snapsToday ?? 0}** price snapshot(s) in the last 24h`
    + (anomToday ? ` · ⚠️ **${anomToday}** flagged anomalous (excluded from stats)` : '')
    + ` · **${(priced || []).length}** tools currently priced`);

  L.push('', `### Unpriced links (${unpriced.length})`);
  if (unpriced.length) {
    L.push('_Active links with no fresh price in the last 24h — a dead or blocked link shows up here._');
    const byDealer = new Map();
    for (const l of unpriced) {
      const dn = l.dealer?.name || '(unknown)';
      if (!byDealer.has(dn)) byDealer.set(dn, []);
      byDealer.get(dn).push(l.tool?.name || `listing ${l.id}`);
    }
    L.push('| Dealer | # | Tools |', '|---|---|---|');
    for (const [dn, tools] of [...byDealer.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const shown = tools.slice(0, 6).join(', ') + (tools.length > 6 ? `, +${tools.length - 6} more` : '');
      L.push(`| ${dn} | ${tools.length} | ${shown} |`);
    }
  } else {
    L.push('_Every active link got a fresh price. ✅_');
  }

  const isDeal = (t) => t.at_all_time_low || (t.pct_vs_avg_90d != null && t.pct_vs_avg_90d <= DEAL_PCT);
  const deals = (priced || []).filter(isDeal)
    .sort((a, b) => (a.at_all_time_low ? -999 : a.pct_vs_avg_90d ?? 0) - (b.at_all_time_low ? -999 : b.pct_vs_avg_90d ?? 0))
    .slice(0, 10);
  L.push('', `### Deals (${deals.length})`);
  if (deals.length) {
    L.push('| Tool | Best | Dealer | vs 90-day |', '|---|---|---|---|');
    for (const t of deals) {
      L.push(`| ${t.name} | ${money(t.best_price)} | ${t.best_dealer || ''} | ${t.at_all_time_low ? 'all-time low' : t.pct_vs_avg_90d + '%'} |`);
    }
  } else {
    L.push('_No deals right now._');
  }

  console.log(L.join('\n'));
}

main().catch((e) => { console.error('report failed:', e?.message || e); });
