// Tiny PostgREST client for the dashboard. Reads use the anon key. Writes (CSV
// import only) use a service_role key the user pastes locally into the Import
// tab; it lives in localStorage on this device and is never committed.
(function () {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.BBT_CONFIG;
  const REST = `${SUPABASE_URL}/rest/v1/`;

  function serviceKey() { return localStorage.getItem('bbt_service_key') || ''; }

  async function req(path, { method = 'GET', body, prefer, write = false } = {}) {
    const key = write && serviceKey() ? serviceKey() : SUPABASE_ANON_KEY;
    const headers = { apikey: key, Authorization: `Bearer ${key}` };
    if (body) headers['Content-Type'] = 'application/json';
    if (prefer) headers['Prefer'] = prefer;
    const res = await fetch(REST + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
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

  // Bulk upsert via service key (Import tab).
  const upsert = (table, rows, onConflict) =>
    req(`${table}${onConflict ? `?on_conflict=${onConflict}` : ''}`, {
      method: 'POST', body: rows, write: true,
      prefer: `resolution=merge-duplicates,return=minimal`,
    });

  window.SB = { select, upsert, req, serviceKey, hasServiceKey: () => !!serviceKey() };
})();
