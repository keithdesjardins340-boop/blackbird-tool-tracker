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
      const color = COLORS[i % COLORS.length];
      const dash = DASHES[i % DASHES.length];
      const ps = s.points.filter((p) => p.price != null).sort((a, b) => +new Date(a.t) - +new Date(b.t));
      if (!ps.length) return '';
      const d = ps.map((p, j) => `${j === 0 ? 'M' : 'L'}${X(p.t).toFixed(1)},${Y(p.price).toFixed(1)}`).join(' ');
      const dots = ps.map((p) => `<circle cx="${X(p.t).toFixed(1)}" cy="${Y(p.price).toFixed(1)}" r="2" fill="${color}"/>`).join('');
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>${dots}`;
    }).join('');

    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">${grid}${paths}</svg>`;
  }

  const colorFor = (i) => COLORS[i % COLORS.length];
  window.Charts = { sparkline, lineChart, colorFor };
})();
