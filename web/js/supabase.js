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

  // All writes: {op, payload} to the Edge Function, authorized by the writer token.
  async function writeApi(op, payload = {}) {
    const token = writerToken();
    if (!token) throw new Error('Add your access token in the Settings tab to make changes.');
    const res = await fetch(FN + 'writer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, 'x-writer-token': token },
      body: JSON.stringify({ op, payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data.result;
  }

  window.SB = { select, req, writeApi, writerToken, hasWriterToken: () => !!writerToken() };
})();
