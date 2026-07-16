// Tiny Supabase client for the dashboard.
// - READS use the public anon key against PostgREST (RLS makes it read-only).
// - WRITES go through the `writer` Edge Function, authorized by a per-device
//   writer token (Settings tab). The service_role key is NEVER in the browser.
(function () {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.BBT_CONFIG;
  const REST = `${SUPABASE_URL}/rest/v1/`;
  const FN = `${SUPABASE_URL}/functions/v1/`;

  function writerToken() { return localStorage.getItem('bbt_writer_token') || ''; }

  // Read-only PostgREST access with the public anon key.
  async function req(path, { method = 'GET', prefer } = {}) {
    const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
    if (prefer) headers['Prefer'] = prefer;
    const res = await fetch(REST + path, { method, headers });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText} — ${txt.slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  // GET helper: table + PostgREST query string (e.g. 'select=*&order=name.asc')
  const select = (table, qs = 'select=*') => req(`${table}?${qs}`);

  // One write to the Edge Function. Network failures are tagged `offline` so the
  // caller can tell "no signal" (worth queueing / retrying) apart from "the
  // server said no" (which retrying won't fix).
  async function send(op, payload = {}) {
    const token = writerToken();
    if (!token) throw new Error('Add your access token in the Settings tab to make changes.');
    let res;
    try {
      res = await fetch(FN + 'writer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, 'x-writer-token': token },
        body: JSON.stringify({ op, payload }),
      });
    } catch (netErr) {
      // fetch() only rejects when the request never got an answer — no signal,
      // DNS, a dropped connection. That's the case worth waiting out.
      const e = new Error("You're offline — this change needs a connection.");
      e.offline = true;
      e.cause = netErr;
      throw e;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data.result;
  }

  // All writes go through here, which is what makes it the right place to catch
  // "no signal": a queueable op is parked in IndexedDB and replayed later
  // (see queue.js) instead of failing in his hand. Everything else still throws,
  // honestly, rather than pretending it saved.
  const Q = () => window.BBT_QUEUE;

  async function writeApi(op, payload = {}) {
    if (!writerToken()) throw new Error('Add your access token in the Settings tab to make changes.');
    const q = Q();
    const queueable = !!q && q.isQueueable(op);

    // navigator.onLine is only reliable in the negative: false really does mean
    // no network, so skip a request we know will fail. (true is optimistic — a
    // captive portal or dead uplink still says true, which is why the catch
    // below has to handle it too.)
    if (queueable && navigator.onLine === false) {
      await q.enqueue(op, payload);
      return { queued: true };
    }
    try {
      return await send(op, payload);
    } catch (e) {
      if (e.offline && queueable) {
        await q.enqueue(op, payload);
        return { queued: true };
      }
      throw e;
    }
  }

  window.SB = { select, req, writeApi, send, writerToken, hasWriterToken: () => !!writerToken() };
})();
