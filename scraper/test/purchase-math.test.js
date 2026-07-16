// The checklist's money line. It's the number he plans a truck build around, so
// the ways it can lie matter more than the arithmetic:
//   - forgetting quantity understates a 4× wrench by 3 wrenches
//   - counting owned tools as "remaining" inflates it
//   - silently skipping unpriced tools makes a partial total look complete
//
// money_stats() lives inside app.js's IIFE (no build step, nothing to import),
// so this is a port of the same rules. That's a copy — and copies drift — so the
// test asserts the SHAPE of the real one too, and app.js points here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Mirror of money_stats() in web/js/app.js.
function moneyStats(items) {
  let spent = 0, remaining = 0, unpriced = 0;
  for (const t of items) {
    if (t.owned) {
      if (t.purchase_price_cad != null) spent += Number(t.purchase_price_cad);
      continue;
    }
    if (t.best_price != null) remaining += Number(t.best_price) * (Number(t.quantity) || 1);
    else unpriced++;
  }
  return { spent, remaining, unpriced };
}

test('spent counts only what he recorded paying', () => {
  const s = moneyStats([
    { owned: true, purchase_price_cad: 699.99 },
    { owned: true, purchase_price_cad: 120.5 },
    { owned: true, purchase_price_cad: null },   // ticked with Skip — unknown, not zero
    { owned: false, best_price: 500 },
  ]);
  assert.equal(s.spent, 820.49);
});

test('remaining multiplies by quantity', () => {
  // Four of a $50 wrench is $200 of truck, not $50.
  const s = moneyStats([{ owned: false, best_price: 50, quantity: 4 }]);
  assert.equal(s.remaining, 200);
});

test('a missing quantity counts as one, not zero', () => {
  // quantity is nullable; treating null as 0 would silently drop the tool from
  // the estimate — the total would look right and be wrong.
  for (const quantity of [null, undefined, 0, 1]) {
    assert.equal(moneyStats([{ owned: false, best_price: 50, quantity }]).remaining, 50, `quantity=${quantity}`);
  }
});

test('owned tools are not still "remaining"', () => {
  const s = moneyStats([
    { owned: true, purchase_price_cad: 699.99, best_price: 725.67 },
    { owned: false, best_price: 100, quantity: 1 },
  ]);
  assert.equal(s.remaining, 100, "a tool he already has isn't left to buy");
});

test('unpriced tools are COUNTED, never silently skipped', () => {
  // The honesty bit. Three tools with no price are three unknowns in the
  // estimate; saying so is what stops "remaining ≈ $18,900" from reading as
  // complete when it isn't.
  const s = moneyStats([
    { owned: false, best_price: 100 },
    { owned: false, best_price: null },
    { owned: false, best_price: null },
  ]);
  assert.equal(s.remaining, 100);
  assert.equal(s.unpriced, 2);
});

test('an empty list totals zero, not NaN', () => {
  assert.deepEqual(moneyStats([]), { spent: 0, remaining: 0, unpriced: 0 });
});

test('REGRESSION: an owned tool with no recorded price falls out of BOTH totals', () => {
  // This is the hole a real bug fell through. An owned tool contributes to
  // `spent` only if purchase_price_cad is set, and `continue` keeps it out of
  // `remaining` — so owned-without-a-price is counted NOWHERE and isn't even
  // reported as unpriced.
  //
  // That's correct arithmetic (he ticked Skip: we genuinely don't know what he
  // paid, and 0 would be a lie). It's only dangerous when something drops the
  // price while keeping the tick — which syncPendingUI did to queued offline
  // purchases, making a recorded $699.99 disappear from the money line.
  const s = moneyStats([{ owned: true, purchase_price_cad: null, best_price: 725.67 }]);
  assert.deepEqual(s, { spent: 0, remaining: 0, unpriced: 0 });
});

test('a queued offline purchase still counts once its fields are overlaid', () => {
  // What syncPendingUI must reconstruct from the queue after a reload with no
  // signal: the tick AND the price, together.
  const queued = { owned: true, purchase_price_cad: 699.99, best_price: 725.67 };
  assert.equal(moneyStats([queued]).spent, 699.99, 'he paid 699.99, not today\'s 725.67');
});

test('app.js overlays the purchase fields, not just the tick', () => {
  // The fix this file's regression test describes. If syncPendingUI ever goes
  // back to copying `owned` alone, an offline purchase silently stops counting.
  const app = readFileSync(fileURLToPath(new URL('../../web/js/app.js', import.meta.url)), 'utf8');
  const fn = app.slice(app.indexOf('async function syncPendingUI'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  for (const field of ['purchase_price_cad', 'purchase_listing_id', 'purchased_at']) {
    assert.ok(body.includes(field), `syncPendingUI must restore ${field} from the queued payload`);
  }
});

test('app.js still carries the rules this file mirrors', () => {
  // A copy of logic is a liability; this is the tripwire. If money_stats() is
  // renamed or its rules change, come back and change them here too.
  const app = readFileSync(fileURLToPath(new URL('../../web/js/app.js', import.meta.url)), 'utf8');
  assert.match(app, /function money_stats\(items\)/, 'money_stats() was renamed or removed');
  assert.match(app, /Number\(t\.quantity\) \|\| 1/, 'quantity fallback changed — update this test to match');
  assert.match(app, /else unpriced\+\+/, 'unpriced counting changed — update this test to match');
});
