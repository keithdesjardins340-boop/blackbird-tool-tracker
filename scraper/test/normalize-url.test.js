// normalizeUrl decides whether two pasted links are the same listing. Too loose
// and two dealers' links collide; too eager and the "normalized" URL stops being
// fetchable — so the conservative choices below are the contract, not an
// accident. The writer Edge Function mirrors this (index.ts) so a link pasted in
// the browser dedupes exactly like one seen by the scraper.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl } from '../src/util/url.js';

test('drops tracking params, keeps real ones', () => {
  assert.equal(
    normalizeUrl('https://www.kmstools.com/p/fluke-87v?utm_source=google&utm_campaign=x&gclid=abc'),
    'https://www.kmstools.com/p/fluke-87v',
  );
  // A real query param can BE the product identity — never strip what we don't know.
  assert.equal(
    normalizeUrl('https://www.canadiantire.ca/en/pdp/tool.html?pcode=0571234&utm_medium=email'),
    'https://www.canadiantire.ca/en/pdp/tool.html?pcode=0571234',
  );
});

test('drops the fragment and a trailing slash; lowercases the host', () => {
  assert.equal(normalizeUrl('https://www.kmstools.com/p/fluke-87v#reviews'), 'https://www.kmstools.com/p/fluke-87v');
  assert.equal(normalizeUrl('https://www.kmstools.com/p/fluke-87v/'), 'https://www.kmstools.com/p/fluke-87v');
  assert.equal(normalizeUrl('https://WWW.KMSTools.COM/p/fluke-87v'), 'https://www.kmstools.com/p/fluke-87v');
});

test('the variants of one link all collapse to the same string', () => {
  const canonical = 'https://www.kmstools.com/p/fluke-87v';
  const variants = [
    'https://www.kmstools.com/p/fluke-87v',
    'https://www.kmstools.com/p/fluke-87v/',
    'https://www.kmstools.com/p/fluke-87v#specs',
    'https://www.kmstools.com/p/fluke-87v?fbclid=xyz',
    'https://WWW.kmstools.com/p/fluke-87v/?utm_source=fb#specs',
    '  https://www.kmstools.com/p/fluke-87v  ',
  ];
  for (const v of variants) assert.equal(normalizeUrl(v), canonical, `variant: ${v}`);
});

test('leaves fetchability alone: scheme, www., and path case survive', () => {
  // Deliberately conservative — a "normalized" URL that 404s is worse than a dupe.
  assert.equal(normalizeUrl('http://example.com/Product/ABC'), 'http://example.com/Product/ABC');
  assert.equal(normalizeUrl('https://example.com/Product/ABC'), 'https://example.com/Product/ABC');
  // Case matters in a path: these are two different pages, and must not merge.
  assert.notEqual(normalizeUrl('https://example.com/p/ABC'), normalizeUrl('https://example.com/p/abc'));
});

test('unparseable input is returned as-is, never thrown', () => {
  // A pasted link is user input. Returning it untouched lets the caller's
  // http(s) check reject it with a sane message instead of a URL parse crash.
  assert.equal(normalizeUrl('not a url'), 'not a url');
  assert.equal(normalizeUrl(''), '');
  assert.equal(normalizeUrl(null), null);
  assert.equal(normalizeUrl(undefined), undefined);
});
