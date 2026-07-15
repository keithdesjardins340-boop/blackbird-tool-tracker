// Description-based matching: score how well a dealer search result's title
// matches a tool's name, for tools that have NO usable part number. Deliberately
// conservative — the brand/first word must appear, and we weight coverage of the
// tool's own terms — so we only auto-map obvious hits and leave the rest as
// review candidates. The score is 0..1.

// Generic filler that carries no discriminating signal. Sizes (numbers) are kept.
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'of', 'in', 'to', 'by',
  'set', 'kit', 'pc', 'pcs', 'piece', 'pieces', 'pack', 'each',
  'inch', 'inches', 'in', 'mm', 'cm', 'ft', 'foot', 'feet',
  'tool', 'tools', 'duty', 'heavy', 'pro', 'new', 'style', 'type',
  'backup', 'no', 'needed', 'battery',
]);

export function tokens(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/["'’.]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t) && t.length > 1);
}

// Query we actually send to the dealer search: brand + the descriptive head of
// the name (before the first comma), which is where the identifying words live.
export function descQuery(name) {
  if (!name) return '';
  const head = String(name).split(',')[0];
  return tokens(head).slice(0, 6).join(' ');
}

// Dimensioned numbers in a string: 8", 10-inch, 250mm, 3/8 in, 16 ft. These
// distinguish size variants of the same tool (an 8" vs 12" adjustable wrench),
// which term overlap alone can't — the brand+type words are identical.
export function sizeNums(s) {
  const out = new Set();
  const str = (s || '').toLowerCase();
  for (const m of str.matchAll(/(\d{1,4})\s*(?:in\b|inch|"|mm|cm|ft\b|foot|feet|')/g)) out.add(m[1]);
  return out;
}

// 0..1 similarity of a candidate title to the tool name. Requires the tool's
// leading word (almost always the brand) to be present, else the score is
// heavily penalised — this is what keeps cross-brand false positives out. A
// size mismatch (both name distinct dimensions, none shared) is also penalised
// so we don't auto-map the wrong variant.
export function scoreTitle(toolName, brand, title) {
  const nameToks = tokens(`${brand || ''} ${toolName || ''}`);
  const T = new Set(nameToks);
  const C = new Set(tokens(title));
  if (!T.size || !C.size) return 0;

  let inter = 0;
  for (const t of T) if (C.has(t)) inter++;
  const jaccard = inter / (T.size + C.size - inter);
  const coverage = inter / T.size; // share of the tool's terms the candidate has
  let s = 0.45 * jaccard + 0.55 * coverage;

  const lead = (tokens(brand)[0] || tokens(toolName)[0] || '');
  if (lead && !C.has(lead)) s *= 0.35; // brand/lead word missing → probably wrong

  // Size guard: if the tool specifies a dimension and the candidate specifies
  // dimensions too but none match, it's likely a different size → penalise.
  const ts = sizeNums(toolName), cs = sizeNums(title);
  if (ts.size && cs.size && ![...ts].some((n) => cs.has(n))) s *= 0.6;

  return Math.round(s * 1000) / 1000;
}

// Pick the best-scoring candidate for a tool.
export function bestByDescription(toolName, brand, candidates) {
  let best = null;
  for (const c of candidates) {
    const score = scoreTitle(toolName, brand, c.title || '');
    if (!best || score > best.score) best = { c, score };
  }
  return best; // {c, score} | null
}
