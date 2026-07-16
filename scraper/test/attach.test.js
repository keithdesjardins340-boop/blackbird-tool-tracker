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

test('a link belonging to another tool is a CONFLICT — never moved', () => {
  // The load-bearing case. Reassigning the link would drag its whole price
  // history onto the wrong tool; the caller reports it instead.
  assert.deepEqual(decideAttach({ id: 10, tool_id: 2, active: true }, 1), { state: 'conflict', id: 10 });
  // Removed-and-owned-by-someone-else is still a conflict: reviving it here
  // would be exactly the silent move we refuse to make.
  assert.deepEqual(decideAttach({ id: 10, tool_id: 2, active: false }, 1), { state: 'conflict', id: 10 });
});

test('ids compare by value across the string/number boundary', () => {
  // PostgREST returns bigint as a string; callers pass numbers. A strict compare
  // would call every existing link a conflict — and the app would look broken in
  // the most confusing possible way.
  assert.equal(decideAttach({ id: 10, tool_id: '1', active: true }, 1).state, 'already');
  assert.equal(decideAttach({ id: 10, tool_id: 1, active: true }, '1').state, 'already');
  assert.equal(decideAttach({ id: 10, tool_id: '2', active: true }, 1).state, 'conflict');
});
