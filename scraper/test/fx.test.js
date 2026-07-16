// price_cad is ALWAYS CAD — that is the column contract the whole app reads
// against (best price, 90-day average, anomaly gate). When we can't convert, the
// only safe answer is to REJECT the price: a missing snapshot shows up in the run
// report, a wrong one does not (FABLE.md §6).
//
// globalThis.fetch is stubbed rather than fx.js refactored, so the real fx.js AND
// http.js paths run exactly as they do in production. fx.js caches rates per
// process, so each test uses its OWN currency — otherwise a cached rate from one
// test would answer another's request and quietly prove nothing.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { normCurrency, toCad, FX_MAX_AGE_DAYS } from '../src/util/fx.js';

const realFetch = globalThis.fetch;

/** Stub fetch with a canned Valet response; returns a log of requested URLs. */
function stubValet(handler) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return handler(String(url));
  };
  return calls;
}
const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const dead = (status) => ({ ok: false, status, text: async () => '' });

afterEach(() => { globalThis.fetch = realFetch; });

test('a USD price converts, and keeps its audit trail', async () => {
  const calls = stubValet(() => ok({ observations: [{ d: '2026-07-14', FXUSDCAD: { v: '1.4051' } }] }));
  const r = await toCad({ price: 635.99, regular_price: null, currency: 'USD' });

  assert.equal(r.price_cad, 893.63);      // 635.99 * 1.4051 = 893.6295..., rounded to cents
  assert.equal(r.currency, 'USD');
  assert.equal(r.price_original, 635.99); // what the page actually said
  assert.equal(r.fx_rate, 1.4051);        // what we converted at
  assert.equal(calls.length, 1);
  assert.match(calls[0], /FXUSDCAD/);
});

test('Valet down: a non-CAD price is REJECTED, never guessed', async () => {
  // The point of the whole module. If this throw ever becomes a fallback to the
  // raw number, a EUR price lands in price_cad as if it were Canadian.
  stubValet(() => dead(404));
  await assert.rejects(() => toCad({ price: 500, regular_price: null, currency: 'EUR' }));
});

test('Valet returns nonsense: still rejected', async () => {
  stubValet(() => ok({ observations: [] }));
  await assert.rejects(
    () => toCad({ price: 500, regular_price: null, currency: 'GBP' }),
    /rate/i,
  );
});

test('a currency the Bank of Canada does not publish is rejected without a fetch', async () => {
  const calls = stubValet(() => ok({}));
  await assert.rejects(
    () => toCad({ price: 500, regular_price: null, currency: 'SEK' }),
    /no CAD conversion rate/i,
  );
  assert.equal(calls.length, 0, 'should not have called out for a series that does not exist');
});

test('CAD needs no rate and no network', async () => {
  const calls = stubValet(() => { throw new Error('must not fetch for CAD'); });
  const r = await toCad({ price: 725.67, regular_price: 799.99, currency: 'CAD' });

  assert.equal(r.price_cad, 725.67);
  assert.equal(r.regular_price_cad, 799.99);
  assert.equal(r.fx_rate, 1);
  assert.equal(r.price_original, null, 'no point storing the original when it is the same number');
  assert.equal(calls.length, 0);
});

test('an undeclared currency is assumed CAD — the Canadian-dealer default', async () => {
  const calls = stubValet(() => { throw new Error('must not fetch'); });
  const r = await toCad({ price: 725.67, regular_price: null, currency: null });

  assert.equal(r.price_cad, 725.67);
  assert.equal(r.currency, 'CAD');
  assert.equal(calls.length, 0);
});

// ---- the remembered-rate fallback (still fail-closed) ----------------------

/** A stand-in for the fx_rates table. */
const storeWith = (row) => ({ get: async () => row, put: async () => {} });
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

test('Valet down + a recent remembered rate: convert, and say which rate', async () => {
  // The whole point of 2.6: an outage should cost "we used yesterday's rate",
  // not "we lost every USD price in this run".
  stubValet(() => dead(503));
  const r = await toCad(
    { price: 100, regular_price: null, currency: 'AUD' },
    storeWith({ currency: 'AUD', rate: '0.9123', as_of: daysAgo(1) }),
  );
  assert.equal(r.price_cad, 91.23);
  assert.equal(r.fx_rate, 0.9123, 'the snapshot must record the rate actually used');
  assert.equal(r.price_original, 100);
});

test('Valet down + a rate older than the window: still REJECTED', async () => {
  // Fail-closed is intact. A month-old rate through a currency move is the same
  // ~40% error in a different hat.
  stubValet(() => dead(503));
  await assert.rejects(() => toCad(
    { price: 100, regular_price: null, currency: 'CHF' },
    storeWith({ currency: 'CHF', rate: '1.55', as_of: daysAgo(FX_MAX_AGE_DAYS + 1) }),
  ));
});

test('Valet down + nothing remembered: rejected, exactly as before', async () => {
  stubValet(() => dead(503));
  await assert.rejects(() => toCad(
    { price: 100, regular_price: null, currency: 'JPY' },
    storeWith(null),
  ));
});

test('a live rate is remembered for next time, with Valet\'s own observation date', async () => {
  // as_of must be the rate's real date, not when we asked — otherwise a Friday
  // rate looks fresh all weekend and the age check stops meaning anything.
  const puts = [];
  stubValet(() => ok({ observations: [{ d: '2026-07-14', FXMXNCAD: { v: '0.0821' } }] }));
  const r = await toCad(
    { price: 100, regular_price: null, currency: 'MXN' },
    { get: async () => null, put: async (cur, rate, asOf) => puts.push({ cur, rate, asOf }) },
  );
  assert.equal(r.fx_rate, 0.0821);
  assert.deepEqual(puts, [{ cur: 'MXN', rate: 0.0821, asOf: '2026-07-14' }]);
});

test('a broken cache never takes down a run that could have converted', async () => {
  // Best-effort by design: if fx_rates is unreadable but Valet answers, the
  // conversion must still happen.
  stubValet(() => ok({ observations: [{ d: '2026-07-14', FXCNYCAD: { v: '0.19' } }] }));
  const r = await toCad(
    { price: 100, regular_price: null, currency: 'CNY' },
    { get: async () => { throw new Error('db down'); }, put: async () => { throw new Error('db down'); } },
  );
  assert.equal(r.fx_rate, 0.19);
});

test('normCurrency: bare dollar signs are Canadian here; unknowns are null', () => {
  assert.equal(normCurrency('$'), 'CAD');
  assert.equal(normCurrency('C$'), 'CAD');
  assert.equal(normCurrency('CA$'), 'CAD');
  assert.equal(normCurrency('cad'), 'CAD');
  assert.equal(normCurrency('usd'), 'USD');
  assert.equal(normCurrency(' usd '), 'USD');
  assert.equal(normCurrency(''), null);
  assert.equal(normCurrency(null), null);
  assert.equal(normCurrency('dollars'), null);
});
