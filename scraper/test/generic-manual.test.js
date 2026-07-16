// The generic adapter prices every manually pasted link — the whole
// manual-first loop rests on it. These run against saved fixtures, so they
// exercise the real extraction order (JSON-LD -> meta -> markup) with no
// network and no dealer-specific code.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { extractManualPrice } from '../src/adapters/generic-manual.js';

const fixture = (name) =>
  cheerio.load(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8'));

test('myflukestore: reads the product price, not the warranty add-on', () => {
  // THE regression (FABLE.md §6). A $135 warranty checkbox sits above the real
  // $725.67 in the DOM; a naive first-match priced the meter at $135 — a
  // fabricated bargain that would have won the BEST tag outright.
  const res = extractManualPrice(fixture('myflukestore-87v.html'));
  assert.equal(res.price, 725.67);
  assert.notEqual(res.price, 135);
  assert.equal(res.parse_via, 'markup'); // no JSON-LD, no price meta on this page
  assert.equal(res.in_stock, true);
});

test('myflukestore: the related-items price is not the product price either', () => {
  // $89.99 test leads under "Customers also bought" — same class of miss, and
  // it is BELOW the real price, so ordering alone would not have saved us.
  const res = extractManualPrice(fixture('myflukestore-87v.html'));
  assert.notEqual(res.price, 89.99);
});

test('fluke.com US: carries the declared currency instead of assuming CAD', () => {
  // The ~40% error (FABLE.md §6): "$635.99" here is USD. The adapter must report
  // the currency the page declared; run.js converts. Silently treating it as CAD
  // made the most expensive dealer look like the cheapest.
  const res = extractManualPrice(fixture('fluke-us-87v.html'));
  assert.equal(res.price, 635.99);
  assert.equal(res.currency, 'USD');
  assert.equal(res.parse_via, 'json-ld');
  assert.equal(res.in_stock, true);
  assert.equal(res.mpn, 'FLUKE-87V/MAX'); // harvested for the app's "Set part #"
});

test('a page with no price at all throws rather than inventing one', () => {
  const $ = cheerio.load('<html><body><main><h1>Fluke 87V</h1><p>Call for pricing</p></main></body></html>');
  assert.throws(() => extractManualPrice($, 'https://example.com/x'), /price not found/);
});

test('an undeclared currency stays null — run.js decides, not the adapter', () => {
  // A Canadian dealer that never says "CAD" is the normal case; the adapter
  // reports what it saw (null), and toCad() applies the assume-CAD default in
  // ONE place instead of each adapter guessing.
  const $ = cheerio.load(`
    <html><body><main>
      <div class="product-price">$725.67</div>
      <button>Add to Cart</button>
    </main></body></html>`);
  const res = extractManualPrice($);
  assert.equal(res.price, 725.67);
  assert.equal(res.currency, null);
});
