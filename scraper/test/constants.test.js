// The shared thresholds. The point of the file is that the dashboard and the
// scraper read the SAME number — so the thing worth testing is that the scraper
// can actually import it across the /web boundary, and that the values still
// mean what their callers assume.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEAL_PCT, STALE_MANUAL_DAYS, PRICE_SANITY_MAX_RATIO, PRICE_SANITY_MIN_RATIO,
} from '../../web/js/constants.js';

test('the scraper can import the dashboard\'s constants', () => {
  // If this path ever breaks, report.js dies at import time and the run report
  // vanishes — worth catching here rather than in a 01:00 UTC cron.
  assert.equal(typeof DEAL_PCT, 'number');
  assert.equal(typeof STALE_MANUAL_DAYS, 'number');
});

test('DEAL_PCT is negative — it is a discount, not a markup', () => {
  // Both callers compare `pct_vs_avg_90d <= DEAL_PCT`. Flip the sign and every
  // priced tool becomes a "deal", which is the Deals-flags-everything bug again.
  assert.ok(DEAL_PCT < 0, `DEAL_PCT should be negative, got ${DEAL_PCT}`);
  assert.equal(DEAL_PCT, -10);
});

test('STALE_MANUAL_DAYS is a sane window', () => {
  assert.ok(STALE_MANUAL_DAYS > 0 && STALE_MANUAL_DAYS <= 90, `got ${STALE_MANUAL_DAYS}`);
});

test('nobody re-hardcoded the threshold behind the constant\'s back', () => {
  // The whole item is "one definition". A literal -10 creeping back into
  // report.js or app.js is the drift this file exists to prevent, and it would
  // otherwise pass every other test in here.
  const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
  for (const path of ['../src/report.js', '../../web/js/app.js']) {
    const code = src(path).replace(/^\s*(\/\/.*|\*.*|\/\*.*)$/gm, ''); // ignore comments
    assert.ok(
      !/pct_vs_avg_90d\s*<=\s*-?\d/.test(code),
      `${path} compares pct_vs_avg_90d against a literal — import DEAL_PCT instead`,
    );
  }
});

test('config.js no longer carries a second copy of DEAL_PCT', () => {
  const cfg = readFileSync(fileURLToPath(new URL('../../web/js/config.js', import.meta.url)), 'utf8');
  assert.ok(!/DEAL_PCT\s*:/.test(cfg), 'DEAL_PCT is back in config.js — that is the copy we removed');
});

test('the cross-dealer sanity band is one number, everywhere it is used', () => {
  // run.js and the discovery matcher import it. The writer can't (an Edge
  // Function can't reach /web), so it keeps a literal — and this is the tripwire
  // that stops the two drifting. If they disagree, a revived link's history gets
  // judged by a different rule than the scrape that made it.
  const writer = src('../../supabase/functions/writer/index.ts');
  assert.ok(
    writer.includes(`median * ${PRICE_SANITY_MAX_RATIO}`),
    `writer's reflagOutliers must use PRICE_SANITY_MAX_RATIO (${PRICE_SANITY_MAX_RATIO})`,
  );
  assert.ok(
    writer.includes(`median * ${PRICE_SANITY_MIN_RATIO}`),
    `writer's reflagOutliers must use PRICE_SANITY_MIN_RATIO (${PRICE_SANITY_MIN_RATIO})`,
  );
  // And run.js must import rather than re-hardcode.
  const run = src('../src/run.js');
  assert.match(run, /PRICE_SANITY_MAX_RATIO/, 'run.js should import the shared band');
  assert.ok(!/median \* 4\b/.test(run), 'run.js re-hardcoded the band');
});

test('the service worker precaches constants.js', () => {
  // app.js imports it at runtime; if the precache misses it, the app is broken
  // offline — and offline is the checklist's whole job.
  const sw = readFileSync(fileURLToPath(new URL('../../web/sw.js', import.meta.url)), 'utf8');
  assert.match(sw, /['"]js\/constants\.js['"]/);
});
