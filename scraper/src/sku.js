// Pull likely dealer part numbers out of the messy "model_number" free-text and
// normalize them for matching. The confidence gate downstream (SKU must appear
// in the search result) filters any over-extraction, so we err toward recall.

export const normSku = (s) => (s == null ? '' : String(s).toLowerCase().replace(/[^a-z0-9]/g, ''));

export function extractSkus(model) {
  if (!model) return [];
  const out = [];
  const push = (t) => { t = (t || '').trim(); if (t && !out.includes(t)) out.push(t); };

  // Princess Auto product codes: PA0009296625
  for (const m of model.matchAll(/\bPA\d{6,}\b/gi)) push(m[0].toUpperCase());
  // Dashed part numbers: 2967-20, 48-22-9486, 48-11-1880
  for (const m of model.matchAll(/\b\d{2,4}-\d{2,4}(?:-\d{2,5})?\b/g)) push(m[0]);
  // Alphanumeric model codes with both a letter and a digit: MDX-650P, C4D600F36H, MDV-787
  for (const m of model.matchAll(/\b[A-Za-z]{1,5}-?\d[A-Za-z0-9-]{2,}\b/g)) {
    if (/[A-Za-z]/.test(m[0]) && /\d/.test(m[0])) push(m[0]);
  }
  // Pure numeric codes, 5+ digits: 75240, 31095, 280045
  for (const m of model.matchAll(/\b\d{5,}\b/g)) push(m[0]);

  return out.slice(0, 4); // most-specific patterns first
}
