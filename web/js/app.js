(function () {
  const { DEAL_PCT } = window.BBT_CONFIG;
  const view = document.getElementById('view');
  const state = {
    tab: 'checklist',
    tools: [],            // tool_market_status rows
    sparks: {},           // listing_id -> [price,...]
    health: [],
    dealers: [],          // {id,name} for the manual-link picker
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
      const [tools, health, dealers] = await Promise.all([
        SB.select('tool_market_status', 'select=*'),
        SB.select('dealer_health', 'select=*'),
        SB.select('dealers', 'select=id,name&order=name.asc'),
      ]);
      state.tools = tools || [];
      state.health = health || [];
      state.dealers = dealers || [];

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
    if (t.best_source === 'auto-desc') badges.push('<span class="verify-tag">≈ verify</span>');

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
    if (t.best_source === 'auto-desc') badges.push('<span class="verify-tag">≈ verify</span>');
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
    const keyWarn = SB.hasWriterToken() ? ''
      : '<div class="keybar">Checkmarks are read-only until you add your access token in the <b>Settings</b> tab — that turns on sync.</div>';
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
    if (!SB.hasWriterToken()) {
      alert('Add your access token in the Settings tab to save checkmarks.');
      return;
    }
    const t = state.tools.find((x) => String(x.tool_id) === String(toolId));
    if (!t) return;
    const next = !t.owned;
    t.owned = next;              // optimistic
    render();
    try {
      await SB.writeApi('toggle_owned', { id: toolId, owned: next });
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
    const hasKey = SB.hasWriterToken();
    view.innerHTML = `<div class="import-box">
      <h3>Settings &amp; CSV import</h3>
      <p class="note">Editing is protected by an <b>access token</b> — a revocable password that lets this device save changes (checkmarks, edits, links, CSV import) without ever holding the database admin key. It's stored only in this browser (localStorage). Don't paste it on a shared device.</p>

      <div class="section-title">1 · Access token (enables saving)</div>
      <p class="note">Get it from your Supabase SQL editor: <code class="inline">select value from app_secrets where key = 'writer_token';</code> — copy the value and paste it below. (To revoke, rotate that value in Supabase.)</p>
      <input type="password" id="svcKey" placeholder="access token${hasKey ? ' (saved)' : ''}" />
      <button class="btn secondary" id="saveKey">Save token</button>
      ${hasKey ? '<button class="btn secondary" id="clearKey">Clear</button>' : ''}
      <p class="warn">${hasKey ? '✓ Access token saved on this device.' : 'No token set — saving is disabled (reads still work).'}</p>

      <div class="section-title">2 · Choose file</div>
      <input type="file" id="csvFile" accept=".csv,text/csv" ${hasKey ? '' : 'disabled'} />
      <div id="csvPreview" class="note"></div>
      <button class="btn" id="doImport" disabled>Import</button>
      <div id="importResult" class="note"></div>
    </div>`;

    document.getElementById('saveKey').onclick = () => {
      const v = document.getElementById('svcKey').value.trim();
      if (v) { localStorage.setItem('bbt_writer_token', v); renderImport(); }
    };
    const clr = document.getElementById('clearKey');
    if (clr) clr.onclick = () => { localStorage.removeItem('bbt_writer_token'); renderImport(); };

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
        `select=id,product_url,sku,active,source,match_score,dealer:dealers(name)&tool_id=eq.${toolId}`);
      const ids = (listings || []).map((l) => l.id);
      let snaps = [];
      if (ids.length) {
        snaps = await SB.select('price_snapshots',
          `select=listing_id,price_cad,regular_price_cad,on_sale,in_stock,scraped_at&listing_id=in.(${ids.join(',')})&order=scraped_at.asc`) || [];
      }
      const byListing = {};
      for (const s of snaps) (byListing[s.listing_id] ||= []).push(s);

      // Suggested (unconfirmed) matches from the description search — one tap to accept.
      const activeUrls = new Set((listings || []).filter((l) => l.active).map((l) => l.product_url));
      let cands = [];
      try {
        cands = await SB.select('map_candidates',
          `select=id,url,title,dealer_id,dealer:dealers(name)&tool_id=eq.${toolId}&confident=is.false&order=created_at.desc`) || [];
      } catch { cands = []; }
      cands = cands.filter((c) => !activeUrls.has(c.url)).slice(0, 6);

      const series = (listings || []).map((l) => ({
        label: l.dealer?.name || `Listing ${l.id}`,
        listingId: l.id,
        points: (byListing[l.id] || []).map((s) => ({ t: s.scraped_at, price: Number(s.price_cad) })),
      }));

      const chart = Charts.lineChart(series);
      const legend = series.map((s, i) =>
        `<span class="k"><span class="sw" style="background:${Charts.colorFor(i)}"></span>${esc(s.label)}</span>`).join('');

      // One row per dealer, cheapest first; the lowest in-stock price is BEST —
      // this is the single "one deal per tool" the user buys from.
      const rows = (listings || []).map((l) => {
        const last = (byListing[l.id] || []).slice(-1)[0];
        return { l, price: last ? Number(last.price_cad) : null, last };
      });
      rows.sort((a, b) => (a.price == null) - (b.price == null) || (a.price ?? 0) - (b.price ?? 0));
      const bestId = rows.find((r) => r.price != null)?.l.id ?? null;

      const dealerRows = rows.map(({ l, last }) => {
        const oos = last && last.in_stock === false;
        return `<div class="dealer-row${l.id === bestId ? ' best' : ''}">
          <div>
            <b>${esc(l.dealer?.name || '')}</b>${l.id === bestId ? ' <span class="best-tag">BEST</span>' : ''}${l.source === 'auto-desc' ? ' <span class="verify-tag" title="Auto-matched by description — open it to confirm it\'s the right product">≈ verify</span>' : ''}${oos ? ' <span class="badge oos">OOS</span>' : ''}
            <div class="tool-sub">${last ? money(last.price_cad) + ' · ' + fmtDate(last.scraped_at) : 'no price yet — will scrape next run'}</div>
          </div>
          <div class="dealer-actions">
            <a href="${esc(l.product_url)}" target="_blank" rel="noopener">Open ↗</a>
            <button class="link-x" data-remove-listing="${l.id}" title="Remove this link">✕</button>
          </div>
        </div>`;
      }).join('') || '<div class="note">No dealer links yet. Paste one below (or the scraper will map it automatically if it has a part number).</div>';

      // Manual-link form: dealer picker + URL. Known dealers use their own
      // scraper; "Other" prices any site via the generic fallback.
      const dealerOpts = state.dealers.map((d) =>
        `<option value="${d.id}"${d.name === 'Other' ? ' selected' : ''}>${esc(d.name)}</option>`).join('');
      const addForm = `
        <div class="section-title">Add a dealer link</div>
        <div class="add-link">
          <select id="alDealer">${dealerOpts}</select>
          <input type="url" id="alUrl" placeholder="Paste product page URL…" />
          <button class="btn" id="alAdd" data-tool="${toolId}">Add</button>
        </div>
        <div id="alMsg" class="note"></div>`;

      // Description-matched suggestions the user can accept with one tap.
      const suggestionsHTML = cands.length ? `
        <div class="section-title">Suggested matches — found by description</div>
        <div class="note" style="margin:-2px 0 8px">Auto-found by name (not confirmed). Open to check it's the right product, then tap Use.</div>
        ${cands.map((c) => `<div class="dealer-row">
          <div>
            <b>${esc(c.dealer?.name || '')}</b>
            <div class="tool-sub">${esc((c.title || '(no title)').slice(0, 90))}</div>
          </div>
          <div class="dealer-actions">
            <a href="${esc(c.url)}" target="_blank" rel="noopener">Open ↗</a>
            <button class="btn secondary btn-sm" data-use-cand="${c.id}" data-dealer="${c.dealer_id}" data-url="${esc(c.url)}">Use</button>
          </div>
        </div>`).join('')}` : '';

      detailBody.innerHTML = `
        <div class="detail-head">
          <h2>${esc(t?.name || 'Tool')}</h2>
          <button class="btn secondary btn-sm" id="detailEdit" data-edit="${t?.tool_id}">Edit</button>
        </div>
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
        <div class="dealer-list">${dealerRows}</div>
        ${suggestionsHTML}
        ${addForm}`;

      const ob = document.getElementById('detailOwn');
      if (ob) ob.onclick = async () => { await toggleOwned(ob.dataset.own); openDetail(toolId); };
      const eb = document.getElementById('detailEdit');
      if (eb) eb.onclick = () => openEditForm(eb.dataset.edit);
      detailBody.querySelectorAll('[data-remove-listing]').forEach((btn) => {
        btn.onclick = () => removeListing(btn.dataset.removeListing, toolId);
      });
      const alAdd = document.getElementById('alAdd');
      if (alAdd) alAdd.onclick = () => addListing(toolId);
      detailBody.querySelectorAll('[data-use-cand]').forEach((btn) => {
        btn.onclick = () => useCandidate(toolId, btn.dataset.dealer, btn.dataset.url, btn.dataset.useCand);
      });
    } catch (e) {
      detailBody.innerHTML = `<div class="empty">Couldn't load detail.<br><span class="muted">${esc(e.message)}</span></div>`;
    }
  }

  // ---- tool + listing editing (service key required) -------------------
  function ensureKey() {
    if (SB.hasWriterToken()) return true;
    alert('Add your access token in the Settings tab first — that unlocks editing, adding tools, and pasting links.');
    return false;
  }

  function openEditForm(toolId) {
    if (!ensureKey()) return;
    const t = toolId ? state.tools.find((x) => String(x.tool_id) === String(toolId)) : null;
    detail.classList.remove('hidden'); detail.setAttribute('aria-hidden', 'false');
    const v = (x) => esc(x ?? '');
    const cats = uniq(state.tools.map((x) => x.category));
    const tiers = uniq(state.tools.map((x) => x.tier));
    detailBody.innerHTML = `
      <h2>${t ? 'Edit tool' : 'Add a tool'}</h2>
      <div class="form-grid">
        <label class="full">Name<input id="f_name" value="${v(t?.name)}" placeholder="Tool name" /></label>
        <label>Part # / SKU<input id="f_pn" value="${v(t?.pn)}" placeholder="e.g. 2864-20" /></label>
        <label>Brand<input id="f_brand" value="${v(t?.brand)}" /></label>
        <label class="full">Model / spec text<input id="f_model" value="${v(t?.model_number)}" /></label>
        <label>Category<input id="f_cat" list="dl_cat" value="${v(t?.category)}" /></label>
        <label>Phase / tier<input id="f_tier" list="dl_tier" value="${v(t?.tier)}" /></label>
        <label>Quantity<input id="f_qty" type="number" min="1" value="${t?.quantity ?? 1}" /></label>
        <label>Target price<input id="f_target" type="number" step="0.01" value="${t?.target_price ?? ''}" /></label>
        <label class="full">Notes<textarea id="f_notes" rows="2">${v(t?.notes)}</textarea></label>
      </div>
      <datalist id="dl_cat">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <datalist id="dl_tier">${tiers.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <div class="form-actions">
        <button class="btn" id="f_save">${t ? 'Save changes' : 'Create tool'}</button>
        <button class="btn secondary" id="f_cancel">Cancel</button>
        ${t ? '<button class="btn danger" id="f_delete">Delete</button>' : ''}
      </div>
      <div class="note" style="margin-top:10px">${t
        ? 'Changing the part # or name re-arms the scraper — it re-maps this tool to dealers on the next run.'
        : 'New tools with a part # get auto-mapped to KMS on the next scrape run.'}</div>
      <div id="f_msg" class="note"></div>`;

    document.getElementById('f_cancel').onclick = () => { if (toolId) openDetail(toolId); else closeDetail(); };
    document.getElementById('f_save').onclick = () => saveToolForm(t);
    const del = document.getElementById('f_delete');
    if (del) del.onclick = () => deleteTool(t);
  }

  async function saveToolForm(orig) {
    const g = (id) => (document.getElementById(id).value || '').trim();
    const gnum = (id) => { const n = parseFloat(g(id)); return Number.isFinite(n) ? n : null; };
    const msg = document.getElementById('f_msg');
    const name = g('f_name');
    if (!name) { msg.textContent = 'Name is required.'; return; }
    const body = {
      name,
      pn: g('f_pn') || null,
      brand: g('f_brand') || null,
      model_number: g('f_model') || null,
      category: g('f_cat') || null,
      tier: g('f_tier') || null,
      quantity: gnum('f_qty') || 1,
      target_price: gnum('f_target'),
      notes: g('f_notes') || null,
    };
    msg.textContent = 'Saving…';
    try {
      if (orig) {
        // Re-arm the auto-mapper when identity/part number changed so the
        // scraper re-maps to dealers with the new SKU (server sets auto_map_state).
        const changedKey = body.pn !== (orig.pn || null)
          || body.model_number !== (orig.model_number || null)
          || body.name !== orig.name;
        await SB.writeApi('update_tool', { id: orig.tool_id, fields: body, remap: changedKey });
      } else {
        await SB.writeApi('insert_tool', { fields: body });
      }
      await loadAll();
      if (orig) openDetail(orig.tool_id); else closeDetail();
    } catch (e) {
      msg.textContent = 'Save failed: ' + e.message;
    }
  }

  async function deleteTool(t) {
    if (!t) return;
    if (!confirm(`Delete "${t.name}" and all its price history? This can't be undone.`)) return;
    try {
      await SB.writeApi('delete_tool', { id: t.tool_id });
      await loadAll();
      closeDetail();
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
  }

  async function addListing(toolId) {
    if (!ensureKey()) return;
    const sel = document.getElementById('alDealer');
    const urlEl = document.getElementById('alUrl');
    const msg = document.getElementById('alMsg');
    const url = (urlEl.value || '').trim();
    if (!/^https?:\/\//i.test(url)) { msg.textContent = 'Enter a full product URL (https://…).'; return; }
    msg.textContent = 'Adding…';
    try {
      await SB.writeApi('insert_listing', { tool_id: toolId, dealer_id: sel.value, product_url: url });
      openDetail(toolId); // refresh the dealer list; price lands on next scrape
    } catch (e) {
      msg.textContent = /duplicate|unique/i.test(e.message) ? 'That link is already saved for this dealer.' : 'Add failed: ' + e.message;
    }
  }

  // Promote a description-search suggestion to a tracked listing (user-approved).
  async function useCandidate(toolId, dealerId, url, candId) {
    if (!ensureKey()) return;
    try {
      await SB.writeApi('accept_candidate', { tool_id: toolId, dealer_id: dealerId, product_url: url, cand_id: candId });
      openDetail(toolId); // price lands on next scrape
    } catch (e) {
      alert(/duplicate|unique/i.test(e.message) ? 'That link is already tracked for this dealer.' : 'Could not add: ' + e.message);
    }
  }

  async function removeListing(listingId, toolId) {
    if (!ensureKey()) return;
    if (!confirm('Remove this dealer link? Its price history is kept but it stops being tracked.')) return;
    try {
      await SB.writeApi('remove_listing', { id: listingId });
      openDetail(toolId);
    } catch (e) {
      alert('Could not remove: ' + e.message);
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

  // Item name is the natural key; matching/upsert happens server-side in the proxy.
  async function importTools(rows) {
    return SB.writeApi('import_tools', { rows });
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
  document.getElementById('addToolBtn').onclick = () => openEditForm(null);

  // ---- boot ------------------------------------------------------------
  // One-time cleanup: purge any stale service_role key left in localStorage by
  // older builds — writes now use the revocable writer token, never the admin key.
  try { localStorage.removeItem('bbt_service_key'); } catch (e) { /* ignore */ }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
  loadAll();
})();
