// The dedup rule is what decides whether the phone stays worth listening to.
// Get it wrong in the loud direction and he mutes the app; get it wrong in the
// quiet direction and he misses the buy. Both failures are silent, so they're
// exactly the kind worth pinning down.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { shouldAlert, ALERT_REDROP_PCT, ALERT_REPEAT_DAYS } from '../src/alerts.js';

test('importing alerts.js does not run it, or touch the database', () => {
  // This file importing alerts.js is itself the test — supabase.js calls
  // process.exit(1) with no env vars, so a top-level import of it would kill
  // this whole test file. (It did. That's why the guard exists.)
  const src = readFileSync(fileURLToPath(new URL('../src/alerts.js', import.meta.url)), 'utf8');
  assert.ok(!/^import .*['"]\.\/supabase\.js['"]/m.test(src),
    'supabase.js must stay a lazy import inside main()');
  assert.match(src, /invokedDirectly/, 'main() must only run when invoked as a script');
});

const now = Date.parse('2026-07-16T12:00:00Z');
const agoDays = (n) => new Date(now - n * 86400000).toISOString();

test('never mentioned before: say it', () => {
  assert.equal(shouldAlert(null, 500, now), true);
});

test('same price, said yesterday: stay quiet', () => {
  // The noise case. Twice a day, every day, until the price moves — that's how
  // an alert becomes something you swipe away without reading.
  assert.equal(shouldAlert({ price_cad: 500, sent_at: agoDays(1) }, 500, now), false);
});

test('a further real drop: say it again', () => {
  // 500 -> 480 is 4% better, past the 2% bar: that's new information.
  assert.equal(shouldAlert({ price_cad: 500, sent_at: agoDays(1) }, 480, now), true);
});

test('a trivial wiggle is not news', () => {
  // 500 -> 495 is 1%: below the bar. Prices jitter; his attention shouldn't.
  assert.equal(shouldAlert({ price_cad: 500, sent_at: agoDays(1) }, 495, now), false);
});

test('exactly at the re-drop threshold counts', () => {
  const at = 500 * (1 - ALERT_REDROP_PCT / 100); // 490
  assert.equal(shouldAlert({ price_cad: 500, sent_at: agoDays(1) }, at, now), true);
});

test('a price that went UP does not re-alert', () => {
  assert.equal(shouldAlert({ price_cad: 500, sent_at: agoDays(1) }, 510, now), false);
});

test('still a deal after the repeat window: remind him', () => {
  assert.equal(shouldAlert({ price_cad: 500, sent_at: agoDays(ALERT_REPEAT_DAYS) }, 500, now), true);
  assert.equal(shouldAlert({ price_cad: 500, sent_at: agoDays(ALERT_REPEAT_DAYS - 1) }, 500, now), false);
});

test('a nonsense record on file does not silence a real alert', () => {
  // If we somehow logged a zero/garbage price, that must not become a permanent
  // mute for that tool.
  for (const bad of [0, -1, null, undefined, 'abc']) {
    assert.equal(shouldAlert({ price_cad: bad, sent_at: agoDays(1) }, 500, now), true, `price_cad=${bad}`);
  }
});

test('an unparseable sent_at does not silence it forever either', () => {
  assert.equal(shouldAlert({ price_cad: 500, sent_at: 'not-a-date' }, 500, now), false,
    'no further drop and no readable date: stay quiet rather than spam');
  assert.equal(shouldAlert({ price_cad: 500, sent_at: 'not-a-date' }, 400, now), true,
    'but a real drop still gets through');
});
