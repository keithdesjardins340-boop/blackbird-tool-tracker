// Push the buy signal to his phone.
//
// The tracker's job is "buy at the right time". A price that hits his target at
// 01:00 UTC and drifts back up by the time he next opens a tab is a deal the app
// technically found and practically missed. This closes that gap.
//
// ntfy.sh: free, no account, no key. The "topic" is both the address and the
// only secret — anyone who knows it can read his alerts — so it lives in the
// NTFY_TOPIC Actions secret and is NEVER printed, not even on failure.
// Unset → this exits quietly. The scrape must not care whether alerts exist.
//
// Usage:
//   node src/alerts.js              # after a scrape: target hits + real drops
//   node src/alerts.js --run-failed # the run itself broke

import { supabase } from './supabase.js';
import { DEAL_PCT } from '../../web/js/constants.js';

/** Re-alert the same tool only if the price dropped at least this much further. */
export const ALERT_REDROP_PCT = 2;
/** …or if it's been this long. Otherwise, silence. */
export const ALERT_REPEAT_DAYS = 14;

/**
 * Is this worth interrupting him for, given what we last told him?
 *
 * The bar is "new information", not "still true". A deal that's been sitting
 * there for a week isn't news twice a day — and an alert he learns to swipe away
 * is worse than no alert, because it trains him to ignore the one that matters.
 */
export function shouldAlert(prev, price, now = Date.now()) {
  if (!prev) return true;                       // never mentioned it
  const last = Number(prev.price_cad);
  if (!(last > 0)) return true;                 // nonsense on record — say it again
  if (price <= last * (1 - ALERT_REDROP_PCT / 100)) return true; // it got better
  const days = (now - Date.parse(prev.sent_at)) / 86400000;
  return Number.isFinite(days) && days >= ALERT_REPEAT_DAYS;     // periodic reminder
}

const money = (v) => `$${Number(v).toFixed(2)}`;

/** POST one notification. Never logs the topic. */
async function push(topic, { title, message, tags, priority }) {
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: {
      Title: title,
      Tags: tags || '',
      Priority: String(priority || 3),
      'User-Agent': 'blackbird-tool-tracker',
    },
    body: message,
  });
  if (!res.ok) throw new Error(`ntfy responded ${res.status}`); // status only — no URL
}

async function main() {
  const topic = (process.env.NTFY_TOPIC || '').trim();
  if (!topic) {
    console.log('NTFY_TOPIC not set — skipping alerts.');
    return;
  }

  if (process.argv.includes('--run-failed')) {
    // A silently broken scraper is the worst failure mode here: prices quietly
    // stop being true while the app keeps showing them with confidence.
    await push(topic, {
      title: 'Blackbird: scrape run failed',
      message: 'The price scrape did not finish. Prices may be stale until the next run.',
      tags: 'warning', priority: 4,
    });
    console.log('Sent: run-failure alert.');
    return;
  }

  const { data: tools, error } = await supabase
    .from('tool_market_status')
    .select('tool_id, name, best_price, best_dealer, target_price, pct_vs_avg_90d, owned')
    .not('best_price', 'is', null);
  if (error) throw error;

  // Only tools he still needs. Alerting on a tool he already bought is noise.
  const candidates = (tools || []).filter((t) => !t.owned);

  const sent = [];
  for (const t of candidates) {
    const price = Number(t.best_price);
    const kinds = [];
    if (t.target_price != null && price <= Number(t.target_price)) kinds.push('target');
    else if (t.pct_vs_avg_90d != null && Number(t.pct_vs_avg_90d) <= DEAL_PCT) kinds.push('deal');
    // `else if`: hitting his target already implies "buy it" — saying it twice
    // for one price is exactly the noise this is trying to avoid.

    for (const kind of kinds) {
      const { data: prevRows } = await supabase
        .from('alerts_sent')
        .select('price_cad, sent_at')
        .eq('tool_id', t.tool_id).eq('kind', kind)
        .order('sent_at', { ascending: false }).limit(1);
      const prev = (prevRows || [])[0] || null;
      if (!shouldAlert(prev, price)) continue;

      const body = kind === 'target'
        ? `${money(price)} at ${t.best_dealer} — at or under your ${money(t.target_price)} target.`
        : `${money(price)} at ${t.best_dealer} — ${Math.abs(Number(t.pct_vs_avg_90d))}% below its 90-day average.`;
      await push(topic, {
        title: t.name.slice(0, 80),
        message: body,
        tags: kind === 'target' ? 'dart,moneybag' : 'chart_with_downwards_trend',
        priority: kind === 'target' ? 4 : 3,
      });
      await supabase.from('alerts_sent').insert({ tool_id: t.tool_id, kind, price_cad: price });
      sent.push(`${t.name} (${kind})`);
    }
  }

  console.log(sent.length ? `Sent ${sent.length} alert(s):\n- ${sent.join('\n- ')}` : 'No new alerts.');
}

main().catch((e) => {
  // Never fail the workflow over a notification — the prices are already saved,
  // and a red run for a missed push would be its own kind of false alarm.
  console.error('alerts failed:', e?.message || e);
});
