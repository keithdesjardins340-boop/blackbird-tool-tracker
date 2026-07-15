(function () {
  const { DEAL_PCT } = window.BBT_CONFIG;
  const view = document.getElementById('view');
  const state = {
    tab: 'checklist',
    tools: [],            // tool_market_status rows
    sparks: {},           // listing_id -> [price,...]
    health: [],
    filters: { tier: '', category: '', owned: '', priced: '', q: '' },
  };

  // ---- helpers ---------------------------------------------------------
  const money = (v) => (v == null ? '—' : `$${Number(v).toFixed(2)}`);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();
  const fmtDate = (s) => (s ? new Date(s).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

  function isDeal(t) {
    if (t.best_price == null) return false;
    return (t.pct_vs_avg_90d != null && t.pct_vs_avg_90d <= DEAL_PCT) || t.at_all_time_low === true;
  }
  function dealScore(t) {
    if (t.pct_vs_avg_90d != null) return t.pct_vs_avg_90d;
    return t.at_all_time_low ? -999 : 0;
  }

  // ---- data load -------------------------------------------------------
  async function loadAll() {
    view.innerHTML = '<div class="loading">Loading…</div>';
    try {
      const [tools, health] = await Promise.all([
        SB.select('tool_market_status', 'select=*'),
        SB.select('dealer_health', 'select=*'),
      ]);
      state.tools = tools || [];
      state.health = health || [];

      const listingIds = uniq(state.tools.map((t) => t.best_listing_id).filter((x) => x != null));
      state.sparks = {};
      if (listingIds.length) {
        const since = new Date(Date.now() - 90 * 864e5).toISOString();
        const rows = await SB.select(
          'price_snapshots',
          `select=listing_id,price_cad,scraped_at&listing_id=in.(${listingIds.join(',')})&scraped_at=gte.${since}&order=scraped_at.asc`
        );
        for (const r of rows || []) (state.sparks[r.listing_id] ||= []).push(Number(r.price_cad));
      }
      render();
    } catch (e) {
      view.innerHTML = `<div class="empty">Couldn't load data.<br><span class="muted">${esc(e.message)}</span></div>`;
    }
  }

  // ---- filtering -------------------------------------------------------
  function applyFilters(list) {
    const f = state.filters;
    return list.filter((t) => {
      if (f.tier && t.tier !== f.tier) return false;
      if (f.category && t.category !== f.category) return false;
      if (f.owned === 'owned' && !t.owned) return false;
      if (f.owned === 'need' && t.owned) return false;
      if (f.priced === 'priced' && t.best_price == null) return false;
      if (f.q) {
        const hay = `${t.name} ${t.pn || ''} ${t.model_number || ''}`.toLowerCase();
        if (!hay.includes(f.q.toLowerCase())) return false;
      }
      return true;
    });
  }

  function filtersBar() {
    const cats = uniq(state.tools.map((t) => t.category));
    const tiers = uniq(state.tools.map((t) => t.tier));
    const opt = (v, sel) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(v || 'All')}</option>`;
    const f = state.filters;
    return `<div class="filters">
      <input type="search" id="fq" placeholder="Search name / SKU…" value="${esc(f.q)}" />
      <select id="ftier"><option value="">Phase: All</option>${tiers.map((v) => opt(v, f.tier)).join('')}</select>
      <select id="fcat"><option value="">Category: All</option>${cats.map((v) => opt(v, f.category)).join('')}</select>
      <select id="fowned">
        <option value="">Owned: All</option>
        <option value="owned"${f.owned === 'owned' ? ' selected' : ''}>Have it ✓</option>
        <option value="need"${f.owned === 'need' ? ' selected' : ''}>Still needed</option>
      </select>
      <select id="fpriced">
        <option value="">Price: All</option>
        <option value="priced"${f.priced === 'priced' ? ' selected' : ''}>Tracked only</option>
      </select>
    </div>`;
  }

  function wireFilters() {
    const bind = (id, key, ev = 'change') => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(ev, () => { state.filters[key] = el.value; render(); });
    };
    bind('fq', 'q', 'input'); bind('ftier', 'tier'); bind('fcat', 'category'); bind('fowned', 'owned'); bind('fpriced', 'priced');
  }

  // ---- card ------------------------------------------------------------
  function toolCard(t) {
    const spark = Charts.sparkline(state.sparks[t.best_listing_id] || (t.best_price != null ? [t.best_price] : []));
    const badges = [];
    if (t.at_or_below_target) badges.push('<span class="badge target">≤ target</span>');
    if (t.at_all_time_low) badges.push('<span class="badge low">all-time low</span>');
    if (isDeal(t) && !t.at_all_time_low) badges.push('<span class="badge deal">deal</span>');
    if (t.on_sale) badges.push('<span class="badge sale">on sale</span>');
    if (t.in_stock === false) badges.push('<span class="badge oos">out of stock</span>');

    let delta = '<span class="delta flat">—</span>';
    if (t.pct_vs_avg_90d != null) {
      const p = t.pct_vs_avg_90d;
      const cls = p < -0.5 ? 'down' : p > 0.5 ? 'up' : 'flat';
      const sign = p > 0 ? '+' : '';
      delta = `<span class="delta ${cls}">${sign}${p}% <span class="muted">vs 90d</span></span>`;
    }

    const priceBlock = t.best_price != null
      ? `<div class="amount">${money(t.best_price)}</div><div class="dealer">${esc(t.best_dealer || '')}</div>`
      : `<div class="na">No price yet</div>`;

    return `<div class="card" data-tool="${t.tool_id}">
      <div class="card-top">
        <div>
          <div class="tool-name">${esc(t.name)}${t.owned ? ' <span class="owned-tag">✓ have</span>' : ''}</div>
          <div class="tool-sub">${esc([t.pn || t.model_number].filter(Boolean).join(' · '))}${t.category ? (t.pn || t.model_number ? ' — ' : '') + esc(t.category) : ''}</div>
        </div>
        <div class="price">${priceBlock}</div>
      </div>
      <div class="card-bottom">
        <div class="badges">${badges.join('') || '<span class="badge">tracking</span>'}</div>
        <div style="display:flex;align-items:center;gap:10px">${delta}${spark}</div>
      </div>
    </div>`;
  }

  function cardListHTML(list) {
    if (!list.length) return '<div class="empty">Nothing here yet.</div>';
    return list.map(toolCard).join('');
  }

  // ---- checklist (merged tool list + prices) ---------------------------
  function checkRow(t) {
    const priced = t.best_price != null;
    const badges = [];
    if (t.at_all_time_low) badges.push('<span class="badge low">low</span>');
    else if (isDeal(t)) badges.push('<span class="badge deal">deal</span>');
    if (t.on_sale) badges.push('<span class="badge sale">sale</span>');
    if (t.at_or_below_target) badges.push('<span class="badge target">≤ target</span>');
    const price = priced
      ? `<div class="cr-price"><span class="amount">${money(t.best_price)}</span><span class="cr-dealer">${esc(t.best_dealer || '')}</span></div>`
      : `<div class="cr-price na">—</div>`;
    const qty = t.quantity && t.quantity > 1 ? `<span class="cr-qty">×${t.quantity}</span>` : '';
    const sub = esc(t.pn || t.model_number || '');
    return `<div class="check-row${t.owned ? ' owned' : ''}" data-tool="${t.tool_id}">
      <button class="check-box${t.owned ? ' on' : ''}" data-check="${t.tool_id}" aria-label="Toggle have it">${t.owned ? '✓' : ''}</button>
      <div class="cr-main">
        <div class="cr-name">${esc(t.name)} ${qty}</div>
        <div class="cr-sub">${sub}${badges.length ? ' ' + badges.join('') : ''}</div>
      </div>
      ${price}
    </div>`;
  }

  // Buy-order windows. Tier 1 first, then 2, then 3.
  const TIERS = [
    { key: 'Tier 1', label: 'Tier 1 — Buy first', desc: 'Always on the F-250, every shift' },
    { key: 'Tier 2', label: 'Tier 2 — Buy next', desc: 'Job-pulled · seasonal · container-staged' },
    { key: 'Tier 3', label: 'Tier 3 — Phase 2 (F-550)', desc: 'New capacity once the bigger truck is in play' },
  ];

  function progressBar(owned, total) {
    const pct = total ? Math.round((owned / total) * 100) : 0;
    return `<div class="prog"><div class="prog-bar"><span style="width:${pct}%"></span></div>
      <div class="prog-label">${owned} / ${total} have · ${pct}%</div></div>`;
  }

  function catBlocks(items) {
    const byCat = {};
    for (const t of items) (byCat[t.category || 'Uncategorized'] ||= []).push(t);
    let html = '';
    for (const c of Object.keys(byCat).sort()) {
      const ci = byCat[c].sort((a, b) => a.name.localeCompare(b.name));
      const o = ci.filter((t) => t.owned).length;
      html += `<div class="cat-head">${esc(c)}<span class="cat-count">${o}/${ci.length}</span></div>`;
      html += ci.map(checkRow).join('');
    }
    return html;
  }

  function renderChecklist() {
    const list = applyFilters(state.tools);
    const keyWarn = SB.hasServiceKey() ? ''
      : '<div class="keybar">Checkmarks are read-only until you add your service key in the <b>Settings</b> tab — that turns on sync.</div>';
    let html = filtersBar() + keyWarn
      + progressBar(list.filter((t) => t.owned).length, list.length);

    // Group into Tier windows in buy order; unknown tiers fall to the end.
    const byTier = {};
    for (const t of list) (byTier[t.tier || 'Unassigned'] ||= []).push(t);
    const order = [...TIERS.map((x) => x.key), ...Object.keys(byTier).filter((k) => !TIERS.some((x) => x.key === k))];

    for (const tk of order) {
      const items = byTier[tk];
      if (!items || !items.length) continue;
      const meta = TIERS.find((x) => x.key === tk);
      const o = items.filter((t) => t.owned).length;
      html += `<section class="tier-window" data-tier="${esc(tk)}">
        <div class="tier-head">
          <div><div class="tier-title">${esc(meta ? meta.label : tk)}</div>
            <div class="tier-desc">${esc(meta ? meta.desc : '')}</div></div>
          <div class="tier-count">${o}/${items.length}</div>
        </div>
        ${catBlocks(items)}
      </section>`;
    }
    view.innerHTML = html;
    wireFilters();
  }

  async function toggleOwned(toolId) {
    if (!SB.hasServiceKey()) {
      alert('Add your service_role key in the Settings tab to save checkmarks (Supabase → Project Settings → API).');
      return;
    }
    const t = state.tools.find((x) => String(x.tool_id) === String(toolId));
    if (!t) return;
    const next = !t.owned;
    t.owned = next;              // optimistic
    render();
    try {
      await SB.req(`tools?id=eq.${toolId}`, { method: 'PATCH', body: { owned: next }, write: true, prefer: 'return=minimal' });
    } catch (e) {
      t.owned = !next; render();
      alert('Could not save: ' + e.message);
    }
  }

  // ---- views -----------------------------------------------------------
  function renderWatchlist() {
    const list = applyFilters(state.tools).sort((a, b) => a.name.localeCompare(b.name));
    view.innerHTML = filtersBar() + cardListHTML(list);
    wireFilters();
  }

  function renderDeals() {
    const deals = applyFilters(state.tools).filter(isDeal).sort((a, b) => dealScore(a) - dealScore(b));
    view.innerHTML = filtersBar()
      + `<div class="section-title">${deals.length} deal${deals.length === 1 ? '' : 's'} — ≥${Math.abs(DEAL_PCT)}% below 90-day avg or at all-time low</div>`
      + cardListHTML(deals);
    wireFilters();
  }

  function renderHealth() {
    if (!state.health.length) { view.innerHTML = '<div class="empty">No dealers.</div>'; return; }
    const row = (d) => {
      let cls = 'idle', label = 'never run';
      if (d.last_run_at) {
        if (d.fail_count > 0 && d.ok_count === 0) { cls = 'bad'; label = 'all failing'; }
        else if (d.fail_count > 0) { cls = 'warn'; label = `${d.fail_count} failing`; }
        else { cls = 'ok'; label = 'healthy'; }
      }
      if (d.scraper_status === 'beta') label += ' · beta';
      return `<div class="health-row">
        <div>
          <div><span class="status-dot ${cls}"></span><b>${esc(d.name)}</b></div>
          <div class="tool-sub">last run ${fmtDate(d.last_run_at)} · ${d.ok_count ?? 0} ok / ${d.fail_count ?? 0} fail</div>
        </div>
        <div class="tool-sub" style="text-align:right">${esc(label)}</div>
      </div>`;
    };
    view.innerHTML = '<div class="section-title">Scraper health — last run per dealer</div>' + state.health.map(row).join('');
  }

  function renderImport() {
    const hasKey = SB.hasServiceKey();
    view.innerHTML = `<div class="import-box">
      <h3>Settings &amp; CSV import</h3>
      <p class="note">Your <b>service_role</b> key unlocks two things on this device: <b>saving checkmarks</b> (the ✓ Have-it toggles, synced to Supabase) and <b>CSV import</b>. It's stored only in this browser (localStorage) and never sent anywhere but Supabase. Don't paste it on a shared device.</p>

      <div class="section-title">1 · Service key (enables checkmarks + import)</div>
      <p class="note">Supabase → Project Settings → API → <code class="inline">service_role</code> (secret) → Reveal → Copy.</p>
      <input type="password" id="svcKey" placeholder="service_role key${hasKey ? ' (saved)' : ''}" />
      <button class="btn secondary" id="saveKey">Save key</button>
      ${hasKey ? '<button class="btn secondary" id="clearKey">Clear</button>' : ''}
      <p class="warn">${hasKey ? '✓ Service key saved on this device.' : 'No service key set — import is disabled.'}</p>

      <div class="section-title">2 · Choose file</div>
      <input type="file" id="csvFile" accept=".csv,text/csv" ${hasKey ? '' : 'disabled'} />
      <div id="csvPreview" class="note"></div>
      <button class="btn" id="doImport" disabled>Import</button>
      <div id="importResult" class="note"></div>
    </div>`;

    document.getElementById('saveKey').onclick = () => {
      const v = document.getElementById('svcKey').value.trim();
      if (v) { localStorage.setItem('bbt_service_key', v); renderImport(); }
    };
    const clr = document.getElementById('clearKey');
    if (clr) clr.onclick = () => { localStorage.removeItem('bbt_service_key'); renderImport(); };

    let parsed = [];
    const fileEl = document.getElementById('csvFile');
    const importBtn = document.getElementById('doImport');
    if (fileEl) fileEl.onchange = async () => {
      const file = fileEl.files[0]; if (!file) return;
      try {
        parsed = parseToolCsv(await file.text());
        document.getElementById('csvPreview').textContent = `${parsed.length} row(s) parsed.`;
        importBtn.disabled = parsed.length === 0;
      } catch (e) {
        document.getElementById('csvPreview').textContent = 'Parse error: ' + e.message;
      }
    };
    if (importBtn) importBtn.onclick = async () => {
      importBtn.disabled = true;
      const out = document.getElementById('importResult');
      out.textContent = 'Importing…';
      try {
        const res = await importTools(parsed);
        out.textContent = `Done: ${res.inserted} inserted, ${res.updated} updated, ${res.skipped} skipped.`;
        loadAll();
      } catch (e) {
        out.textContent = 'Import failed: ' + e.message;
        importBtn.disabled = false;
      }
    };
  }

  // ---- detail overlay --------------------------------------------------
  const detail = document.getElementById('detail');
  const detailBody = document.getElementById('detailBody');
  document.getElementById('detailClose').onclick = closeDetail;
  detail.addEventListener('click', (e) => { if (e.target === detail) closeDetail(); });
  function closeDetail() { detail.classList.add('hidden'); detail.setAttribute('aria-hidden', 'true'); }

  async function openDetail(toolId) {
    const t = state.tools.find((x) => String(x.tool_id) === String(toolId));
    detail.classList.remove('hidden'); detail.setAttribute('aria-hidden', 'false');
    detailBody.innerHTML = '<div class="loading">Loading history…</div>';
    try {
      const listings = await SB.select('tool_listings',
        `select=id,product_url,sku,active,dealer:dealers(name)&tool_id=eq.${toolId}`);
      const ids = (listings || []).map((l) => l.id);
      let snaps = [];
      if (ids.length) {
        snaps = await SB.select('price_snapshots',
          `select=listing_id,price_cad,regular_price_cad,on_sale,in_stock,scraped_at&listing_id=in.(${ids.join(',')})&order=scraped_at.asc`) || [];
      }
      const byListing = {};
      for (const s of snaps) (byListing[s.listing_id] ||= []).push(s);

      const series = (listings || []).map((l) => ({
        label: l.dealer?.name || `Listing ${l.id}`,
        listingId: l.id,
        points: (byListing[l.id] || []).map((s) => ({ t: s.scraped_at, price: Number(s.price_cad) })),
      }));

      const chart = Charts.lineChart(series);
      const legend = series.map((s, i) =>
        `<span class="k"><span class="sw" style="background:${Charts.colorFor(i)}"></span>${esc(s.label)}</span>`).join('');

      const dealerRows = (listings || []).map((l, i) => {
        const last = (byListing[l.id] || []).slice(-1)[0];
        return `<div class="dealer-row">
          <div><b>${esc(l.dealer?.name || '')}</b>
            <div class="tool-sub">${last ? money(last.price_cad) + ' · ' + fmtDate(last.scraped_at) + (last.in_stock === false ? ' · OOS' : '') : 'no data yet'}</div>
          </div>
          <a href="${esc(l.product_url)}" target="_blank" rel="noopener">Open ↗</a>
        </div>`;
      }).join('') || '<div class="note">No dealer listings yet — use the link finder to add some.</div>';

      detailBody.innerHTML = `
        <h2>${esc(t?.name || 'Tool')}</h2>
        <div class="tool-sub">${esc([t?.pn || t?.model_number].filter(Boolean).join(' · '))}${t?.category ? (t?.pn || t?.model_number ? ' — ' : '') + esc(t.category) : ''}${t?.quantity && t.quantity > 1 ? ' · qty ' + t.quantity : ''}</div>
        <button class="btn ${t?.owned ? 'secondary' : ''} own-toggle" id="detailOwn" data-own="${t?.tool_id}">${t?.owned ? '✓ Have it — tap to unmark' : 'Mark as have it'}</button>
        <div class="stat-grid">
          <div class="stat"><div class="v">${money(t?.best_price)}</div><div class="l">best now (${esc(t?.best_dealer || '—')})</div></div>
          <div class="stat"><div class="v">${money(t?.avg_90d)}</div><div class="l">90-day avg</div></div>
          <div class="stat"><div class="v">${money(t?.all_time_low)}</div><div class="l">all-time low</div></div>
        </div>
        ${t?.target_price != null ? `<div class="note">Target: ${money(t.target_price)} ${t.at_or_below_target ? '— <span style="color:var(--green)">met ✓</span>' : ''}</div>` : ''}
        ${t?.notes ? `<div class="note" style="margin-top:8px">📝 ${esc(t.notes)}</div>` : ''}
        <div class="section-title">Price history</div>
        <div class="hist-wrap">${chart}<div class="legend">${legend}</div></div>
        <div class="dealer-list">${dealerRows}</div>`;
      const ob = document.getElementById('detailOwn');
      if (ob) ob.onclick = async () => { await toggleOwned(ob.dataset.own); openDetail(toolId); };
    } catch (e) {
      detailBody.innerHTML = `<div class="empty">Couldn't load detail.<br><span class="muted">${esc(e.message)}</span></div>`;
    }
  }

  // ---- CSV import (client-side) ----------------------------------------
  const ALIASES = {
    name: ['item name', 'checklist item', 'name', 'item', 'tool', 'description'],
    brand: ['brand', 'make', 'manufacturer'],
    model_number: ['model / part #', 'model/part number', 'model', 'model number', 'part number', 'part', 'model/part', 'sku'],
    category: ['category', 'cat', 'type'],
    tier: ['tier', 'priority', 'level'],
    target_price: ['budget price', 'est cad', 'target price', 'budget', 'target', 'price', 'est'],
    notes: ['notes', 'note', 'comments'],
  };

  function parseCsvRaw(text) {
    const rows = []; let row = [], field = '', q = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some((x) => x !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); if (row.some((x) => x !== '')) rows.push(row); }
    return rows;
  }

  function parseToolCsv(text) {
    const rows = parseCsvRaw(text);
    if (rows.length < 2) throw new Error('need a header row + at least one data row');
    const headers = rows[0].map((h) => h.trim().toLowerCase());
    const idx = {};
    for (const [field, al] of Object.entries(ALIASES)) {
      const i = headers.findIndex((h) => al.includes(h));
      if (i >= 0) idx[field] = i;
    }
    if (idx.name == null) throw new Error('no "item name" column found');
    const num = (v) => { const n = parseFloat(String(v || '').replace(/[^\d.,]/g, '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
    return rows.slice(1).map((r) => ({
      name: (r[idx.name] || '').trim(),
      brand: idx.brand != null ? (r[idx.brand] || '').trim() || null : null,
      model_number: idx.model_number != null ? (r[idx.model_number] || '').trim() || null : null,
      category: idx.category != null ? (r[idx.category] || '').trim() || null : null,
      tier: idx.tier != null ? (r[idx.tier] || '').trim() || null : null,
      target_price: idx.target_price != null ? num(r[idx.target_price]) : null,
      notes: idx.notes != null ? (r[idx.notes] || '').trim() || null : null,
    })).filter((t) => t.name);
  }

  async function importTools(rows) {
    // Item name is the natural key (model_number is descriptive, not a SKU).
    const existing = await SB.select('tools', 'select=id,name') || [];
    const map = new Map(existing.map((t) => [(t.name || '').toLowerCase(), t.id]));
    let inserted = 0, updated = 0, skipped = 0;
    const toInsert = [];
    for (const t of rows) {
      if (!t.name) { skipped++; continue; }
      const id = map.get(t.name.toLowerCase());
      if (id) {
        await SB.req(`tools?id=eq.${id}`, { method: 'PATCH', body: { ...t, updated_at: new Date().toISOString() }, write: true, prefer: 'return=minimal' });
        updated++;
      } else toInsert.push(t);
    }
    if (toInsert.length) { await SB.req('tools', { method: 'POST', body: toInsert, write: true, prefer: 'return=minimal' }); inserted = toInsert.length; }
    return { inserted, updated, skipped };
  }

  // ---- routing / tabs --------------------------------------------------
  const RENDERERS = { checklist: renderChecklist, watchlist: renderWatchlist, deals: renderDeals, health: renderHealth, import: renderImport };
  function render() {
    document.getElementById('dealsCount').textContent = state.tools.filter(isDeal).length || '';
    (RENDERERS[state.tab] || renderChecklist)();
  }

  document.getElementById('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab'); if (!btn) return;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    state.tab = btn.dataset.tab;
    render();
  });
  view.addEventListener('click', (e) => {
    const chk = e.target.closest('[data-check]');
    if (chk) { e.stopPropagation(); toggleOwned(chk.dataset.check); return; }
    const row = e.target.closest('.card[data-tool], .check-row[data-tool]');
    if (row) openDetail(row.dataset.tool);
  });
  document.getElementById('refreshBtn').onclick = loadAll;

  // ---- boot ------------------------------------------------------------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
  loadAll();
})();
