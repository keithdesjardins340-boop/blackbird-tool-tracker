// The offline queue's dangerous part isn't IndexedDB — it's WHICH writes are
// allowed to replay later. A queued write executes at an unknown time, possibly
// hours after he tapped, possibly out of order. That's only safe for ops whose
// payload carries the desired END STATE.
//
// The queue itself needs a browser (IndexedDB, fetch, navigator.onLine) and is
// verified there. What's testable here — and what actually protects him — is that
// nothing quietly joins the whitelist.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const queueJs = () => src('../../web/js/queue.js');
const supabaseJs = () => src('../../web/js/supabase.js');

test('only end-state ops may be queued offline', () => {
  // If you are here because you added an op to QUEUEABLE, answer this first:
  // could this replay hours late, out of order, and still be correct?
  //   record_price          — no. This morning's capture isn't today's price.
  //   add_tool_with_links   — no. Not idempotent; a replay duplicates the tool.
  //   delete_tool           — no. Replaying a delete over a re-added tool is a
  //                           silent data loss.
  //   toggle_owned          — yes. "Tool 7 should be owned=true" is true whenever
  //                           it lands, and last-write-wins is the right answer.
  const m = queueJs().match(/const QUEUEABLE = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'QUEUEABLE whitelist not found in web/js/queue.js');
  const ops = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.deepEqual(ops, ['toggle_owned']);
});

test('the queue hooks writeApi, which is the only write path', () => {
  // Queueing anywhere else would leave a write that bypasses the queue — the
  // checkmark would fail silently in exactly the place it matters.
  const s = supabaseJs();
  assert.match(s, /BBT_QUEUE/, 'supabase.js must consult the queue');
  assert.match(s, /isQueueable\(op\)/, 'writeApi must gate queueing on the whitelist');
});

test('network failures are told apart from server rejections', () => {
  // The distinction the whole design rests on: fetch() rejecting means the
  // request never landed (worth waiting out), while a 4xx means the server
  // considered it and said no (retrying forever would just spin).
  const s = supabaseJs();
  assert.match(s, /e\.offline = true/, 'a network failure must be tagged offline');
  assert.match(s, /catch \(netErr\)/, 'only a fetch() rejection counts as offline');
});

test('a failed replay keeps the write rather than tidying it away', () => {
  // Dropping a queued checkmark to keep the queue clean is losing his data to
  // avoid an inconvenience. flush() must break, not delete-on-error.
  const q = queueJs();
  const flush = q.slice(q.indexOf('async function flush'));
  const body = flush.slice(0, flush.indexOf('\n  }'));
  assert.ok(/error = e;\s*\n\s*break;/.test(body), 'flush() must stop and keep the item on failure');
});

test('the service worker precaches queue.js', () => {
  // It is loaded before supabase.js; missing from the precache, the app breaks
  // offline — which is the exact moment the queue exists for.
  assert.match(src('../../web/sw.js'), /['"]js\/queue\.js['"]/);
});
