// fetchAll() is what stands between the 1000-row cap and two jobs that must not
// silently return partial answers: the backup (you'd find out while restoring)
// and the run report's dead-link list (it would under-report).
//
// The Supabase builder is faked here — what's under test is the paging logic,
// not PostgREST.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchAll, PAGE } from '../src/util/page.js';

/** A fake query over `rows` that honours .range() the way PostgREST does. */
function fakeTable(rows, { capPerPage = PAGE } = {}) {
  const calls = [];
  const makeQuery = () => ({
    range(from, to) {
      calls.push([from, to]);
      // The server never returns more than its cap, whatever you ask for.
      const end = Math.min(to, from + capPerPage - 1);
      return Promise.resolve({ data: rows.slice(from, end + 1), error: null });
    },
  });
  return { makeQuery, calls };
}

const seq = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

test('a result under the cap comes back in one request', () => {
  const { makeQuery, calls } = fakeTable(seq(22));
  return fetchAll(makeQuery).then((rows) => {
    assert.equal(rows.length, 22);
    assert.equal(calls.length, 1, 'a short page means stop — no pointless second call');
  });
});

test('a result ON the cap boundary is NOT truncated', () => {
  // The nasty case: exactly 1000 rows looks like a full page, so it must ask
  // again to find out there is nothing more. Off-by-one here silently drops
  // every row past 1000.
  const { makeQuery, calls } = fakeTable(seq(PAGE));
  return fetchAll(makeQuery).then((rows) => {
    assert.equal(rows.length, PAGE);
    assert.equal(calls.length, 2, 'a full page must be followed by one more request');
  });
});

test('a result well past the cap comes back whole', () => {
  const { makeQuery } = fakeTable(seq(2500));
  return fetchAll(makeQuery).then((rows) => {
    assert.equal(rows.length, 2500);
    assert.equal(rows[0].id, 1);
    assert.equal(rows[2499].id, 2500, 'the last row must survive');
    assert.equal(new Set(rows.map((r) => r.id)).size, 2500, 'no duplicates across pages');
  });
});

test('an empty table is empty, not an error', () => {
  const { makeQuery } = fakeTable([]);
  return fetchAll(makeQuery).then((rows) => assert.deepEqual(rows, []));
});

test('an error surfaces instead of looking like the end of the data', () => {
  // Swallowing this would turn a failed read into "the table is empty" — which,
  // for the backup, means cheerfully writing an empty file over nothing.
  const makeQuery = () => ({ range: async () => ({ data: null, error: { message: 'boom' } }) });
  return assert.rejects(() => fetchAll(makeQuery), /boom/);
});

test('a fresh query is built per page', () => {
  // Supabase builders can only be executed once; reusing one silently returns
  // the first page forever, which would loop until the cap counter saved us.
  let built = 0;
  const rows = seq(2500);
  const makeQuery = () => {
    built++;
    return { range: (from, to) => Promise.resolve({ data: rows.slice(from, to + 1), error: null }) };
  };
  return fetchAll(makeQuery).then(() => assert.equal(built, 3, 'one builder per page'));
});

test('both callers impose a stable order — ranges are meaningless without one', () => {
  // Without ORDER BY, Postgres may hand back rows in a different order per page,
  // so paging could skip and duplicate. It would look like flaky data, not a bug.
  const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
  for (const f of ['../src/backup.js', '../src/report.js']) {
    const code = src(f);
    const uses = [...code.matchAll(/fetchAll\(\(\) =>([\s\S]{0,240}?)\)\);/g)].map((m) => m[1]);
    assert.ok(uses.length, `${f} should use fetchAll`);
    for (const u of uses) assert.match(u, /\.order\(/, `${f}: every fetchAll query needs .order()`);
  }
});
