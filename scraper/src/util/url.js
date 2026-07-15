// Canonicalize a product URL so that tracking-param / fragment / trailing-slash
// variants of the same page dedupe to a single tool_listing. Deliberately
// conservative: it lowercases the host, drops the fragment, strips only
// well-known tracking query params, and removes a trailing slash. It does NOT
// touch the scheme, `www.`, or path case, so the result stays fetchable.

const TRACKING = /^(utm_.*|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|igshid|yclid|gbraid|wbraid|dclid|scid|cmpid|icid)$/i;

export function normalizeUrl(raw) {
  if (!raw) return raw;
  const s = String(raw).trim();
  let u;
  try { u = new URL(s); } catch { return s; } // leave unparseable strings as-is
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  const keep = new URLSearchParams();
  for (const [k, v] of u.searchParams) if (!TRACKING.test(k)) keep.append(k, v);
  u.search = keep.toString();
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}
