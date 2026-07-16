// The attachListing() contract. Every op that attaches a link goes through this
// one decision, so they can't drift apart — which also means a mistake here is a
// mistake everywhere. Imports the exact module the writer Edge Function ships
// (supabase/functions/writer/attach.js), not a copy of it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAttach } from '../../supabase/functions/writer/attach.js';

test('a link nobody holds yet is added', () => {
  assert.deepEqual(decideAttach(null, 1), { state: 'added', id: null });
  assert.deepEqual(decideAttach(undefined, 1), { state: 'added', id: null });
});

test('re-adding this tool\'s live link is a no-op, not a duplicate-key error', () => {
  const existing = { id: 10, tool_id: 1, active: true };
  assert.deepEqual(decideAttach(existing, 1), { state: 'already', id: 10 });
});

test('a removed link is REVIVED, not silently ignored', () => {
  // The upsert(…ignoreDuplicates) bug (FABLE.md §6): the row still existed with
  // active=false, so the insert quietly did nothing and he could never re-add a
  // link he had removed. Revival is the fix, and it has to stay.
  const existing = { id: 10, tool_id: 1, active: false };
  assert.deepEqual(decideAttach(existing, 1), { state: 'revived', id: 10 });
});

test('a link LIVE on another tool is a CONFLICT — never taken', () => {
  // The load-bearing case. Taking a link that another tool is actively tracking
  // would drag its whole price history off that tool; the caller reports it
  // instead, and names the tool so it's actionable.
  const r = decideAttach({ id: 10, tool_id: 2, active: true }, 1);
  assert.equal(r.state, 'conflict');
  assert.equal(r.id, 10);
  assert.equal(r.tool_id, 2, 'the caller needs to name the blocking tool');
});

test('a REMOVED link from another tool is adopted — that is a mis-paste being fixed', () => {
  // Found by Keith, in use, 2026-07-16: he pasted a link on the wrong tool,
  // removed it, and couldn't put it on the right one — "already tracked under a
  // different tool". A mistake he'd already undone was unfixable in the UI.
  //
  // This file previously asserted the opposite, reasoning that any cross-tool
  // move was the silent theft we refuse. That conflated two cases: taking a LIVE
  // link (theft) and re-filing a REMOVED one (a correction he explicitly asked
  // for). The history follows, correctly — those snapshots are prices of that
  // URL, and the URL is the product.
  const r = decideAttach({ id: 10, tool_id: 2, active: false }, 1);
  assert.equal(r.state, 'adopt');
  assert.equal(r.id, 10);
  assert.equal(r.from_tool_id, 2, 'the caller says where it moved from');
});

test('ids compare by value across the string/number boundary', () => {
  // PostgREST returns bigint as a string; callers pass numbers. A strict compare
  // would call every existing link a conflict — and the app would look broken in
  // the most confusing possible way.
  assert.equal(decideAttach({ id: 10, tool_id: '1', active: true }, 1).state, 'already');
  assert.equal(decideAttach({ id: 10, tool_id: 1, active: true }, '1').state, 'already');
  assert.equal(decideAttach({ id: 10, tool_id: '2', active: true }, 1).state, 'conflict');
});
