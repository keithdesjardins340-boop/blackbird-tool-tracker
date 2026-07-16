import { DEAL_PCT, STALE_MANUAL_DAYS, PRICE_AGE_CHIP_DAYS, SEARCH_FROM_TOOLS } from './constants.js';

(function () {
  const view = document.getElementById('view');
  const state = {
    tab: 'checklist',
    tools: [],            // tool_market_status rows
    sparks: {},           // listing_id -> [price,...]
    health: [],
    dealers: [],          // {id,name} for the manual-link picker
    issues: [],           // links the last scrape couldn't price (Health alert)
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

  // ---- offline cache ---------------------------------------------------
  // Persist the last good snapshot so the checklist opens instantly with zero
  // signal (remote sites). We render from cache first, then refresh in the
  // background; if the refresh fails we keep showing the cache with a stale note.
  function saveCache() {
    try {
      localStorage.setItem('bbt_cache', JSON.stringify({
        at: Date.now(), tools: state.tools, health: state.health, dealers: state.dealers, sparks: state.sparks,
      }));
    } catch (e) { /* quota exceeded — fine, cache is best-effort */ }
  }
  function loadCache() {
    try { return JSON.parse(localStorage.getItem('bbt_cache') || 'null'); } catch { return null; }
  }

  // ---- scrape clock (the brand mark) -----------------------------------
  // The dot beside "Blackbird" is a clock: it empties the moment a scrape runs and
  // fills as the next scheduled one comes due, so "how fresh are these prices?" is
  // answerable without opening anything. A manual "Run price scrape now" resets it
  // too, because it tracks the last ACTUAL run, not just the timetable.
  const CRON_UTC_HOURS = [1, 13]; // must match .github/workflows/scrape.yml

  function nextScrapeAfter(t) {
    let best = Infinity;
    const d = new Date(t);
    for (const off of [0, 1]) {
      for (const h of CRON_UTC_HOURS) {
        const c = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + off, h, 0, 0, 0);
        if (c > +t && c < best) best = c;
      }
    }
    return new Date(best);
  }
  function lastScrapeAt() {
    const t = (state.health || []).map((d) => d.last_run_at).filter(Boolean).map((s) => +new Date(s));
    return t.length ? new Date(Math.max(...t)) : null;
  }
  const fmtSpan = (ms) => {
    const m = Math.max(0, Math.round(ms / 60000));
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  function renderScrapeClock() {
    const el = document.getElementById('scrapeClock');
    if (!el) return;
    const now = new Date();
    const last = lastScrapeAt();
    const next = nextScrapeAfter(now);
    // Fill = how far through the gap between the last real run and the next due one.
    let frac = 0;
    if (last) {
      const span = +next - +last;
      frac = span > 0 ? Math.min(1, Math.max(0, (+now - +last) / span)) : 1;
    }
    const R = 6, C = 2 * Math.PI * R;
    el.innerHTML = `<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="${R}" fill="none" stroke="var(--line-2)" stroke-width="2.5"/>
      <circle cx="8" cy="8" r="${R}" fill="none" stroke="var(--ink)" stroke-width="2.5"
        stroke-linecap="round" transform="rotate(-90 8 8)"
        stroke-dasharray="${(frac * C).toFixed(2)} ${C.toFixed(2)}"/>
    </svg>`;
    el.title = last
      ? `Last scrape ${fmtSpan(now - last)} ago · next in ${fmtSpan(next - now)}`
      : `No scrape yet · next in ${fmtSpan(next - now)}`;
  }

  // ---- scraper issues (the "go fix this link" alert) --------------------
  // run.js logs every failure as {listing_id,url,error} into scrape_runs.error_log
  // (plus `deactivated` when a 404/410 killed the link), and dealer_health exposes
  // the latest run's log per dealer. That's the alert: what the last pass couldn't
  // price, i.e. links that moved, died, or got blocked.
  function collectIssues() {
    const out = [];
    for (const d of state.health || []) {
      let log = d.error_log;
      if (typeof log === 'string') { try { log = JSON.parse(log); } catch { log = null; } }
      for (const e of Array.isArray(log) ? log : []) out.push({ dealer: d.name, ...e });
    }
    return out;
  }

  // Attach the tool each broken link belongs to, so Health can link to the fix.
  async function resolveIssueTools(issues) {
    const ids = [...new Set(issues.map((i) => i.listing_id).filter(Boolean))];
    if (!ids.length) return issues;
    try {
      const rows = await SB.select('tool_listings', `select=id,tool_id,tool:tools(name)&id=in.(${ids.join(',')})`);
      const by = new Map((rows || []).map((r) => [r.id, r]));
      for (const i of issues) {
        const r = by.get(i.listing_id);
        if (r) { i.tool_id = r.tool_id; i.tool = r.tool?.name; }
      }
    } catch { /* names are a nicety, not required */ }
    return issues;
  }

  // ---- data load -------------------------------------------------------
  async function loadAll() {
    if (!state.tools.length) {
      const c = loadCache();
      if (c && c.tools) {
        state.tools = c.tools; state.health = c.health || []; state.dealers = c.dealers || []; state.sparks = c.sparks || {};
        state.issues = collectIssues();
        state.lastGoodAt = c.at;
        await syncPendingUI(); // his queued ticks outrank the cached copy
        render(); // instant paint from cache
      } else {
        view.innerHTML = '<div class="loading">Loading…</div>';
      }
    }
    try {
      const [tools, health, dealers] = await Promise.all([
        SB.select('tool_market_status', 'select=*'),
        SB.select('dealer_health', 'select=*'),
        SB.select('dealers', 'select=id,name&order=name.asc'),
      ]);
      state.tools = tools || [];
      state.health = health || [];
      state.dealers = dealers || [];
      state.issues = await resolveIssueTools(collectIssues());

      const listingIds = uniq(state.tools.map((t) => t.best_listing_id).filter((x) => x != null));
      state.sparks = {};
      if (listingIds.length) {
        // One row per listing, holding a ready-made array of recent prices — the
        // 90-day window and the is_anomaly filter live in the view (0021).
        //
        // This used to pull the raw snapshots and group them here, which broke
        // twice over as the list grew: the Data API caps responses at 1000 rows
        // SILENTLY, and ~180 snapshots per listing per 90 days meant the cap hit
        // at about six priced tools — dropping the NEWEST rows, because it was
        // ordered ascending. Sparklines would have quietly stopped short of today.
        const rows = await SB.select(
          'listing_spark',
          `select=listing_id,prices&listing_id=in.(${listingIds.join(',')})`
        );
        for (const r of rows || []) state.sparks[r.listing_id] = (r.prices || []).map(Number);
      }
      state.offline = false; state.lastGoodAt = Date.now();
      // The server's `owned` is authoritative EXCEPT where a queued tick hasn't
      // reached it yet — overlay those before caching, or saveCache() would
      // freeze the pre-tick value into the offline copy.
      await syncPendingUI();
      saveCache();
      render();
    } catch (e) {
      if (state.tools.length) { state.offline = true; render(); } // keep the cached view up
      else view.innerHTML = `<div class="empty">Couldn't load data.<br><span class="muted">${esc(e.message)}</span></div>`;
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
        // Brand too: he thinks "Fluke", not "Fluke 87V-MAX True RMS…".
        const hay = `${t.name} ${t.brand || ''} ${t.pn || ''} ${t.model_number || ''}`.toLowerCase();
        if (!hay.includes(f.q.toLowerCase())) return false;
      }
      return true;
    });
  }

  function filtersBar() {
    // Offer the standard categories plus anything custom already in the list.
    const cats = uniq([...CATEGORIES, ...state.tools.map((t) => t.category)]);
    // Always offer the three buy-order tiers — even on an empty list — plus any
    // other tier value that actually exists in the data (legacy / imported).
    const tierKeys = TIERS.map((x) => x.key);
    const tiers = [...tierKeys, ...uniq(state.tools.map((t) => t.tier)).filter((v) => v && !tierKeys.includes(v))];
    const opt = (v, sel) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(v || 'All')}</option>`;
    const f = state.filters;
    // A search box over a list you can see in one glance is chrome. It earns its
    // place once the list outgrows the screen — or the moment he's typed in it,
    // otherwise it would vanish mid-search as results narrow past the threshold.
    const showSearch = state.tools.length > SEARCH_FROM_TOOLS || !!f.q;
    return `<div class="filters">
      ${showSearch ? `<input type="search" id="fq" placeholder="Search name / brand / part #…"
        aria-label="Search tools" value="${esc(f.q)}" />` : ''}
      <select id="ftier"><option value="">Tier: All</option>${tiers.map((v) => opt(v, f.tier)).join('')}</select>
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

    const q = document.getElementById('fq');
    if (q) {
      // Esc clears — the standard reflex for a search box, and faster than
      // selecting and deleting on a phone.
      q.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !q.value) return;
        e.preventDefault();
        e.stopPropagation(); // don't let it reach an overlay's Esc handler
        state.filters.q = '';
        render();
        document.getElementById('fq')?.focus();
      });
      // render() replaces the input, so put the caret back where it was.
      if (state.filters.q && document.activeElement !== q) {
        const pos = q.value.length;
        q.focus(); q.setSelectionRange(pos, pos);
      }
    }
  }

  // ---- lazy sparklines -------------------------------------------------
  // A sparkline is ~90 days of points turned into an SVG path. Cheap once,
  // wasteful ×200 for cards that are nowhere near the screen — and it all lands
  // on the main thread of a phone before the first paint. Cards reserve the
  // space and the chart is drawn as it scrolls up.
  let sparkObserver = null;

  function drawSpark(slot) {
    if (slot.firstChild) return;
    const id = slot.getAttribute('data-spark');
    const only = slot.getAttribute('data-only');
    const values = state.sparks[id] || (only != null ? [Number(only)] : []);
    slot.innerHTML = Charts.sparkline(values);
  }

  /** Placeholder at the sparkline's exact size — reserving it is what stops the
   *  list jumping under his thumb as charts appear. */
  function sparkSlot(t) {
    const only = t.best_price != null ? ` data-only="${esc(String(t.best_price))}"` : '';
    return `<span class="spark-slot" data-spark="${esc(String(t.best_listing_id ?? ''))}"${only}></span>`;
  }

  function wireSparklines() {
    // Always drop the previous observer first: render() replaces the whole view,
    // so its targets are detached nodes and keeping them alive is a leak that
    // grows with every tab switch.
    if (sparkObserver) { sparkObserver.disconnect(); sparkObserver = null; }
    const slots = view.querySelectorAll('.spark-slot');
    if (!slots.length) return;
    if (!('IntersectionObserver' in window)) { slots.forEach(drawSpark); return; } // no observer: just draw
    sparkObserver = new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        drawSpark(e.target);
        obs.unobserve(e.target); // drawn once; stop watching
      }
    }, { rootMargin: '200px' }); // draw just before it arrives, so it's never seen filling in
    slots.forEach((s) => sparkObserver.observe(s));
  }

  // ---- card ------------------------------------------------------------
  function toolCard(t) {
    const spark = sparkSlot(t);
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

    // The age rides with the price, not in the badge row: it qualifies THIS
    // number, and reading "$725.67" without "18 d" next to it is the whole problem.
    const priceBlock = t.best_price != null
      ? `<div class="amount">${money(t.best_price)}</div><div class="dealer">${esc(t.best_dealer || '')}${ageChip(t.best_scraped_at)}${copyBtn(t.best_url, `Copy the ${t.best_dealer || 'best'} link for ${t.name}`)}</div>`
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
    // Once he's bought it, what he PAID is the true number for that row — the
    // current best price is just noise on a tool he already owns.
    const bought = t.owned && t.purchase_price_cad != null;
    const price = bought
      ? `<div class="cr-price paid"><span class="amount">${money(t.purchase_price_cad)}</span><span class="cr-dealer">paid${t.purchase_dealer ? ' · ' + esc(t.purchase_dealer) : ''}</span></div>`
      : priced
        ? `<div class="cr-price"><span class="amount">${money(t.best_price)}</span><span class="cr-dealer">${esc(t.best_dealer || '')}${ageChip(t.best_scraped_at)}</span></div>`
        : `<div class="cr-price na">—</div>`;
    const qty = t.quantity && t.quantity > 1 ? `<span class="cr-qty">×${t.quantity}</span>` : '';
    const sub = esc(t.pn || t.model_number || '');
    return `<div class="check-row${t.owned ? ' owned' : ''}" data-tool="${t.tool_id}">
      <button class="check-box${t.owned ? ' on' : ''}" data-check="${t.tool_id}"
        aria-pressed="${t.owned ? 'true' : 'false'}"
        aria-label="${t.owned ? 'Bought' : 'Not bought yet'}: ${esc(t.name)}">${t.owned ? '✓' : ''}</button>
      <div class="cr-main">
        <div class="cr-name">${esc(t.name)} ${qty}</div>
        <div class="cr-sub">${sub}${badges.length ? ' ' + badges.join('') : ''}</div>
      </div>
      ${price}
    </div>`;
  }

  // Buy-order windows. Tier 1 first, then 2, then 3. Always shown, even empty.
  // Just the number — the order is the meaning; it doesn't need a caption.
  const TIERS = [
    { key: 'Tier 1', label: 'Tier 1' },
    { key: 'Tier 2', label: 'Tier 2' },
    { key: 'Tier 3', label: 'Tier 3' },
  ];

  // Ready-made categories so a new tool is a pick, not a typing exercise. Free
  // text still works — this is the suggestion list, not a fence.
  const CATEGORIES = [
    'General Hand Tools', 'Wrenches', 'Sockets & Drives', 'Torque Tools',
    'Cordless Power Tools', 'Pneumatics & Air Tools', 'Electrical & Diagnostics',
    'Measuring & Inspection', 'Hydraulics', 'Cooling & Fuel', 'Lube & Fluids',
    'A/C Service', 'Rigging & Lifting', 'Torch & Thermal', 'Track & Undercarriage',
    'Storage & Organization', 'Safety & Spill', 'Consumables & Hardware',
  ];

  /**
   * The money behind a set of tools: what he's recorded paying, and what the
   * rest would cost at today's best price.
   *
   * `remaining` is an estimate and says so ("≈"). It multiplies by `quantity`
   * (four of a wrench is four prices), and it counts ONLY unowned tools that
   * actually have a price — so it names how many it couldn't count rather than
   * quietly understating the number. An honest "(3 unpriced)" is worth more than
   * a total that looks precise and isn't.
   *
   * These rules are mirrored in scraper/test/purchase-math.test.js (there's no
   * build step here, so they can't be imported). Change them in both.
   */
  function money_stats(items) {
    let spent = 0, remaining = 0, unpriced = 0;
    for (const t of items) {
      if (t.owned) {
        if (t.purchase_price_cad != null) spent += Number(t.purchase_price_cad);
        continue;
      }
      if (t.best_price != null) remaining += Number(t.best_price) * (Number(t.quantity) || 1);
      else unpriced++;
    }
    return { spent, remaining, unpriced };
  }

  function moneyLine(items) {
    const { spent, remaining, unpriced } = money_stats(items);
    if (!spent && !remaining && !unpriced) return '';
    const bits = [];
    if (spent) bits.push(`spent <b>${money(spent)}</b>`);
    if (remaining) bits.push(`remaining ≈ <b>${money(remaining)}</b> at today's best`);
    if (unpriced) bits.push(`<span class="muted">(${unpriced} unpriced)</span>`);
    return `<div class="money-line">${bits.join(' · ')}</div>`;
  }

  function progressBar(owned, total, items) {
    const pct = total ? Math.round((owned / total) * 100) : 0;
    return `<div class="prog">
      <div class="prog-bar" role="progressbar" aria-valuenow="${owned}" aria-valuemin="0" aria-valuemax="${total}"
           aria-label="${owned} of ${total} tools bought"><span style="width:${pct}%"></span></div>
      <div class="prog-label">${owned} / ${total} have · ${pct}%</div>
      ${items ? moneyLine(items) : ''}</div>`;
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
      : '<div class="keybar">Add your access token in <b>Settings</b> to save checkmarks and edits.</div>';
    let html = filtersBar() + keyWarn
      + progressBar(list.filter((t) => t.owned).length, list.length, list);

    // Group into Tier windows in buy order; unknown tiers fall to the end.
    const byTier = {};
    for (const t of list) (byTier[t.tier || 'Unassigned'] ||= []).push(t);
    const order = [...TIERS.map((x) => x.key), ...Object.keys(byTier).filter((k) => !TIERS.some((x) => x.key === k))];

    // The three tier windows always render — an empty one is the prompt to fill it.
    // Extra/legacy tiers only appear when they actually hold something, and a tier
    // filter hides the others rather than leaving empty shells behind.
    const showEmptyTiers = !state.filters.tier;
    for (const tk of order) {
      const items = byTier[tk] || [];
      const meta = TIERS.find((x) => x.key === tk);
      if (!items.length && (!meta || !showEmptyTiers)) continue;
      const o = items.filter((t) => t.owned).length;
      html += `<section class="tier-window" data-tier="${esc(tk)}">
        <div class="tier-head">
          <div>
            <div class="tier-title">${esc(meta ? meta.label : tk)}</div>
            ${moneyLine(items)}
          </div>
          <div class="tier-count">${o}/${items.length}</div>
        </div>
        ${items.length ? catBlocks(items) : '<div class="note" style="padding:4px 0 6px">Nothing here yet — add a tool with the ＋ button.</div>'}
      </section>`;
    }
    view.innerHTML = html;
    wireFilters();
  }

  /**
   * Write a tick (and any purchase record) through the queue-aware write path.
   * Optimistic: the row already shows `fields`, so a failure puts it back.
   */
  async function saveOwned(t, fields, prev) {
    Object.assign(t, fields);
    render();
    try {
      // Offline, this returns {queued:true} and the ✓ stands: it's saved locally
      // and will sync. The optimistic flip IS the queued state, so the screen
      // matches what's going to happen rather than lying and snapping back.
      //
      // The payload is listed field by field on purpose: `fields` also carries
      // display-only values (purchase_dealer, which is a view join) and this is
      // what gets replayed from the queue hours later — it should contain the
      // server's truth and nothing else.
      await SB.writeApi('toggle_owned', {
        id: t.tool_id,
        owned: !!fields.owned,
        purchase_price_cad: fields.purchase_price_cad ?? null,
        purchase_listing_id: fields.purchase_listing_id ?? null,
        purchased_at: fields.purchased_at ?? null,
      });
      await syncPendingUI();
      return true;
    } catch (e) {
      Object.assign(t, prev);
      render();
      alert('Could not save: ' + e.message);
      return false;
    }
  }

  async function toggleOwned(toolId) {
    if (!SB.hasWriterToken()) {
      alert('Add your access token in the Settings tab to save checkmarks.');
      return;
    }
    const t = state.tools.find((x) => String(x.tool_id) === String(toolId));
    if (!t) return;
    const prev = {
      owned: t.owned,
      purchase_price_cad: t.purchase_price_cad ?? null,
      purchased_at: t.purchased_at ?? null,
      purchase_listing_id: t.purchase_listing_id ?? null,
      purchase_dealer: t.purchase_dealer ?? null,
    };

    if (!t.owned) {
      // Ticking ON: offer to record the buy. openPurchaseSheet resolves with the
      // fields to save — Skip resolves with just the tick, so the fast path stays
      // one tap and a tap, which is all it can be in a parts aisle.
      const rec = await openPurchaseSheet(t);
      if (rec === null) return; // dismissed — don't tick at all
      await saveOwned(t, { owned: true, ...rec }, prev);
      return;
    }

    // Ticking OFF clears the purchase — he doesn't have it, so there's nothing
    // he paid. That's real data to throw away, so it's undoable.
    const ok = await saveOwned(t, {
      owned: false, purchase_price_cad: null, purchased_at: null,
      purchase_listing_id: null, purchase_dealer: null,
    }, prev);
    if (ok && prev.purchase_price_cad != null) {
      showToast(`Cleared what you paid for ${t.name}`, 'Undo', async () => {
        await saveOwned(t, prev, { owned: false });
      });
    }
  }

  /**
   * Two fields, both pre-filled from today's best price: where he bought it and
   * what he paid. Returns the fields to save, {} for Skip, or null if dismissed.
   */
  async function openPurchaseSheet(t) {
    // The dealers he could have bought from. Fetched per tool rather than loaded
    // for the whole list — it's one small read, and only when he actually buys.
    // Offline this throws, and the BEST dealer alone is a good enough answer:
    // being unable to name a second dealer must not block the tick.
    let live = [];
    try {
      const rows = await SB.select('tool_listings',
        `select=id,dealer:dealers(name)&tool_id=eq.${t.tool_id}&active=eq.true`);
      live = (rows || []).map((l) => ({ id: l.id, dealer: l.dealer?.name || `Dealer ${l.id}` }));
    } catch {
      live = t.best_listing_id ? [{ id: t.best_listing_id, dealer: t.best_dealer || 'Best dealer' }] : [];
    }
    return new Promise((resolve) => {
      const bestId = t.best_listing_id;
      // Default to the dealer the app has been telling him is best, at the price
      // it has been showing — the overwhelmingly likely answer, so the common
      // case is Save with nothing typed.
      const opts = live.length
        ? live.map((l) => `<option value="${l.id}"${String(l.id) === String(bestId) ? ' selected' : ''}>${esc(l.dealer)}</option>`).join('')
        : `<option value="">(no dealer links)</option>`;
      const el = document.createElement('div');
      el.className = 'sheet';
      el.innerHTML = `
        <div class="sheet-card" role="dialog" aria-modal="true" aria-labelledby="buyTitle">
          <div class="sheet-title" id="buyTitle">Got it — what did you pay?</div>
          <div class="sheet-sub">${esc(t.name)}</div>
          <label class="fld"><span>Dealer</span><select id="buyDealer">${opts}</select></label>
          <label class="fld"><span>Price paid (CAD)</span>
            <input id="buyPrice" type="number" inputmode="decimal" step="0.01" min="0"
                   value="${t.best_price != null ? esc(String(t.best_price)) : ''}" placeholder="—" />
          </label>
          <div class="sheet-actions">
            <button class="btn btn-ghost" id="buySkip">Skip</button>
            <button class="btn" id="buySave">Save</button>
          </div>
        </div>`;
      document.body.appendChild(el);
      // Same rules as the detail overlay: Tab stays inside, Esc gets out, and
      // focus goes back to the ✓ he tapped.
      const opener = document.activeElement;
      const release = trapFocus(el, () => close(null));
      const close = (val) => { release(); el.remove(); opener?.focus?.(); resolve(val); };
      el.addEventListener('click', (e) => { if (e.target === el) close(null); });
      el.querySelector('#buySkip').onclick = () => close({}); // ticked, nothing recorded
      el.querySelector('#buySave').onclick = () => {
        const sel = el.querySelector('#buyDealer');
        const price = Number(el.querySelector('#buyPrice').value);
        const listingId = sel.value || null;
        close({
          purchase_price_cad: Number.isFinite(price) && price > 0 ? price : null,
          purchase_listing_id: listingId ? Number(listingId) : null,
          // Timestamped HERE, not on the server: a tick queued in a basement
          // happened when he tapped it, not when the queue drained.
          purchased_at: new Date().toISOString(),
          // Local-only: the row can name the dealer immediately instead of
          // waiting for the view's join to come back. Never sent to the writer.
          purchase_dealer: sel.selectedOptions?.[0]?.text || null,
        });
      };
      setTimeout(() => el.querySelector('#buyPrice')?.focus(), 0);
    });
  }

  // ---- copy the best-price link ----------------------------------------
  /**
   * Two taps from "this is the one" to a link in a text message. clipboard is
   * async and refused outside a secure context or without permission, so there's
   * a fallback that always works — a copy button that silently does nothing is
   * worse than no button.
   */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch { return false; }
    }
  }

  const copyBtn = (url, label = 'Copy link to the best price') =>
    url ? `<button class="icon-btn copy-btn" data-copy="${esc(url)}" aria-label="${esc(label)}" title="${esc(label)}">⧉</button>` : '';

  async function handleCopyClick(btn) {
    const ok = await copyText(btn.getAttribute('data-copy'));
    showToast(ok ? 'Link copied' : "Couldn't copy — long-press the link to copy it");
  }

  /** Transient message with one optional action. Replaces any current one. */
  function showToast(msg, actionLabel, onAction) {
    document.getElementById('appToast')?.remove();
    const t = document.createElement('div');
    t.id = 'appToast'; t.className = 'toast';
    t.innerHTML = `<span>${esc(msg)}</span>`;
    if (actionLabel) {
      const b = document.createElement('button');
      b.className = 'btn btn-sm'; b.textContent = actionLabel;
      b.onclick = () => { t.remove(); onAction?.(); };
      t.appendChild(b);
    }
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 8000); // long enough to read and reach for Undo
  }

  // ---- offline write queue --------------------------------------------
  /**
   * Reconcile the UI with the queue: overlay every not-yet-synced checkmark on
   * top of what the server said, and update the count.
   *
   * The overlay is the point. After a reload with no signal, the tool list comes
   * from the server (or the cache) and still says "not owned" — his tick is only
   * in the queue. Without this it would look like the app forgot.
   *
   * Counts tools, not taps: queue.js collapses repeat toggles of the same tool.
   */
  async function syncPendingUI() {
    const q = window.BBT_QUEUE;
    if (!q) return;
    const rows = await q.all().catch(() => []);
    for (const r of rows) {
      if (r.op !== 'toggle_owned') continue;
      const t = state.tools.find((x) => String(x.tool_id) === String(r.payload?.id));
      if (!t) continue;
      // Overlay the WHOLE queued state, not just the tick. Restoring `owned`
      // alone left an owned tool with no purchase_price_cad — which money_stats
      // counts as neither spent NOR remaining, so a purchase he recorded in a
      // basement silently vanished from the money line until the queue flushed.
      const p = r.payload || {};
      t.owned = !!p.owned;
      t.purchase_price_cad = p.purchase_price_cad ?? null;
      t.purchase_listing_id = p.purchase_listing_id ?? null;
      t.purchased_at = p.purchased_at ?? null;
      // The dealer NAME comes from a view join, so it isn't in the payload.
      // Recover it from the listing he picked when we can; otherwise the row
      // just reads "paid" until the queue syncs — missing a label is fine,
      // missing the number is not.
      t.purchase_dealer = p.purchase_listing_id != null
        && String(p.purchase_listing_id) === String(t.best_listing_id)
        ? (t.best_dealer ?? null)
        : null;
    }
    state.pending = rows.length;
    updatePendingBadge();
  }

  function updatePendingBadge() {
    const el = document.getElementById('pendingBadge');
    if (!el) return;
    const n = state.pending || 0;
    el.textContent = n ? `${n} pending` : '';
    el.classList.toggle('hidden', !n);
    el.title = state.pendingError
      ? `Couldn't sync yet: ${state.pendingError}. Your changes are saved on this device and will retry.`
      : `${n} checkmark${n === 1 ? '' : 's'} saved on this device, waiting for a connection.`;
    el.classList.toggle('err', !!state.pendingError);
  }

  /** Replay queued checkmarks. Safe to call often — it no-ops on an empty queue. */
  async function flushQueue() {
    const q = window.BBT_QUEUE;
    if (!q || !SB.hasWriterToken()) return;
    if (!(await q.count())) return;
    // send() bypasses the queue, so a failure here can't re-queue what we're
    // already replaying.
    const { done, left, error } = await q.flush((op, payload) => SB.send(op, payload));
    state.pending = left;
    state.pendingError = error && !error.offline ? error.message : null;
    updatePendingBadge();
    if (done && !left) loadAll().catch(() => {}); // resync from the server's truth
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

  // The alert: every link the last pass couldn't price, with the tool it belongs
  // to and a jump straight to it — that's the whole point, so a dead link becomes
  // a 10-second fix instead of a surprise at buy time.
  function issuesBlock() {
    const iss = state.issues || [];
    if (!iss.length) return '<div class="note" style="margin-bottom:12px">✓ Every link priced on the last run.</div>';
    return `<div class="section-title">⚠ Needs attention (${iss.length})</div>
      <div class="note" style="margin:-4px 0 8px">These links failed on the last run — the page moved, died, or blocked us. Open the tool and paste a fresh link.</div>
      ${iss.map((i) => `<div class="health-row">
        <div>
          <div><span class="status-dot bad"></span><b>${esc(i.tool || 'Unknown tool')}</b>
            <span class="tool-sub">@ ${esc(i.dealer || '')}</span>
            ${i.deactivated ? ' <span class="badge oos">link dead</span>' : ''}</div>
          <div class="tool-sub">${esc(String(i.error || '').slice(0, 80))}</div>
        </div>
        <div class="dealer-actions">
          ${i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">Open ↗</a>` : ''}
          ${i.tool_id ? `<button class="btn secondary btn-sm" data-fix-tool="${i.tool_id}">Fix</button>` : ''}
        </div>
      </div>`).join('')}`;
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
      return `<div class="health-row">
        <div>
          <div><span class="status-dot ${cls}"></span><b>${esc(d.name)}</b></div>
          <div class="tool-sub">last run ${fmtDate(d.last_run_at)} · ${d.ok_count ?? 0} ok / ${d.fail_count ?? 0} fail</div>
        </div>
        <div class="dealer-actions">
          <span class="tool-sub">${esc(label)}</span>
          <button class="link-x" data-del-dealer="${d.dealer_id}" data-name="${esc(d.name)}" title="Delete this dealer">✕</button>
        </div>
      </div>`;
    };
    view.innerHTML = '<div class="add-link" style="margin-bottom:12px"><button class="btn" id="runScrapeH">Run price scrape now</button><span id="runScrapeHMsg" class="note" style="align-self:center"></span></div>'
      + issuesBlock()
      + '<div class="section-title">Dealers — last run</div>'
      + state.health.map(row).join('');
    const rbH = document.getElementById('runScrapeH');
    if (rbH) rbH.onclick = () => triggerScrape(document.getElementById('runScrapeHMsg'));
    view.querySelectorAll('[data-del-dealer]').forEach((b) => {
      b.onclick = () => deleteDealer(b.dataset.delDealer, b.dataset.name);
    });
    view.querySelectorAll('[data-fix-tool]').forEach((b) => {
      b.onclick = () => openDetail(b.dataset.fixTool);
    });
  }

  // Delete a dealer. Dealers auto-register from pasted links, so a typo'd or junk
  // one needs a way out. The server first reports what would be lost (the delete
  // cascades to that dealer's links and their price history) — we only send
  // confirm:true after the user has seen the count.
  async function deleteDealer(id, name) {
    if (!ensureKey()) return;
    try {
      const probe = await SB.writeApi('delete_dealer', { id });
      if (!probe.deleted) {
        if (!confirm(`${probe.message}\n\nThis can't be undone.`)) return;
        const res = await SB.writeApi('delete_dealer', { id, confirm: true });
        if (!res.deleted) return;
      }
      await loadAll();
      render();
    } catch (e) {
      alert(`Could not delete "${name}": ${e.message}`);
    }
  }

  function renderImport() {
    const hasKey = SB.hasWriterToken();
    view.innerHTML = `<div class="import-box">
      <h3>Settings</h3>

      <div class="section-title">1 · Access token</div>
      <p class="note">Needed to save changes. Stored only in this browser — don't paste it on a shared device. Get it from the Supabase SQL editor:<br><code class="inline">select value from app_secrets where key = 'writer_token';</code></p>
      <input type="password" id="svcKey" placeholder="access token${hasKey ? ' (saved)' : ''}" />
      <button class="btn secondary" id="saveKey">Save token</button>
      ${hasKey ? '<button class="btn secondary" id="clearKey">Clear</button>' : ''}
      <p class="warn">${hasKey ? '✓ Access token saved on this device.' : 'No token set — saving is disabled (reads still work).'}</p>

      <div class="section-title">2 · Choose file</div>
      <input type="file" id="csvFile" accept=".csv,text/csv" ${hasKey ? '' : 'disabled'} />
      <div id="csvPreview" class="note"></div>
      <button class="btn" id="doImport" disabled>Import</button>
      <div id="importResult" class="note"></div>

      <div class="section-title">3 · Export / backup</div>
      <p class="note">Your list + latest prices. No token needed.</p>
      <button class="btn secondary" id="expCsv">Export CSV</button>
      <button class="btn secondary" id="expJson">Export JSON</button>

      <div class="section-title">4 · Refresh prices now</div>
      <p class="note">Prices refresh twice a day on their own. This runs one now — max once every 10 minutes.</p>
      <button class="btn" id="runScrape" ${hasKey ? '' : 'disabled'}>Run price scrape now</button>
      <div id="runScrapeMsg" class="note"></div>
    </div>`;

    document.getElementById('expCsv').onclick = () => exportData('csv');
    document.getElementById('expJson').onclick = () => exportData('json');
    const runBtn = document.getElementById('runScrape');
    if (runBtn) runBtn.onclick = () => triggerScrape(document.getElementById('runScrapeMsg'));

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

  // Every price shown is CAD. When the dealer quoted another currency we say so,
  // with the original amount and the rate used — a converted number should never
  // look like it came off the page as-is.
  function fxNote(s) {
    if (!s || !s.currency || s.currency === 'CAD') return '';
    const orig = s.price_original != null ? `${Number(s.price_original).toFixed(2)} ${esc(s.currency)}` : esc(s.currency);
    const rate = s.fx_rate != null ? ` @ ${Number(s.fx_rate).toFixed(4)}` : '';
    return ` · <span class="fx-note">converted from ${orig}${rate}</span>`;
  }

  // ---- how old is this price? ------------------------------------------
  // Every price on screen is a claim about what something costs right now. Most
  // are hours old and the age is noise; past a week it's the first thing worth
  // knowing, so it goes on screen.
  const ageInDays = (iso) => {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? (Date.now() - t) / 86400000 : null;
  };

  // A hand-captured price only refreshes when he sweeps it with the bookmarklet,
  // so past STALE_MANUAL_DAYS we stop letting it win BEST. tool_market_status
  // enforces the same rule server-side — this mirrors it so the detail overlay
  // and the cards can't disagree about which dealer is best.
  const isStaleManual = (s) =>
    !!s && s.parse_via === 'manual-capture' && (ageInDays(s.scraped_at) ?? 0) > STALE_MANUAL_DAYS;

  /** Quiet age chip for a price older than a week: "12 d". */
  function ageChip(iso) {
    const d = ageInDays(iso);
    if (d == null || d < PRICE_AGE_CHIP_DAYS) return '';
    return ` <span class="badge age" title="Last refreshed ${fmtDate(iso)}">${Math.round(d)} d</span>`;
  }

  /** A captured price too old to trust: say so, and offer the way to fix it. */
  function staleChip(s, productUrl) {
    if (!isStaleManual(s)) return '';
    return ` <a class="badge stale" href="${esc(productUrl || '#')}" target="_blank" rel="noopener"
      title="Captured by hand ${fmtDate(s.scraped_at)} and not refreshed since, so it can't win BEST. Open the page and run the bookmarklet to recapture.">stale — recapture ↗</a>`;
  }

  // ---- detail overlay --------------------------------------------------
  const detail = document.getElementById('detail');
  const detailBody = document.getElementById('detailBody');
  document.getElementById('detailClose').onclick = closeDetail;

  // ---- focus trap ------------------------------------------------------
  // An overlay that doesn't trap focus isn't really an overlay: Tab walks out
  // into the page behind it, where a screen reader announces the list he can't
  // see and a keyboard lands on buttons he can't reach.
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let lastFocused = null;

  const focusablesIn = (root) =>
    [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);

  /** Trap Tab inside `root` and close on Esc. Returns a teardown function. */
  function trapFocus(root, onEscape) {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onEscape(); return; }
      if (e.key !== 'Tab') return;
      const items = focusablesIn(root);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      // Wrap at both ends, and pull focus back in if it has escaped already.
      if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
        e.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }

  let releaseDetailTrap = null;
  detail.addEventListener('click', (e) => { if (e.target === detail) closeDetail(); });
  function closeDetail() {
    detail.classList.add('hidden');
    detail.setAttribute('aria-hidden', 'true');
    releaseDetailTrap?.(); releaseDetailTrap = null;
    // Put focus back where he left it — otherwise closing the overlay dumps a
    // keyboard user at the top of the document, having lost their place.
    lastFocused?.focus?.(); lastFocused = null;
  }

  /** Show the overlay: remember the opener, move focus in, trap it there. */
  function openOverlay() {
    lastFocused = document.activeElement;
    detail.classList.remove('hidden');
    detail.setAttribute('aria-hidden', 'false');
    releaseDetailTrap?.();
    releaseDetailTrap = trapFocus(detail, closeDetail);
    // Focus the panel itself first: it's the thing that was just announced, and
    // it puts Tab at the start of the overlay rather than mid-way through it.
    setTimeout(() => {
      const panel = detail.querySelector('.detail-panel');
      (focusablesIn(detail)[0] || panel)?.focus?.();
    }, 0);
  }

  async function openDetail(toolId) {
    const t = state.tools.find((x) => String(x.tool_id) === String(toolId));
    openOverlay();
    detailBody.innerHTML = '<div class="loading">Loading history…</div>';
    try {
      const listings = await SB.select('tool_listings',
        `select=id,product_url,sku,active,source,match_score,mpn,dealer_id,dealer:dealers(name)&tool_id=eq.${toolId}`);
      const ids = (listings || []).map((l) => l.id);
      let snaps = [];
      if (ids.length) {
        // Newest-first + an explicit limit, then reversed back into chronological
        // order. The Data API silently caps responses at 1000 rows, so this query
        // WILL be truncated once a tool has a long history — fetching descending
        // means what gets dropped is ancient history rather than this morning's
        // price. Everything downstream still sees oldest→newest.
        snaps = await SB.select('price_snapshots',
          `select=listing_id,price_cad,regular_price_cad,on_sale,in_stock,scraped_at,currency,price_original,fx_rate,is_anomaly,parse_via&listing_id=in.(${ids.join(',')})&order=scraped_at.desc&limit=1000`) || [];
        snaps.reverse();
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

      // Only TRACKED links belong in the chart and the dealer list. Removing a link
      // sets active=false (its history is kept) — if we rendered inactive rows here
      // the ✕ would look broken, and worse, a removed link could still win BEST.
      const live = (listings || []).filter((l) => l.active);

      // Price history belongs to the DEALER, not the URL. Dealers rotate product
      // URLs (or block the old one), and the fix is to paste the new link — so the
      // line has to carry on rather than restart. We therefore merge every listing
      // this dealer has ever had for this tool, including replaced/removed ones,
      // into one series. Dealers with no live link at all are dropped (that's a
      // dealer you stopped tracking, not a URL change), and known-bad reads are
      // left out — a flagged $135 add-on is a parser mistake, not price history.
      const liveDealerIds = new Set(live.map((l) => l.dealer_id));
      const byDealer = new Map();
      for (const l of listings || []) {
        if (!liveDealerIds.has(l.dealer_id)) continue;
        const e = byDealer.get(l.dealer_id)
          || { dealer_id: l.dealer_id, label: l.dealer?.name || `Dealer ${l.dealer_id}`, points: [] };
        for (const s of byListing[l.id] || []) {
          if (s.is_anomaly) continue;
          e.points.push({ t: s.scraped_at, price: Number(s.price_cad) });
        }
        byDealer.set(l.dealer_id, e);
      }
      // A dealer can hold two links for one tool at once — an old URL beside its
      // replacement, or two pages for the same product. Merging them raw would
      // saw-tooth between the two prices, so each scrape window collapses to that
      // dealer's CHEAPEST reading: what you'd actually pay there that day.
      const collapse = (pts) => {
        const byHour = new Map(); // scrapes are 12h apart, so an hour can't merge two runs
        for (const p of pts) {
          const k = Math.round(+new Date(p.t) / 3600000);
          const cur = byHour.get(k);
          if (!cur || p.price < cur.price) byHour.set(k, p);
        }
        return [...byHour.values()].sort((a, b) => +new Date(a.t) - +new Date(b.t));
      };
      // Colour/dash are keyed to the DEALER, so a dealer keeps its colour as links
      // are added or removed — the legend and the line always agree.
      const slots = Charts.assignSlots([...byDealer.keys()]);
      const series = [...byDealer.values()].map((e) => ({
        label: e.label,
        color: Charts.colorAt(slots.get(e.dealer_id) ?? 0),
        dash: Charts.dashAt(slots.get(e.dealer_id) ?? 0),
        points: collapse(e.points),
      }));

      const chart = Charts.lineChart(series);
      const legend = series.map((s) =>
        `<span class="k"><span class="sw" style="background:${s.color}"></span>${esc(s.label)}</span>`).join('');

      // The chart is a silent picture to a screen reader — and to anyone who
      // can't tell two dashed lines apart. Say what it shows in words: the
      // numbers a glance at it is FOR (latest, range, how many dealers).
      const allPts = series.flatMap((s) => s.points.map((p) => p.price)).filter((n) => n > 0);
      const chartSummary = allPts.length
        ? `Price history for ${esc(t?.name || 'this tool')}: ${series.length} dealer${series.length === 1 ? '' : 's'}, `
          + `${allPts.length} price${allPts.length === 1 ? '' : 's'} recorded. `
          + `Low ${money(Math.min(...allPts))}, high ${money(Math.max(...allPts))}. `
          + series.map((s) => {
            const last = s.points[s.points.length - 1];
            return last ? `${esc(s.label)} latest ${money(last.price)}` : `${esc(s.label)} no price`;
          }).join('. ') + '.'
        : 'No price history recorded yet.';

      // One row per dealer, cheapest first; the lowest in-stock price is BEST —
      // this is the single "one deal per tool" the user buys from.
      //
      // This MUST pick the same winner as tool_market_status, or the card and
      // this overlay tag different dealers BEST for the same tool. So it applies
      // the view's rule exactly: skip prices we can't stand behind (a stale hand
      // capture), then in-stock first, then cheapest.
      const rows = live.map((l) => {
        const last = (byListing[l.id] || []).slice(-1)[0];
        return { l, price: last ? Number(last.price_cad) : null, last, stale: isStaleManual(last) };
      });
      rows.sort((a, b) => (a.price == null) - (b.price == null) || (a.price ?? 0) - (b.price ?? 0));
      const eligible = rows.filter((r) => r.price != null && !r.stale);
      // in_stock null means "the page didn't say" — treated as in stock, same as
      // the view's coalesce(in_stock, true).
      const inStockFirst = [...eligible].sort((a, b) =>
        (a.last?.in_stock === false) - (b.last?.in_stock === false) || a.price - b.price);
      const bestId = inStockFirst[0]?.l.id ?? null;

      const dealerRows = rows.map(({ l, last }) => {
        const oos = last && last.in_stock === false;
        return `<div class="dealer-row${l.id === bestId ? ' best' : ''}">
          <div>
            <b>${esc(l.dealer?.name || '')}</b>${l.id === bestId ? ' <span class="best-tag">BEST</span>' : ''}${l.source === 'auto-desc' ? ' <span class="verify-tag" title="Auto-matched by description — open it to confirm it\'s the right product">≈ verify</span>' : ''}${oos ? ' <span class="badge oos">OOS</span>' : ''}
            <div class="tool-sub">${last ? money(last.price_cad) + ' · ' + fmtDate(last.scraped_at) + ageChip(last.scraped_at) + staleChip(last, l.product_url) + fxNote(last) : 'no price yet — will scrape next run'}</div>
          </div>
          <div class="dealer-actions">
            ${copyBtn(l.product_url, `Copy the ${l.dealer?.name || 'dealer'} link`)}
            <a href="${esc(l.product_url)}" target="_blank" rel="noopener">Open ↗</a>
            <button class="link-x" data-remove-listing="${l.id}" aria-label="Stop tracking this link" title="Remove this link">✕</button>
          </div>
        </div>`;
      }).join('') || '<div class="note">No dealer links yet. Paste one below — its price refreshes on the next scrape run.</div>';

      // PN harvester: if this tool has no part number but a dealer page exposed
      // one, offer to set it in one tap (re-arms the SKU auto-mapper).
      const harvested = (!t?.pn || t.pn === 'VERIFY')
        ? (rows.map((r) => r.l).find((l) => l.mpn) || null) : null;
      const pnBanner = harvested ? `
        <div class="keybar" style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <span>Found a part #: <b>${esc(harvested.mpn)}</b> <span class="muted">(${esc(harvested.dealer?.name || '')})</span></span>
          <button class="btn btn-sm" id="setPnBtn" data-tool="${toolId}" data-pn="${esc(harvested.mpn)}">Set part #</button>
        </div>` : '';

      // Manual-link form: paste one or more product URLs; the dealer is resolved
      // from each link's hostname (auto-registered if new). One writer call.
      const addForm = `
        <div class="section-title">Add dealer links</div>
        <div class="add-link">
          <textarea id="alUrls" rows="2" placeholder="Paste one or more product URLs, one per line…"></textarea>
          <button class="btn" id="alAdd" data-tool="${toolId}">Add</button>
        </div>
        <div class="note">The dealer is detected automatically from each link's website.</div>
        <div id="alCaveat" class="note warn"></div>
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
        ${pnBanner}
        <div class="stat-grid">
          <div class="stat"><div class="v">${money(t?.best_price)}</div><div class="l">best now (${esc(t?.best_dealer || '—')})</div></div>
          <div class="stat"><div class="v">${money(t?.avg_90d)}</div><div class="l">90-day avg</div></div>
          <div class="stat"><div class="v">${money(t?.all_time_low)}</div><div class="l">all-time low</div></div>
        </div>
        ${t?.target_price != null ? `<div class="note">Target: ${money(t.target_price)} ${t.at_or_below_target ? '— <span style="color:var(--green)">met ✓</span>' : ''}</div>` : ''}
        ${t?.notes ? `<div class="note" style="margin-top:8px">📝 ${esc(t.notes)}</div>` : ''}
        <div class="section-title">Price history</div>
        <div class="hist-wrap" role="img" aria-label="${chartSummary}">${chart}<div class="legend">${legend}</div></div>
        <p class="sr-only">${chartSummary}</p>
        <div class="dealer-list">${dealerRows}</div>
        ${suggestionsHTML}
        ${addForm}`;

      // Hover layer: the only honest way to separate two dealers sitting on the
      // same price — their lines are identical, so the chart has to answer on ask.
      Charts.attachHover(detailBody.querySelector('.hist-wrap svg'), series);

      const ob = document.getElementById('detailOwn');
      if (ob) ob.onclick = async () => { await toggleOwned(ob.dataset.own); openDetail(toolId); };
      const eb = document.getElementById('detailEdit');
      if (eb) eb.onclick = () => openEditForm(eb.dataset.edit);
      const pb = document.getElementById('setPnBtn');
      if (pb) pb.onclick = () => setToolPn(pb.dataset.tool, pb.dataset.pn);
      detailBody.querySelectorAll('[data-remove-listing]').forEach((btn) => {
        btn.onclick = () => removeListing(btn.dataset.removeListing, toolId);
      });
      const alAdd = document.getElementById('alAdd');
      if (alAdd) alAdd.onclick = () => addListing(toolId);
      wireCaveats('alUrls', 'alCaveat');
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
    openOverlay();
    const v = (x) => esc(x ?? '');
    // Standard categories are pre-loaded as suggestions; typing a new one still works.
    const cats = uniq([...CATEGORIES, ...state.tools.map((x) => x.category)]);
    // Priority tier is a fixed 3-way picker (new tools default to Tier 1 — buy
    // first), so a tool always lands in a real buy-order window. An existing tool
    // on some other tier value keeps it as an extra option rather than being
    // silently re-tiered on edit.
    const curTier = t ? (t.tier || '') : TIERS[0].key;
    const tierOpts = TIERS.map((x) => `<option value="${esc(x.key)}"${curTier === x.key ? ' selected' : ''}>${esc(x.label)}</option>`).join('')
      + (curTier && !TIERS.some((x) => x.key === curTier) ? `<option value="${esc(curTier)}" selected>${esc(curTier)}</option>` : '');
    detailBody.innerHTML = `
      <h2>${t ? 'Edit tool' : 'Add a tool'}</h2>
      <div class="form-grid">
        <label class="full">Name<input id="f_name" value="${v(t?.name)}" placeholder="Tool name" /></label>
        <label>Part # / SKU<input id="f_pn" value="${v(t?.pn)}" placeholder="e.g. 2864-20" /></label>
        <label>Brand<input id="f_brand" value="${v(t?.brand)}" /></label>
        <label class="full">Model / spec text<input id="f_model" value="${v(t?.model_number)}" /></label>
        <label>Category<input id="f_cat" list="dl_cat" value="${v(t?.category)}" /></label>
        <label>Priority tier<select id="f_tier">${tierOpts}</select></label>
        <label>Quantity<input id="f_qty" type="number" min="1" value="${t?.quantity ?? 1}" /></label>
        <label>Target price<input id="f_target" type="number" step="0.01" value="${t?.target_price ?? ''}" /></label>
        <label class="full">Notes<textarea id="f_notes" rows="2">${v(t?.notes)}</textarea></label>
        ${!t ? `<label class="full">Dealer links <span class="muted">(one URL per line — optional)</span><textarea id="f_links" rows="3" placeholder="https://www.kmstools.com/…&#10;https://…"></textarea></label>` : ''}
        ${!t ? '<div id="f_links_note" class="note warn" style="grid-column:1/-1"></div>' : ''}
      </div>
      <datalist id="dl_cat">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <div class="form-actions">
        <button class="btn" id="f_save">${t ? 'Save changes' : 'Create tool'}</button>
        <button class="btn secondary" id="f_cancel">Cancel</button>
        ${t ? '<button class="btn danger" id="f_delete">Delete</button>' : ''}
      </div>
      <div class="note" style="margin-top:10px">${t
        ? 'Manage dealer links from the tool\'s detail view after saving.'
        : 'Paste the dealer links you want tracked — each one\'s price refreshes on the next scrape run.'}</div>
      <div id="f_msg" class="note"></div>`;

    document.getElementById('f_cancel').onclick = () => { if (toolId) openDetail(toolId); else closeDetail(); };
    document.getElementById('f_save').onclick = () => saveToolForm(t);
    const del = document.getElementById('f_delete');
    if (del) del.onclick = () => deleteTool(t);
    wireCaveats('f_links', 'f_links_note');
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
        // Re-arm the (parked) auto-mapper when identity/part number changed, so a
        // future ENABLE_AUTO_MAP run re-maps with the new SKU (server sets state).
        const changedKey = body.pn !== (orig.pn || null)
          || body.model_number !== (orig.model_number || null)
          || body.name !== orig.name;
        await SB.writeApi('update_tool', { id: orig.tool_id, fields: body, remap: changedKey });
        await loadAll();
        openDetail(orig.tool_id);
      } else {
        // Create the tool and its pasted dealer links in one call; each link's
        // dealer is resolved/auto-registered by hostname server-side.
        const res = await SB.writeApi('add_tool_with_links', { fields: body, links: g('f_links') });
        await loadAll();
        const created = state.tools.find((x) => String(x.tool_id) === String(res.tool_id));
        if (created) openDetail(res.tool_id); else closeDetail();
        const tracked = (res.links_added || 0) + (res.links_revived || 0);
        if (tracked > 0 && confirm(`Added with ${tracked} link${tracked > 1 ? 's' : ''}. Run a price scrape now? (prices also update on the next scheduled run.)`)) {
          triggerScrape(null);
        }
      }
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
    const urlsEl = document.getElementById('alUrls');
    const msg = document.getElementById('alMsg');
    const links = (urlsEl.value || '').trim();
    if (!/https?:\/\//i.test(links)) { msg.textContent = 'Paste at least one full product URL (https://…).'; return; }
    msg.textContent = 'Adding…';
    try {
      const res = await SB.writeApi('add_tool_with_links', { tool_id: toolId, links });
      const tracked = (res.links_added || 0) + (res.links_revived || 0);
      if (tracked > 0) {
        openDetail(toolId); // refresh the dealer list; price lands on next scrape
      } else if (res.conflicts && res.conflicts.length) {
        msg.textContent = 'That link is already tracked under a different tool.';
      } else {
        msg.textContent = 'Already tracked on this tool — nothing to add.';
      }
    } catch (e) {
      msg.textContent = 'Add failed: ' + e.message;
    }
  }

  // Kick off a price scrape now (GitHub workflow_dispatch via the writer). The op
  // is rate-limited and self-explains if the GH_PAT secret isn't configured.
  async function triggerScrape(msgEl) {
    if (!ensureKey()) return;
    if (msgEl) msgEl.textContent = 'Starting…';
    try {
      const res = await SB.writeApi('trigger_scrape', {});
      const m = res.message || (res.triggered ? 'Scrape started.' : 'Not started.');
      if (msgEl) msgEl.textContent = m; else alert(m);
    } catch (e) {
      const m = 'Could not start the scrape: ' + e.message;
      if (msgEl) msgEl.textContent = m; else alert(m);
    }
  }

  // ---- browser-captured prices (bookmarklet import, §5.4) --------------
  // Mirror of the writer/scraper normalizeUrl so URL matching lines up.
  const IMPORT_TRACKING = /^(utm_.*|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|igshid|yclid|gbraid|wbraid|dclid|scid|cmpid|icid)$/i;
  function normalizeUrl(raw) {
    try {
      const u = new URL(String(raw).trim());
      u.hash = ''; u.hostname = u.hostname.toLowerCase();
      const keep = new URLSearchParams();
      for (const [k, v] of u.searchParams) if (!IMPORT_TRACKING.test(k)) keep.append(k, v);
      u.search = keep.toString();
      if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
      return u.toString();
    } catch { return String(raw || '').trim(); }
  }
  function parseNum(v) {
    if (v == null) return null;
    const s = String(v).replace(/[^\d.,]/g, ''); if (!s) return null;
    const t = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    const n = parseFloat(t); return Number.isFinite(n) ? n : null;
  }

  // Dealers CI can't refresh — shown as a note at paste/capture time (§3.3).
  const CAVEATS = [
    { re: /canadiantire\.ca/i, msg: 'Canadian Tire blocks automated refresh — capture its price with the bookmarklet instead.' },
    { re: /amazon\.ca/i, msg: 'Amazon.ca blocks automated refresh — capture its price with the bookmarklet instead.' },
    { re: /homedepot\.ca/i, msg: 'Home Depot refreshes only intermittently from the scraper.' },
  ];
  const linkCaveats = (text) => {
    const hits = CAVEATS.filter((c) => c.re.test(text || '')).map((c) => c.msg);
    return hits.length ? '⚠ ' + hits.join(' ') : '';
  };
  function wireCaveats(inputId, noteId) {
    const el = document.getElementById(inputId), note = document.getElementById(noteId);
    if (!el || !note) return;
    const upd = () => { note.textContent = linkCaveats(el.value); };
    el.addEventListener('input', upd); upd();
  }

  // Read a #import=<base64 JSON> payload (from the bookmarklet) and open the modal.
  async function handleImportHash() {
    const m = /[#&]import=([^&]+)/.exec(location.hash || '');
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search); // don't re-fire on refresh
    let payload;
    try { payload = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1]))))); }
    catch { alert('Could not read the captured price link.'); return; }
    openImport(payload);
  }

  async function openImport(payload) {
    if (!ensureKey()) return;
    const price = parseNum(payload && payload.price);
    const cur = (payload && payload.currency ? String(payload.currency).trim().toUpperCase() : '');
    const nurl = normalizeUrl((payload && payload.url) || '');
    let host = ''; try { host = new URL(nurl).hostname.replace(/^www\./, ''); } catch { /* */ }
    openOverlay();
    if (!price || !/^https?:/i.test(nurl)) {
      detailBody.innerHTML = `<h2>Import captured price</h2><div class="note">Couldn't read a valid price and URL from that capture.</div><div class="form-actions"><button class="btn secondary" id="imCancel">Close</button></div>`;
      document.getElementById('imCancel').onclick = closeDetail; return;
    }
    detailBody.innerHTML = '<h2>Import captured price</h2><div class="note">Checking…</div>';
    let match = null;
    try {
      const rows = await SB.select('tool_listings', `select=id,tool:tools(name),dealer:dealers(name)&product_url=eq.${encodeURIComponent(nurl)}`);
      match = (rows || [])[0] || null;
    } catch { /* treat as no match */ }

    const info = `<h2>Import captured price</h2>
      <div class="tool-sub">${esc(payload.title || '(no title)')}</div>
      <div class="stat-grid">
        <div class="stat"><div class="v">${money(price)}${cur && cur !== 'CAD' ? ` <span class="fx-note">${esc(cur)}</span>` : ''}</div>
          <div class="l">captured price</div></div>
        <div class="stat"><div class="v">${esc(host || '—')}</div><div class="l">dealer (from link)</div></div>
      </div>
      ${cur && cur !== 'CAD' ? `<div class="note warn">⚠ This page quotes ${esc(cur)} — it'll be converted to CAD at today's Bank of Canada rate when saved.</div>` : ''}
      <div class="note" style="word-break:break-all">${esc(nurl)}</div>`;

    if (match) {
      detailBody.innerHTML = info
        + `<div class="note">Already tracked for <b>${esc(match.tool?.name || '')}</b> at <b>${esc(match.dealer?.name || '')}</b>.</div>`
        + `<div class="form-actions"><button class="btn" id="imGo">Record ${money(price)}</button><button class="btn secondary" id="imCancel">Cancel</button></div><div id="imMsg" class="note"></div>`;
      document.getElementById('imGo').onclick = () => doImport('record_price', { listing_id: match.id, price, currency: cur || null });
    } else {
      const opts = state.tools.slice().sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => `<option value="${t.tool_id}">${esc(t.name)}</option>`).join('');
      detailBody.innerHTML = info
        + `<div class="section-title">Attach this price to a tool</div>
        <div class="form-grid">
          <label class="full">Existing tool<select id="imTool"><option value="">— pick a tool —</option>${opts}</select></label>
          <label class="full">…or create a new tool<input id="imNew" value="${esc(payload.title || '')}" placeholder="New tool name" /></label>
        </div>
        <div class="form-actions"><button class="btn" id="imGo">Add link + record price</button><button class="btn secondary" id="imCancel">Cancel</button></div>
        <div id="imMsg" class="note"></div>`;
      document.getElementById('imGo').onclick = () => {
        const tid = document.getElementById('imTool').value;
        const newName = document.getElementById('imNew').value.trim();
        const op = { product_url: nurl, price, currency: cur || null };
        if (tid) op.tool_id = tid;
        else if (newName) op.fields = { name: newName };
        else { document.getElementById('imMsg').textContent = 'Pick a tool or type a new name.'; return; }
        doImport('add_listing_with_price', op);
      };
    }
    document.getElementById('imCancel').onclick = closeDetail;
  }

  async function doImport(op, payload) {
    const msg = document.getElementById('imMsg');
    if (msg) msg.textContent = 'Saving…';
    try {
      const res = await SB.writeApi(op, payload);
      await loadAll();
      closeDetail();
      if (res.tool_id) openDetail(res.tool_id);
      const conv = res.currency && res.currency !== 'CAD'
        ? ` — converted from ${res.currency} at ${Number(res.fx_rate).toFixed(4)}, saved as ${money(res.price)} CAD`
        : '';
      alert(res.is_anomaly
        ? `Price saved${conv}. It looks off versus history, so it was flagged and excluded from stats.`
        : `Price saved${conv}.`);
    } catch (e) {
      if (msg) msg.textContent = 'Import failed: ' + e.message;
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

  // Accept a harvested part number: set pn + model_number and re-arm the mapper.
  async function setToolPn(toolId, pn) {
    if (!ensureKey()) return;
    try {
      await SB.writeApi('update_tool', { id: toolId, fields: { pn, model_number: pn }, remap: true });
      await loadAll();
      openDetail(toolId);
    } catch (e) {
      alert('Could not set part #: ' + e.message);
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

  // ---- export / backup -------------------------------------------------
  function exportData(format) {
    const rows = state.tools
      .slice()
      .sort((a, b) => (a.tier || '').localeCompare(b.tier || '') || (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name))
      .map((t) => ({
        name: t.name, brand: t.brand || '', pn: t.pn || '', category: t.category || '', tier: t.tier || '',
        quantity: t.quantity || 1, owned: t.owned ? 'yes' : 'no',
        // What he actually paid — this export is his capex record, and the
        // purchase is the part of it a price tracker can't reconstruct later.
        purchase_price_cad: t.purchase_price_cad ?? '',
        purchased_at: t.purchased_at ? String(t.purchased_at).slice(0, 10) : '',
        purchase_dealer: t.purchase_dealer || '',
        best_price: t.best_price ?? '', best_dealer: t.best_dealer || '',
        avg_90d: t.avg_90d ?? '', all_time_low: t.all_time_low ?? '',
        best_url: t.best_url || '', notes: t.notes || '',
      }));
    const stamp = new Date().toISOString().slice(0, 10);
    let blob, fname;
    if (format === 'json') {
      blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
      fname = `blackbird-tools-${stamp}.json`;
    } else {
      const cols = Object.keys(rows[0] || { name: '' });
      const cell = (v) => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
      blob = new Blob(['﻿' + csv], { type: 'text/csv' }); // BOM so Excel reads UTF-8
      fname = `blackbird-tools-${stamp}.csv`;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- routing / tabs --------------------------------------------------
  const RENDERERS = { checklist: renderChecklist, watchlist: renderWatchlist, deals: renderDeals, health: renderHealth, import: renderImport };
  function updateStaleBar() {
    const el = document.getElementById('staleBar');
    if (!el) return;
    if (state.offline) {
      const when = state.lastGoodAt ? ` as of ${fmtDate(new Date(state.lastGoodAt).toISOString())}` : '';
      el.textContent = `⚠ Offline — showing saved prices${when} · reconnect and refresh for live prices`;
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }
  function render() {
    updateStaleBar();
    renderScrapeClock();
    document.getElementById('dealsCount').textContent = state.tools.filter(isDeal).length || '';
    // Health rides on its tab, so a failed pass is visible from anywhere: a green
    // dot means every link priced, red + a count means something needs a new link.
    const n = (state.issues || []).length;
    const hc = document.getElementById('healthCount');
    if (hc) hc.textContent = n || '';
    const hd = document.getElementById('healthDot');
    if (hd) hd.classList.toggle('bad', n > 0);
    (RENDERERS[state.tab] || renderChecklist)();
    wireSparklines(); // after the view exists; also drops the old tab's observer
  }

  document.getElementById('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab'); if (!btn) return;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    state.tab = btn.dataset.tab;
    // Remember where he was. Re-opening the app on Deals and landing on
    // Checklist every time is a small thing that gets old fast.
    try { localStorage.setItem('bbt_last_tab', state.tab); } catch { /* private mode */ }
    render();
  });
  view.addEventListener('click', (e) => {
    const chk = e.target.closest('[data-check]');
    if (chk) { e.stopPropagation(); toggleOwned(chk.dataset.check); return; }
    const cp = e.target.closest('[data-copy]');
    // stopPropagation: copying is not "open this tool" — the button sits inside
    // the row, and the overlay opening over a toast would swallow the feedback.
    if (cp) { e.stopPropagation(); handleCopyClick(cp); return; }
    const row = e.target.closest('.card[data-tool], .check-row[data-tool]');
    if (row) openDetail(row.dataset.tool);
  });
  // The detail overlay has its own copy button (in the header), and its clicks
  // never reach `view`.
  detail.addEventListener('click', (e) => {
    const cp = e.target.closest('[data-copy]');
    if (cp) { e.stopPropagation(); handleCopyClick(cp); }
  });
  document.getElementById('refreshBtn').onclick = loadAll;
  document.getElementById('addToolBtn').onclick = () => openEditForm(null);

  // ---- boot ------------------------------------------------------------
  // Restore the tab he was last on. Guarded against a stale/renamed value in
  // localStorage — an unknown key would render nothing at all.
  try {
    const saved = localStorage.getItem('bbt_last_tab');
    if (saved && RENDERERS[saved]) {
      state.tab = saved;
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === saved));
    }
  } catch { /* private mode — the default tab is fine */ }

  // One-time cleanup: purge any stale service_role key left in localStorage by
  // older builds — writes now use the revocable writer token, never the admin key.
  try { localStorage.removeItem('bbt_service_key'); } catch (e) { /* ignore */ }

  function showUpdateToast() {
    if (document.getElementById('updateToast')) return;
    const t = document.createElement('div');
    t.id = 'updateToast'; t.className = 'toast';
    t.innerHTML = 'New version available <button class="btn btn-sm" id="reloadBtn">Reload</button>';
    document.body.appendChild(t);
    document.getElementById('reloadBtn').onclick = () => location.reload();
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        // A new worker finished installing while a page is already controlled →
        // fresh code is waiting; offer a one-tap reload instead of silently
        // running week-old JS.
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateToast();
          });
        });
      }).catch(() => {});
    });
  }
  // Refresh automatically when the network comes back after being offline —
  // and push up anything he ticked while it was gone, BEFORE re-reading, so the
  // server's answer includes his changes instead of overwriting them on screen.
  window.addEventListener('online', async () => {
    await flushQueue();
    if (state.offline) loadAll();
  });
  // Bookmarklet capture: handle a #import= payload on boot and on later changes.
  window.addEventListener('hashchange', handleImportHash);
  setInterval(renderScrapeClock, 60000); // the clock has to keep moving on its own
  // Flush on open too, not just on the `online` event: the event only fires if
  // the tab was OPEN when the connection returned. The common case is ticking
  // tools off in a basement, closing the app, and opening it again on the road.
  flushQueue().catch(() => {});
  loadAll().catch(() => {}).then(handleImportHash); // don't drop a capture if refresh hiccups
})();
