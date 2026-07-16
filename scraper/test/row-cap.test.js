// The Data API silently caps every response at 1000 rows.
//
// Not an error, not a warning — just fewer rows than you asked for. Any read
// that grows with the tool list or with time will one day cross that line and
// start returning a confident, incomplete answer. That is this project's oldest
// bug shape, and the reason `backup.js` pages explicitly.
//
// These pin the query SHAPES that were fixed, because the failure is invisible
// until the data is big enough — by which time it looks like a scraper problem,
// not a query problem.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

test('the dashboard reads sparklines from the view, not raw snapshots', () => {
  // Raw snapshots meant ~180 rows per listing per 90 days: over the cap at about
  // SIX priced tools, and ordered ascending, so what vanished was today's price.
  const app = src('../../web/js/app.js');
  assert.match(app, /SB\.select\(\s*'listing_spark'/, 'sparks must come from listing_spark');
  assert.ok(
    !/select=listing_id,price_cad,scraped_at&listing_id=in/.test(app),
    'the old per-snapshot sparkline query is back — it truncates silently past ~6 tools',
  );
});

test('the detail chart fetches newest-first so a cap drops old history, not new', () => {
  // This one is unbounded by nature (a tool accrues history forever). It will be
  // truncated eventually; the only question is which end gets lost.
  const app = src('../../web/js/app.js');
  const detail = app.slice(app.indexOf("snaps = await SB.select('price_snapshots'"));
  const call = detail.slice(0, detail.indexOf('\n      }'));
  assert.match(call, /order=scraped_at\.desc/, 'must fetch newest-first');
  assert.match(call, /limit=1000/, 'and say so explicitly rather than relying on the server cap');
  assert.match(detail.slice(0, 600), /snaps\.reverse\(\)/, 'then reverse back to chronological');
});

test('the run report counts fresh links per LISTING, not per snapshot', () => {
  // `select listing_id from price_snapshots` pulled every snapshot in the window
  // (2 per listing per day). Past the cap it would have started reporting healthy
  // links as "unpriced" — a report that cries wolf is worse than no report.
  const report = src('../../scraper/src/report.js');
  assert.match(report, /from\('listing_latest_price'\)/, 'use the one-row-per-listing view');
  assert.ok(
    !/from\('price_snapshots'\)\.select\('listing_id'\)/.test(report),
    'the old unbounded snapshot scan is back',
  );
});

test('the backup and the report both page, via the shared helper', () => {
  // The same cap, on the one job where truncation is unrecoverable (you find out
  // while restoring) and the one where it would cry wolf (dead-link reporting).
  // The paging mechanics themselves are covered in page.test.js.
  for (const f of ['../../scraper/src/backup.js', '../../scraper/src/report.js']) {
    assert.match(src(f), /fetchAll\(/, `${f} must page rather than trust one response`);
  }
});
