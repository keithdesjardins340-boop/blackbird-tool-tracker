// Offline write queue for the checklist.
//
// Ticking a tool off is the app's core act, and it happens exactly where there's
// no signal: a shop basement, a parts counter, a job site. Before this, the write
// went straight to the network and a dead connection meant the ✓ silently flipped
// back — the one thing the app must not do.
//
// Queued writes live in IndexedDB (survives a reload and a closed tab, unlike
// memory) and replay oldest-first when the connection returns.
//
// Classic script on purpose: supabase.js is classic and this has to hook
// SB.writeApi(), which is the single choke point every write goes through.
(function () {
  const DB_NAME = 'bbt';
  const STORE = 'writes';

  // ONLY ops that carry their desired END STATE may be queued.
  //
  // toggle_owned qualifies: the payload says "tool 7 should be owned=true", not
  // "flip tool 7". Replaying it is safe, order doesn't matter beyond
  // last-write-wins, and a stale duplicate is harmless.
  //
  // Nothing else is on this list, and adding to it needs the same test: could
  // this replay hours later, out of order, and still be right? `record_price`
  // fails it (a price captured this morning isn't today's price), and
  // `add_tool_with_links` fails it (it isn't idempotent — you'd get duplicates).
  // Those get an honest "you're offline" instead.
  const QUEUEABLE = new Set(['toggle_owned']);

  const isQueueable = (op) => QUEUEABLE.has(op);

  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return dbp;
  }

  const asPromise = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function store(mode) {
    const d = await open();
    return d.transaction(STORE, mode).objectStore(STORE);
  }

  /** Everything waiting, oldest first (autoIncrement id == insertion order). */
  async function all() {
    const s = await store('readonly');
    return (await asPromise(s.getAll())) || [];
  }

  async function count() {
    try {
      const s = await store('readonly');
      return await asPromise(s.count());
    } catch {
      return 0; // a broken IndexedDB must never take the app down
    }
  }

  async function remove(id) {
    const s = await store('readwrite');
    return asPromise(s.delete(id));
  }

  /**
   * Queue a write. End-state ops collapse per target: tapping a tool on, off and
   * on again offline leaves ONE entry saying "on", not three replays. Keeps the
   * pending count honest — it counts tools, not taps.
   */
  async function enqueue(op, payload) {
    if (!isQueueable(op)) throw new Error(`${op} cannot be queued offline`);
    const s = await store('readwrite');
    const rows = (await asPromise(s.getAll())) || [];
    for (const r of rows) {
      if (r.op === op && String(r.payload?.id) === String(payload?.id)) await asPromise(s.delete(r.id));
    }
    await asPromise(s.add({ op, payload, ts: Date.now() }));
    return count();
  }

  /**
   * Replay the queue, oldest first, using `send(op, payload)`.
   *
   * A failure STOPS the flush and keeps the item. That's deliberate: the likely
   * failures are "still offline" and "the writer token was rotated", and both are
   * fixable — dropping his checkmark to keep the queue tidy would be losing data
   * to avoid an inconvenience. It does mean a permanently-rejected write would
   * block the queue; the badge shows the error so it can't be silent.
   */
  async function flush(send) {
    const items = await all();
    let done = 0;
    let error = null;
    for (const it of items) {
      try {
        await send(it.op, it.payload);
        await remove(it.id);
        done++;
      } catch (e) {
        error = e;
        break;
      }
    }
    return { done, left: await count(), error };
  }

  /** Pending desired-state for a tool, if any — so the ✓ shows what WILL happen. */
  async function pendingFor(op, id) {
    const rows = await all();
    const hit = rows.filter((r) => r.op === op && String(r.payload?.id) === String(id)).pop();
    return hit ? hit.payload : null;
  }

  window.BBT_QUEUE = { isQueueable, enqueue, flush, count, all, pendingFor };
})();
