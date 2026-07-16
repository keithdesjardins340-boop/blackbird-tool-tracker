// parsePrice reads the number a dealer page quotes. Everything downstream —
// best price, the 90-day average, the anomaly gate — trusts it, and a parser
// that confidently returns the WRONG number is this project's worst bug shape
// (FABLE.md §6). These cases are the ones seen in the wild.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice } from '../src/adapters/base.js';

test('plain Canadian/US formatting', () => {
  assert.equal(parsePrice('$725.67'), 725.67);
  assert.equal(parsePrice('$1,299.99'), 1299.99);
  assert.equal(parsePrice('1299.99'), 1299.99);
  assert.equal(parsePrice('  $ 89.99  '), 89.99);
  assert.equal(parsePrice('CAD $725.67'), 725.67);
});

test('French-Canadian formatting: comma decimal, trailing $', () => {
  // fr-CA dealer pages quote "1 299,99 $" — the comma is the DECIMAL separator.
  // Reading it as a thousands separator returns 129999 and turns a $1,300 meter
  // into the most expensive thing on the list.
  assert.equal(parsePrice('1 299,99 $'), 1299.99);
  assert.equal(parsePrice('725,67 $'), 725.67);
  assert.equal(parsePrice('1.299,99 €'), 1299.99); // dot-thousands, comma-decimal
});

test('narrow and non-breaking spaces as thousands separators', () => {
  // fr-CA groups digits with U+202F (narrow no-break) or U+00A0 (no-break), and
  // they arrive verbatim in the HTML text. Written as escapes on purpose: as
  // literal characters these lines are indistinguishable from a plain space,
  // which is exactly how this case quietly goes untested.
  assert.equal(parsePrice('1 299,99 $'), 1299.99);
  assert.equal(parsePrice('1 299,99 $'), 1299.99);
  assert.equal(parsePrice('$1 299.99'), 1299.99);
});

test('numbers pass through; junk does not', () => {
  assert.equal(parsePrice(725.67), 725.67);
  assert.equal(parsePrice(null), null);
  assert.equal(parsePrice(undefined), null);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice('   '), null);
  assert.equal(parsePrice('Call for pricing'), null);
  assert.equal(parsePrice('Out of stock'), null);
  assert.equal(parsePrice(NaN), null);
  assert.equal(parsePrice(Infinity), null);
});

test('unit-price suffixes read the price, not the unit', () => {
  // "$5.99 / each" — the trailing unit must not become digits.
  assert.equal(parsePrice('$5.99 / each'), 5.99);
  assert.equal(parsePrice('$89.99 ea.'), 89.99);
});

test('KNOWN GAP: a unit price with a number in the unit is misread', () => {
  // "$12.50 per 100" strips to "12.50100" -> 12.501. Documented, not asserted as
  // correct: parsePrice is only ever handed an already-isolated price string by
  // the adapters (a JSON-LD offer.price, a meta content attribute, or a currency
  // regex match), so no live path feeds it a trailing quantity. If a future
  // adapter hands it raw element text, this is the bug it will hit — and this
  // test will be here to say so.
  assert.equal(parsePrice('$12.50 per 100'), 12.501);
});
