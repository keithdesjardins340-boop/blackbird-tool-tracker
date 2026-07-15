// Print a Markdown run report to stdout (piped into $GITHUB_STEP_SUMMARY by the
// workflow) so each scrape's outcome — dealer health, snapshot volume, anomalies,
// and current deals — is visible at a glance without opening the dashboard.
// Read-only.

import { supabase } from './supabase.js';

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

  const isDeal = (t) => t.at_all_time_low || (t.pct_vs_avg_90d != null && t.pct_vs_avg_90d <= -10);
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
