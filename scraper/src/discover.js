// Entry point for the deal-discovery job. Prints a Markdown report to stdout,
// which discover.yml pipes into $GITHUB_STEP_SUMMARY — same honest feedback loop
// as the scrape run report, because this job's output is a judgement call and he
// needs to see what it dropped as much as what it kept.
//
// Usage:
//   node src/discover.js            # search, record leads
//   node src/discover.js --dry-run  # search, record NOTHING, print the raw shape
//
// BUDGET, stated plainly because it spends his money past a point:
//   SerpApi free tier = ~250 searches/month. This spends 1 per tool per run.
//   The workflow runs WEEKLY (~4.3 times/month), so:
//       DISCOVERY_MAX_TOOLS (default 40) × 4.3 ≈ 172 searches/month  → inside free
//   Raising the cap or the cron frequency past ~250/month starts costing money.
//   A 295-tool list therefore takes ~7 weeks to sweep once. That's what the free
//   tier buys; going faster is a decision with a price on it, and his to make.

import { runDiscovery } from './discovery/run-discovery.js';
import { discoveryStore } from './discovery/store.js';
import { PRICE_SANITY_MAX_RATIO, PRICE_SANITY_MIN_RATIO } from '../../web/js/constants.js';

const DEFAULT_MAX_TOOLS = 40;

function reportMarkdown(r, cap) {
  const L = [];
  L.push('## 🔎 Deal discovery', '');
  if (r.skipped) {
    L.push('_`SERPAPI_KEY` is not set — the job did nothing._');
    return L.join('\n');
  }
  if (r.dryRun) L.push('> **Dry run** — nothing was written.', '');
  L.push(`**${r.searched}** tool(s) searched (cap ${cap}) · **${r.kept}** new lead(s)`
    + ` · ${r.dropped} candidate(s) dropped`
    + (r.errors ? ` · ⚠️ **${r.errors}** search error(s)` : ''));
  // Name the leads. A run that says "2 leads" without saying what they are is a
  // number you can't check — and this whole app is about not printing those.
  if (r.leads?.length) {
    L.push('', '### Leads', '', '| Tool | Merchant | Seen | Your best | Title |', '|---|---|---|---|---|');
    for (const l of r.leads) {
      const seen = l.price_seen != null ? `~$${Number(l.price_seen).toFixed(2)}` : '—';
      const best = l.best != null ? `$${Number(l.best).toFixed(2)}` : '—';
      L.push(`| ${l.tool.slice(0, 40)} | ${l.merchant} | ${seen} | ${best} | ${String(l.title || '').slice(0, 60)} |`);
    }
    L.push('', '_Prices are UNVERIFIED — off a search result, never through the adapter'
      + ' or the CAD conversion. They only become real when the link is added and scraped._');
  }
  if (r.reasons && Object.keys(r.reasons).length) {
    L.push('', '### Why candidates were dropped', '', '| Reason | # |', '|---|---|');
    for (const [k, v] of Object.entries(r.reasons).sort((a, b) => b[1] - a[1])) {
      L.push(`| ${k} | ${v} |`);
    }
    L.push('', '_Dropping is the point: the matcher fails closed, so a quiet run is a'
      + ' working run. `already-tracked` means the dealer is one you already have._');
  }
  if (r.kept && !r.dryRun) L.push('', 'Review them on the Deals tab — nothing is attached until you add the link.');
  return L.join('\n');
}

async function main() {
  const cap = Number(process.env.DISCOVERY_MAX_TOOLS || DEFAULT_MAX_TOOLS);
  const dryRun = process.argv.includes('--dry-run');
  const r = await runDiscovery(discoveryStore, {
    apiKey: (process.env.SERPAPI_KEY || '').trim(),
    cap,
    dryRun,
    band: { minRatio: PRICE_SANITY_MIN_RATIO, maxRatio: PRICE_SANITY_MAX_RATIO },
  });
  console.log(reportMarkdown(r, cap));
  // Errors don't fail the run: leads are a nice-to-have, and a red X here would
  // be indistinguishable from the scrape (the actual product) breaking.
}

main().catch((e) => {
  console.log(`## 🔎 Deal discovery\n\n❌ Failed: ${e?.message || e}`);
});
