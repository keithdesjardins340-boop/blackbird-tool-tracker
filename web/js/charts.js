// Dependency-free SVG charts: sparkline (watchlist) + multi-series line chart
// (tool detail). All inline SVG so it works offline with no libraries.
(function () {
  // Categorical palette for dealer series, assigned in FIXED order (never cycled
  // by rank) so a dealer keeps its colour as series come and go. Validated against
  // the #ffffff chart surface: worst adjacent CVD ΔE 24.2 (target >=12). Two slots
  // (aqua/yellow) fall under 3:1 contrast, so the dash patterns + the legend below
  // the chart are REQUIRED secondary encoding — never remove them.
  const COLORS = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948'];
  const DASHES = ['', '5,3', '2,3', '8,3', '2,2', '6,2,2,2'];

  // Colour follows the ENTITY (the dealer), never its position in the list —
  // otherwise removing one dealer repaints all the others and last week's chart
  // no longer means what this week's does. The slot is derived from the dealer's
  // id, so a dealer keeps its colour for good. On the rare collision (two ids
  // landing on the same slot) the next free slot is taken: uniqueness inside one
  // chart has to win, because two identically-drawn lines are unreadable.
  const colorAt = (slot) => COLORS[((slot % COLORS.length) + COLORS.length) % COLORS.length];
  const dashAt = (slot) => DASHES[((slot % DASHES.length) + DASHES.length) % DASHES.length];
  function assignSlots(keys) {
    const used = new Set();
    const out = new Map();
    for (const k of [...new Set(keys)].sort((a, b) => Number(a) - Number(b))) {
      const n = Number(k);
      let s = Number.isFinite(n) ? Math.abs(Math.trunc(n)) % COLORS.length : 0;
      for (let i = 0; used.has(s) && i < COLORS.length; i++) s = (s + 1) % COLORS.length;
      used.add(s); out.set(k, s);
    }
    return out;
  }

  function sparkline(values, { w = 96, h = 28, stroke = '#09090b' } = {}) {
    const pts = values.filter((v) => v != null);
    if (pts.length === 0) return `<svg class="spark" width="${w}" height="${h}"></svg>`;
    if (pts.length === 1) {
      const cy = h / 2;
      return `<svg class="spark" width="${w}" height="${h}"><circle cx="${w - 3}" cy="${cy}" r="2.5" fill="${stroke}"/></svg>`;
    }
    const min = Math.min(...pts), max = Math.max(...pts);
    const range = max - min || 1;
    const step = w / (pts.length - 1);
    const y = (v) => h - 3 - ((v - min) / range) * (h - 6);
    const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const last = pts[pts.length - 1];
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${(w).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.2" fill="${stroke}"/>
    </svg>`;
  }

  // series: [{ label, points: [{ t: Date|ms, price }] }]
  function lineChart(series, { w = 620, h = 240 } = {}) {
    const pad = { l: 46, r: 12, t: 12, b: 26 };
    const all = series.flatMap((s) => s.points).filter((p) => p.price != null);
    if (!all.length) return '<div class="empty">No price history yet.</div>';
    const times = all.map((p) => +new Date(p.t));
    const prices = all.map((p) => p.price);
    let minT = Math.min(...times), maxT = Math.max(...times);
    let minP = Math.min(...prices), maxP = Math.max(...prices);
    if (minT === maxT) { minT -= 86400000; maxT += 86400000; }
    const padP = (maxP - minP) * 0.1 || Math.max(1, maxP * 0.05);
    minP -= padP; maxP += padP;
    const X = (t) => pad.l + ((+new Date(t) - minT) / (maxT - minT)) * (w - pad.l - pad.r);
    const Y = (p) => pad.t + (1 - (p - minP) / (maxP - minP)) * (h - pad.t - pad.b);

    const yTicks = 4, xTicks = 4;
    let grid = '';
    for (let i = 0; i <= yTicks; i++) {
      const p = minP + (i / yTicks) * (maxP - minP);
      const y = Y(p);
      grid += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w - pad.r}" y2="${y.toFixed(1)}" stroke="#e4e4e7" stroke-width="1"/>
        <text x="${pad.l - 6}" y="${(y + 3).toFixed(1)}" fill="#71717a" font-size="10" text-anchor="end">$${p.toFixed(0)}</text>`;
    }
    for (let i = 0; i <= xTicks; i++) {
      const t = minT + (i / xTicks) * (maxT - minT);
      const x = X(t);
      const d = new Date(t);
      const lbl = `${d.getMonth() + 1}/${d.getDate()}`;
      grid += `<text x="${x.toFixed(1)}" y="${h - 8}" fill="#71717a" font-size="10" text-anchor="middle">${lbl}</text>`;
    }

    const paths = series.map((s, i) => {
      // s.color/s.dash come from the entity slot when the caller supplies one;
      // the index is only a fallback for callers with no stable key.
      const color = s.color || colorAt(i);
      const dash = s.dash != null ? s.dash : dashAt(i);
      const ps = s.points.filter((p) => p.price != null).sort((a, b) => +new Date(a.t) - +new Date(b.t));
      if (!ps.length) return '';
      const d = ps.map((p, j) => `${j === 0 ? 'M' : 'L'}${X(p.t).toFixed(1)},${Y(p.price).toFixed(1)}`).join(' ');
      const dots = ps.map((p) => `<circle cx="${X(p.t).toFixed(1)}" cy="${Y(p.price).toFixed(1)}" r="2" fill="${color}"/>`).join('');
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>${dots}`;
    }).join('');

    // Scales ride along on the element so the hover layer can invert them without
    // the caller having to know anything about the geometry.
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"
      data-min-t="${minT}" data-max-t="${maxT}" data-min-p="${minP}" data-max-p="${maxP}"
      data-pad="${pad.l},${pad.r},${pad.t},${pad.b}" data-w="${w}" data-h="${h}"
      >${grid}${paths}<g class="cross"></g></svg>`;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Two dealers charging the same price draw the SAME line — one simply hides the
  // other, and no amount of colour fixes that. Offsetting a line to "separate" them
  // would misreport the price, so instead the chart answers on hover: a crosshair
  // plus a tooltip naming every dealer at that date. That also makes the chart
  // interactive, which a line chart should be anyway.
  function attachHover(svg, series) {
    if (!svg || !svg.dataset || !svg.dataset.w) return;
    const minT = +svg.dataset.minT, maxT = +svg.dataset.maxT;
    const minP = +svg.dataset.minP, maxP = +svg.dataset.maxP;
    const [pl, pr, pt, pb] = svg.dataset.pad.split(',').map(Number);
    const w = +svg.dataset.w, h = +svg.dataset.h;
    const X = (t) => pl + ((+new Date(t) - minT) / (maxT - minT || 1)) * (w - pl - pr);
    const Y = (p) => pt + (1 - (p - minP) / (maxP - minP || 1)) * (h - pt - pb);
    const g = svg.querySelector('.cross');
    const wrap = svg.parentElement;
    if (!g || !wrap) return;
    let tip = wrap.querySelector('.chart-tip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip hidden'; wrap.appendChild(tip); }

    const prepared = series
      .map((s) => ({
        label: s.label, color: s.color || '#09090b',
        pts: (s.points || []).filter((p) => p.price != null).sort((a, b) => +new Date(a.t) - +new Date(b.t)),
      }))
      .filter((s) => s.pts.length);
    if (!prepared.length) return;

    function move(e) {
      const r = svg.getBoundingClientRect();
      const px = ((e.touches ? e.touches[0].clientX : e.clientX) - r.left) * (w / (r.width || w));
      const x = Math.min(w - pr, Math.max(pl, px));
      const t = minT + ((x - pl) / (w - pl - pr || 1)) * (maxT - minT);
      // Nearest real reading per dealer — every dealer is listed, so identical
      // prices show up as two named rows instead of one ambiguous line.
      const hits = prepared.map((s) => {
        let best = s.pts[0];
        for (const p of s.pts) {
          if (Math.abs(+new Date(p.t) - t) < Math.abs(+new Date(best.t) - t)) best = p;
        }
        return { label: s.label, color: s.color, p: best };
      }).sort((a, b) => a.p.price - b.p.price);

      g.innerHTML = `<line x1="${x.toFixed(1)}" y1="${pt}" x2="${x.toFixed(1)}" y2="${h - pb}"
          stroke="var(--line-2)" stroke-width="1"/>`
        + hits.map((hh) => `<circle cx="${X(hh.p.t).toFixed(1)}" cy="${Y(hh.p.price).toFixed(1)}" r="4"
            fill="${hh.color}" stroke="#fff" stroke-width="1.5"/>`).join('');

      tip.innerHTML = `<div class="tip-date">${new Date(hits[0].p.t).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}</div>`
        + hits.map((hh) => `<div class="tip-row"><span class="tip-sw" style="background:${hh.color}"></span>`
          + `<span class="tip-name">${esc(hh.label)}</span><b>$${Number(hh.p.price).toFixed(2)}</b></div>`).join('');
      tip.classList.remove('hidden');
      const left = Math.min(Math.max(0, (x / w) * (r.width || w) - tip.offsetWidth / 2), (r.width || w) - tip.offsetWidth);
      tip.style.left = `${Math.max(0, left)}px`;
    }
    function leave() { g.innerHTML = ''; tip.classList.add('hidden'); }

    svg.addEventListener('mousemove', move);
    svg.addEventListener('touchstart', move, { passive: true });
    svg.addEventListener('touchmove', move, { passive: true });
    svg.addEventListener('mouseleave', leave);
    svg.addEventListener('touchend', leave);
  }

  const colorFor = (i) => colorAt(i); // legacy: index-based, kept for old callers
  window.Charts = { sparkline, lineChart, colorFor, assignSlots, colorAt, dashAt, attachHover };
})();
