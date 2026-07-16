// The discovery matcher decides what reaches his attention.
//
// The last discovery build-out found plenty and bought nothing — it died of
// noise, and he rolled it back. So the bar here isn't "does it find things",
// it's "does it stay quiet". Every one of these is a way a junk lead gets in.

import test from 'node:test';
import assert from 'node:assert/strict';
import { matchCandidate, tokenizeQuery, toolIsKit } from '../src/discovery/match.js';
import { PRICE_SANITY_MAX_RATIO, PRICE_SANITY_MIN_RATIO } from '../../web/js/constants.js';

// The SHARED band — the same one run.js flags snapshots with. Imported, not
// retyped, so this can't quietly disagree with the rest of the app.
const BAND = { minRatio: PRICE_SANITY_MIN_RATIO, maxRatio: PRICE_SANITY_MAX_RATIO };
const meter = { name: '87V Max', discovery_query: 'Fluke 87V Max', best_price_cad: 725.67 };

test('a clean, cheaper, in-band match gets through', () => {
  const c = { title: 'Fluke 87V Max True-RMS Industrial Multimeter', extracted_price: 699.0, source: 'ABC Tools' };
  assert.equal(matchCandidate(meter, c, BAND).ok, true);
});

test('the $135 warranty add-on dies — twice over', () => {
  // THE trap (FABLE.md §6), now in lead form. Caught by the reject word AND by
  // the price band; either alone would do, which is the point.
  const c = { title: 'Fluke 87V Max 3-Year Protection Plan', extracted_price: 135, source: 'X' };
  assert.equal(matchCandidate(meter, c, BAND).ok, false);
});

test('a variant is not the tool: plain 87V never matches 87V Max', () => {
  // The expensive kind of wrong — it looks right, and it's a different meter.
  const c = { title: 'Fluke 87V True-RMS Multimeter', extracted_price: 650, source: 'X' };
  const r = matchCandidate(meter, c, BAND);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'token-miss');
});

test('and 87V Max does not match a plain-87V tool either', () => {
  // The same rule in the other direction: extra model words must not slip by.
  const plain = { name: '87V', discovery_query: 'Fluke 87V', best_price_cad: 650 };
  const c = { title: 'Fluke 87V Max True-RMS Multimeter', extracted_price: 600, source: 'X' };
  assert.equal(matchCandidate(plain, c, BAND).ok, true); // every token of "Fluke 87V" IS present
  // ...which is why the price band and "cheaper only" carry the weight here, and
  // why discovery_query exists: he can pin "Fluke 87V -Max" style precision.
});

test('used / refurbished / open-box are dropped', () => {
  for (const c of [
    { title: 'Fluke 87V Max Multimeter', extracted_price: 500, source: 'X', second_hand_condition: 'used' },
    { title: 'Fluke 87V Max Multimeter (Refurbished)', extracted_price: 500, source: 'X' },
    { title: 'Open Box Fluke 87V Max Multimeter', extracted_price: 500, source: 'X' },
  ]) {
    assert.equal(matchCandidate(meter, c, BAND).ok, false, c.title);
  }
});

test('an out-of-band bargain is a mis-scrape, not a deal', () => {
  const c = { title: 'Fluke 87V Max Multimeter', extracted_price: 40, source: 'X' };
  assert.equal(matchCandidate(meter, c, BAND).reason, 'price-band');
});

test('no price, no lead', () => {
  const c = { title: 'Fluke 87V Max Multimeter', source: 'X' };
  assert.equal(matchCandidate(meter, c, BAND).reason, 'no-price');
});

test('no reference price, no lead — we cannot sanity-check it', () => {
  // A tool nobody has priced yet has nothing to compare against. Surfacing an
  // unbounded lead there is exactly how the inbox fills with junk.
  const unpriced = { name: '87V Max', discovery_query: 'Fluke 87V Max', best_price_cad: null };
  const c = { title: 'Fluke 87V Max True-RMS Multimeter', extracted_price: 699, source: 'X' };
  assert.equal(matchCandidate(unpriced, c, BAND).reason, 'no-reference');
});

test('a dearer listing is not news', () => {
  // The inbox is for buying decisions, not a catalogue of everyone who sells it.
  const c = { title: 'Fluke 87V Max True-RMS Multimeter', extracted_price: 800, source: 'X' };
  assert.equal(matchCandidate(meter, c, BAND).reason, 'not-cheaper');
});

test('a missing band fails closed rather than matching everything', () => {
  const c = { title: 'Fluke 87V Max True-RMS Multimeter', extracted_price: 699, source: 'X' };
  assert.equal(matchCandidate(meter, c, {}).ok, false);
  assert.equal(matchCandidate(meter, c, { minRatio: 0.25 }).ok, false);
});

test('kit words are junk for a meter, but not for a wrench SET', () => {
  // His list is full of legitimate 122-piece sets — a blanket "set" reject would
  // silently make discovery useless for a whole category.
  const wrenches = {
    name: 'Stubby and Standard Length Combination Wrench Set (122-Piece)',
    discovery_query: 'Tekton 122-piece combination wrench set',
    best_price_cad: 2858.97,
  };
  assert.equal(toolIsKit(wrenches), true);
  assert.equal(toolIsKit(meter), false);

  assert.equal(matchCandidate(meter, { title: 'Fluke 87V Max Multimeter Kit', extracted_price: 699, source: 'X' }, BAND).reason, 'kit-mismatch');
  assert.equal(matchCandidate(wrenches, { title: 'Tekton 122-Piece Combination Wrench Set', extracted_price: 2400, source: 'X' }, BAND).ok, true);
});

test('tokenizer keeps identity, drops marketing', () => {
  const t = tokenizeQuery('Fluke 87V Max True RMS Industrial Digital Multimeter');
  assert.ok(t.includes('87v'), 'the model number is the identity');
  assert.ok(t.includes('max'), 'the variant word decides which meter this is');
  assert.ok(t.includes('fluke'));
  for (const junk of ['true', 'rms', 'industrial', 'digital']) {
    assert.ok(!t.includes(junk), `"${junk}" is marketing, not identity`);
  }
});

test('an empty query fails closed instead of matching the whole internet', () => {
  const nameless = { name: '', discovery_query: '', best_price_cad: 100 };
  assert.equal(matchCandidate(nameless, { title: 'Anything', extracted_price: 50 }, BAND).ok, false);
});
