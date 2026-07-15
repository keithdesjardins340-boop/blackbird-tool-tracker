// Pull likely dealer part numbers out of the messy "model_number" free-text (or
// the clean v2 "pn" column) and normalize them for matching. The confidence gate
// downstream (SKU must appear in the search result) filters any over-extraction,
// so we err toward recall.

export const normSku = (s) => (s == null ? '' : String(s).toLowerCase().replace(/[^a-z0-9]/g, ''));

export function extractSkus(model) {
  if (!model) return [];
  const out = [];
  const push = (t) => { t = (t || '').trim(); if (t && !out.includes(t)) out.push(t); };

  const raw = String(model).trim();

  // Whole field is a single clean SKU token — comes from the dedicated `pn`
  // column (e.g. "9031", "WSR1", "RG6", "420", "410RED", "2850MAX-6", "XXL-F").
  // Short, no spaces, must contain a digit so we don't grab plain words.
  if (/^[A-Za-z0-9][A-Za-z0-9./+-]{1,15}$/.test(raw) && /\d/.test(raw)) push(raw);

  // Princess Auto product codes: PA0009296625
  for (const m of model.matchAll(/\bPA\d{6,}\b/gi)) push(m[0].toUpperCase());

  // Spaced digit groups (Knipex "87 01 250") — push both the spaced form and the
  // joined "8701250"; normSku collapses spaces anyway, but dealers vary.
  for (const m of model.matchAll(/\b\d{2,3}(?:\s+\d{2,3}){1,3}\b/g)) {
    push(m[0].replace(/\s+/g, ' '));
    push(m[0].replace(/\s+/g, ''));
  }

  // Dashed part numbers: 2967-20, 48-22-9486, 48-11-1880
  for (const m of model.matchAll(/\b\d{2,4}-\d{2,4}(?:-\d{2,5})?\b/g)) push(m[0]);

  // Alphanumeric model codes carrying both a letter and a digit: MDX-650P,
  // C4D600F36H, MDV-787, 2850MAX-6.
  for (const m of model.matchAll(/\b[A-Za-z0-9]*[A-Za-z][A-Za-z0-9-]*\d[A-Za-z0-9-]*\b/g)) {
    if (/[A-Za-z]/.test(m[0]) && /\d/.test(m[0]) && m[0].length >= 3) push(m[0]);
  }

  // Pure numeric codes, 4+ digits: 9031, 1142, 75240, 280045
  for (const m of model.matchAll(/\b\d{4,}\b/g)) push(m[0]);

  return out.slice(0, 5); // most-specific patterns first
}
