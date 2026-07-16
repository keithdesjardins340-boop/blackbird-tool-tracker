// Write-proxy Edge Function for the Blackbird dashboard.
//
// The browser NEVER holds the service_role key. Instead it sends a writer token
// (stored per-device in localStorage) in the `x-writer-token` header. This
// function validates that token against the service-role-only `app_secrets`
// table, then performs one of a fixed whitelist of write operations with the
// service role. Every payload is sanitized to a known set of columns — there is
// no generic SQL passthrough. verify_jwt is disabled because auth is the token.
//
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by the
// Edge runtime; the writer token lives in app_secrets (rotate it there to revoke).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-writer-token, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Constant-time string compare (avoids leaking the token via timing).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Columns the client is allowed to set on a tool. auto_map_state is controlled
// by the server (via the `remap` flag), never taken from the client.
const TOOL_COLS = ["name", "brand", "pn", "model_number", "category", "tier", "quantity", "target_price", "notes", "owned"];
const pick = (obj: Record<string, unknown>, cols: string[]) => {
  const out: Record<string, unknown> = {};
  for (const c of cols) if (obj && obj[c] !== undefined) out[c] = obj[c];
  return out;
};
const asInt = (v: unknown) => (v == null || v === "" ? null : Number.parseInt(String(v), 10));

// Mirror of scraper/src/util/url.js so pasted links dedupe the same way.
const TRACKING = /^(utm_.*|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|igshid|yclid|gbraid|wbraid|dclid|scid|cmpid|icid)$/i;
function normalizeUrl(raw: string): string {
  const s = String(raw || "").trim();
  let u: URL;
  try { u = new URL(s); } catch { return s; }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  const keep = new URLSearchParams();
  for (const [k, v] of u.searchParams) if (!TRACKING.test(k)) keep.append(k, v);
  u.search = keep.toString();
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

// Hostname → dealer (§3.2 manual-first). Known dealers keep their curated names
// (and dedicated adapters); any other host auto-registers a dealer named by its
// base domain, priced by the generic adapter. "Other" is no longer used here.
const KNOWN_HOSTS: Record<string, string> = {
  "kmstools.com": "KMS Tools",
  "homedepot.ca": "Home Depot Canada",
  "canadiantire.ca": "Canadian Tire",
  "amazon.ca": "Amazon.ca",
  "princessauto.com": "Princess Auto",
};

// Base domain from a hostname: drop a leading www. and keep the last two labels
// (good enough for the .com/.ca dealers this app tracks).
function baseHost(hostname: string): string {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  const parts = h.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : h;
}

// Resolve (or create) the dealer for a URL. `cache` dedupes within one request.
// deno-lint-ignore no-explicit-any
async function resolveDealer(admin: any, url: string, cache: Map<string, number>): Promise<number | null> {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  const base = baseHost(host);
  if (cache.has(base)) return cache.get(base)!;
  const name = KNOWN_HOSTS[base] || base;
  const { data: found } = await admin.from("dealers").select("id").eq("name", name).maybeSingle();
  let id: number;
  if (found) {
    id = found.id;
  } else {
    const { data: created, error } = await admin.from("dealers")
      .insert({ name, base_url: `https://${base}`, scraper_status: "active" })
      .select("id").single();
    if (error) throw error;
    id = created.id;
  }
  cache.set(base, id);
  return id;
}

// Parse a links payload (array or newline-separated string) into a deduped list
// of normalized http(s) URLs. Non-URL lines are dropped.
function parseLinks(input: unknown): string[] {
  const arr = Array.isArray(input) ? input : String(input ?? "").split(/\r?\n/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of arr) {
    const s = String(raw ?? "").trim();
    if (!/^https?:\/\//i.test(s)) continue;
    const url = normalizeUrl(s);
    if (!seen.has(url)) { seen.add(url); out.push(url); }
  }
  return out;
}

// Price anomaly gate — mirror of scraper/src/run.js isAnomaly(). A non-positive
// price is rejected upstream; here we flag a plausible-but-wild price (>5x/<0.2x
// the listing's recent clean median, needs ≥3 points) so a bad manual capture is
// recorded but excluded from stats, exactly like a scraped anomaly.
// deno-lint-ignore no-explicit-any
async function isAnomaly(admin: any, listingId: number, price: number): Promise<boolean> {
  if (price == null || price <= 0) return true;
  const { data } = await admin.from("price_snapshots")
    .select("price_cad").eq("listing_id", listingId).eq("is_anomaly", false)
    .order("scraped_at", { ascending: false }).limit(5);
  const prices = (data || []).map((r: { price_cad: number }) => Number(r.price_cad)).filter((n: number) => n > 0).sort((a: number, b: number) => a - b);
  if (prices.length < 3) return false;
  const median = prices[Math.floor(prices.length / 2)];
  return median > 0 && (price > median * 5 || price < median * 0.2);
}

// Currency → CAD (mirror of scraper/src/util/fx.js). Bank of Canada Valet API:
// official, free, no key, CAD-based. Fails CLOSED — a non-CAD price we cannot
// convert is REJECTED rather than written into price_cad as if it were Canadian.
const FX_SERIES: Record<string, string> = {
  USD: "FXUSDCAD", EUR: "FXEURCAD", GBP: "FXGBPCAD", AUD: "FXAUDCAD",
  JPY: "FXJPYCAD", CHF: "FXCHFCAD", MXN: "FXMXNCAD", CNY: "FXCNYCAD",
};
const fxCache = new Map<string, number>();

function normCurrency(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(s)) return s;
  if (s === "$" || s === "C$" || s === "CA$" || s === "CAD$") return "CAD";
  return null;
}

async function rateToCad(cur: string): Promise<number> {
  if (cur === "CAD") return 1;
  if (fxCache.has(cur)) return fxCache.get(cur)!;
  const series = FX_SERIES[cur];
  if (!series) throw new Error(`No CAD conversion rate is available for ${cur}.`);
  const r = await fetch(`https://www.bankofcanada.ca/valet/observations/${series}/json?recent=1`,
    { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`Couldn't reach the Bank of Canada for a ${cur}→CAD rate — price not saved.`);
  const j = await r.json();
  const rate = Number(j?.observations?.[0]?.[series]?.v);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Bad ${cur}→CAD rate — price not saved.`);
  fxCache.set(cur, rate);
  return rate;
}

/** An undeclared currency is assumed CAD (the norm for the Canadian dealers here). */
async function toCad(price: number, regular: number | null, currency: unknown) {
  const cur = normCurrency(currency) || "CAD";
  const fx_rate = await rateToCad(cur);
  const conv = (v: number | null) => (v == null ? null : Math.round(v * fx_rate * 100) / 100);
  return {
    price_cad: conv(price) as number,
    regular_cad: conv(regular),
    currency: cur,
    price_original: cur === "CAD" ? null : price,
    fx_rate,
  };
}

// Attach a URL to a tool. The unique key is (dealer_id, product_url), so a link
// lives in exactly one place: revive it if it's this tool's and was removed, and
// NEVER move it off another tool. Shared by every op that adds a link, so they
// all behave the same instead of some throwing a raw duplicate-key error.
// deno-lint-ignore no-explicit-any
async function attachListing(admin: any, toolId: number, dealerId: number, url: string, source = "manual") {
  const { data: existing } = await admin.from("tool_listings")
    .select("id,tool_id,active").eq("dealer_id", dealerId).eq("product_url", url).maybeSingle();
  if (existing) {
    if (String(existing.tool_id) !== String(toolId)) return { state: "conflict", id: existing.id };
    if (existing.active) return { state: "already", id: existing.id };
    const { error } = await admin.from("tool_listings").update({ active: true }).eq("id", existing.id);
    if (error) throw error;
    return { state: "revived", id: existing.id };
  }
  const { data: created, error } = await admin.from("tool_listings")
    .insert({ tool_id: toolId, dealer_id: dealerId, product_url: url, active: true, source })
    .select("id").single();
  if (error) throw error;
  return { state: "added", id: created.id };
}

// A revived link brings its old prices back with it — and those prices may be
// exactly why it was removed (a parser reading an add-on, a pre-fix currency bug).
// Re-judge them against what the tool's other dealers charge and flag the wild
// ones. Non-destructive: the rows stay for audit, they just stop counting toward
// best price / averages / all-time low. Same thresholds as run.js.
// deno-lint-ignore no-explicit-any
async function reflagOutliers(admin: any, listingId: number, toolId: number): Promise<number> {
  const { data: sibs } = await admin.from("tool_listings").select("id")
    .eq("tool_id", toolId).eq("active", true).neq("id", listingId);
  const ids = (sibs || []).map((s: { id: number }) => s.id);
  if (ids.length < 2) return 0; // not enough references to judge against
  const { data: snaps } = await admin.from("price_snapshots")
    .select("listing_id,price_cad,scraped_at").in("listing_id", ids).eq("is_anomaly", false)
    .order("scraped_at", { ascending: false });
  const latest = new Map<number, number>();
  for (const s of snaps || []) if (!latest.has(s.listing_id)) latest.set(s.listing_id, Number(s.price_cad));
  const prices = [...latest.values()].filter((n) => n > 0).sort((a, b) => a - b);
  if (prices.length < 2) return 0;
  const median = prices[Math.floor(prices.length / 2)];
  if (!(median > 0)) return 0;
  const { data: mine } = await admin.from("price_snapshots")
    .select("id,price_cad").eq("listing_id", listingId).eq("is_anomaly", false);
  const bad = (mine || [])
    .filter((r: { price_cad: number }) => {
      const p = Number(r.price_cad);
      return p > 0 && (p > median * 4 || p < median * 0.25);
    })
    .map((r: { id: number }) => r.id);
  if (!bad.length) return 0;
  const { error } = await admin.from("price_snapshots").update({ is_anomaly: true }).in("id", bad);
  if (error) throw error;
  return bad.length;
}

// Build the snapshot row shared by both capture ops.
function snapshotRow(listingId: number, fx: Awaited<ReturnType<typeof toCad>>, p: Record<string, unknown>) {
  const snap: Record<string, unknown> = {
    listing_id: listingId, price_cad: fx.price_cad, parse_via: "manual-capture",
    currency: fx.currency, price_original: fx.price_original, fx_rate: fx.fx_rate,
  };
  if (p.in_stock != null) snap.in_stock = !!p.in_stock;
  if (fx.regular_cad != null && fx.regular_cad > fx.price_cad) { snap.regular_price_cad = fx.regular_cad; snap.on_sale = true; }
  return snap;
}

// deno-lint-ignore no-explicit-any
async function handle(admin: any, op: string, p: Record<string, any>) {
  const req = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

  switch (op) {
    case "toggle_owned": {
      req(asInt(p.id), "id required");
      const { error } = await admin.from("tools").update({ owned: !!p.owned, updated_at: new Date().toISOString() }).eq("id", asInt(p.id));
      if (error) throw error; return { id: asInt(p.id), owned: !!p.owned };
    }
    case "update_tool": {
      req(asInt(p.id), "id required");
      const fields = pick(p.fields || {}, TOOL_COLS);
      req(Object.keys(fields).length, "no valid fields");
      fields.updated_at = new Date().toISOString();
      if (p.remap) fields.auto_map_state = null; // re-arm the auto-mapper
      const { error } = await admin.from("tools").update(fields).eq("id", asInt(p.id));
      if (error) throw error; return { id: asInt(p.id) };
    }
    case "delete_tool": {
      req(asInt(p.id), "id required");
      const { error } = await admin.from("tools").delete().eq("id", asInt(p.id));
      if (error) throw error; return { id: asInt(p.id) };
    }
    case "remove_listing": {
      req(asInt(p.id), "id required");
      const { error } = await admin.from("tool_listings").update({ active: false }).eq("id", asInt(p.id));
      if (error) throw error; return { id: asInt(p.id) };
    }
    case "accept_candidate": {
      req(asInt(p.tool_id) && asInt(p.dealer_id), "tool_id + dealer_id required");
      req(typeof p.product_url === "string" && /^https?:\/\//i.test(p.product_url), "valid product_url required");
      const toolId = asInt(p.tool_id) as number;
      const r = await attachListing(admin, toolId, asInt(p.dealer_id) as number, normalizeUrl(p.product_url));
      req(r.state !== "conflict", "That link is already tracked under a different tool.");
      if (r.state === "revived") await reflagOutliers(admin, r.id, toolId);
      if (asInt(p.cand_id)) await admin.from("map_candidates").update({ confident: true }).eq("id", asInt(p.cand_id));
      return { ok: true, state: r.state };
    }
    case "add_tool_with_links": {
      // Quick-add (§3.1): create a tool (fields.name) OR attach to an existing
      // one (tool_id), plus a manual listing per pasted link — each link's dealer
      // resolved/auto-registered by hostname (§3.2). One round-trip.
      let toolId = asInt(p.tool_id);
      if (!toolId) {
        const fields = pick(p.fields || {}, TOOL_COLS);
        req(fields.name, "name required");
        const { data, error } = await admin.from("tools").insert(fields).select("id").single();
        if (error) throw error;
        toolId = data.id;
      }
      const urls = parseLinks(p.links);
      const cache = new Map<string, number>();
      let links_added = 0;    // brand new
      let links_revived = 0;  // previously removed, tracked again
      let already = 0;        // already tracked on this tool — no-op
      const conflicts: string[] = []; // the URL belongs to a DIFFERENT tool

      let reflagged = 0;
      for (const url of urls) {
        const dealerId = await resolveDealer(admin, url, cache);
        if (!dealerId) continue;
        const r = await attachListing(admin, toolId as number, dealerId, url);
        if (r.state === "conflict") { conflicts.push(url); continue; }
        if (r.state === "already") { already++; continue; }
        if (r.state === "revived") {
          links_revived++;
          reflagged += await reflagOutliers(admin, r.id, toolId as number);
          continue;
        }
        links_added++;
      }
      return { tool_id: toolId, links_added, links_revived, already, conflicts, reflagged };
    }
    case "trigger_scrape": {
      // Kick the scrape workflow via GitHub's workflow_dispatch (§3.4). The PAT
      // lives ONLY in the GH_PAT function secret — never returned, logged, or sent
      // to the browser. Rate-limited to once / 10 min via app_secrets.
      const pat = Deno.env.get("GH_PAT");
      if (!pat) {
        return { configured: false, triggered: false, message: "Refresh isn't set up yet. Add a GitHub fine-grained PAT as the GH_PAT function secret in Supabase to enable it." };
      }
      const now = Date.now();
      const { data: last } = await admin.from("app_secrets").select("value").eq("key", "last_scrape_trigger").maybeSingle();
      if (last?.value) {
        const prev = Date.parse(last.value);
        const mins = (now - prev) / 60000;
        if (Number.isFinite(prev) && mins < 10) {
          return { configured: true, triggered: false, message: `A scrape was started ${Math.ceil(mins)} min ago — try again in about ${Math.max(1, Math.ceil(10 - mins))} min.` };
        }
      }
      const repo = Deno.env.get("GH_REPO") || "keithdesjardins340-boop/blackbird-tool-tracker";
      const ref = Deno.env.get("GH_REF") || "main";
      const resp = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/scrape.yml/dispatches`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${pat}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "blackbird-tool-tracker",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref }),
      });
      if (resp.status !== 204) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`GitHub dispatch failed (${resp.status}). Check the PAT scope/repo. ${txt.slice(0, 160)}`);
      }
      await admin.from("app_secrets").upsert(
        { key: "last_scrape_trigger", value: new Date(now).toISOString(), updated_at: new Date(now).toISOString() },
        { onConflict: "key" });
      return { configured: true, triggered: true, message: "Scrape started — fresh prices in a few minutes." };
    }
    case "record_price": {
      // Browser-captured snapshot for an EXISTING listing (§5.4 bookmarklet).
      req(asInt(p.listing_id), "listing_id required");
      const price = Number(p.price);
      req(Number.isFinite(price) && price > 0, "a valid positive price is required");
      const { data: listing } = await admin.from("tool_listings").select("id").eq("id", asInt(p.listing_id)).maybeSingle();
      req(listing, "listing not found");
      await admin.from("tool_listings").update({ active: true }).eq("id", listing.id); // a manual capture proves the link is live
      const rp = Number(p.regular_price);
      const fx = await toCad(price, Number.isFinite(rp) ? rp : null, p.currency);
      const anomaly = await isAnomaly(admin, listing.id, fx.price_cad);
      const { error } = await admin.from("price_snapshots")
        .insert({ ...snapshotRow(listing.id, fx, p), is_anomaly: anomaly });
      if (error) throw error;
      return { listing_id: listing.id, price: fx.price_cad, is_anomaly: anomaly, currency: fx.currency, fx_rate: fx.fx_rate };
    }
    case "add_listing_with_price": {
      // Create/attach a manual listing for a URL AND record its first price, in one
      // step (§5.4). tool_id attaches to an existing tool; else fields.name makes a
      // new one. Dealer is resolved/auto-registered by hostname.
      req(typeof p.product_url === "string" && /^https?:\/\//i.test(p.product_url), "valid product_url required");
      const price = Number(p.price);
      req(Number.isFinite(price) && price > 0, "a valid positive price is required");
      const url = normalizeUrl(p.product_url);
      const dealerId = await resolveDealer(admin, url, new Map<string, number>());
      req(dealerId, "could not resolve a dealer for that URL");
      // If this URL is already a listing, record onto IT (revive if dead) — never
      // reassign it to another tool or create a duplicate tool. Otherwise create.
      let listingId: number, toolId: number;
      const { data: existing } = await admin.from("tool_listings")
        .select("id,tool_id").eq("dealer_id", dealerId).eq("product_url", url).maybeSingle();
      if (existing) {
        listingId = existing.id; toolId = existing.tool_id;
        await admin.from("tool_listings").update({ active: true }).eq("id", listingId);
      } else {
        toolId = asInt(p.tool_id);
        if (!toolId) {
          const fields = pick(p.fields || {}, TOOL_COLS);
          req(fields.name, "tool_id or fields.name required");
          const { data, error } = await admin.from("tools").insert(fields).select("id").single();
          if (error) throw error;
          toolId = data.id;
        }
        const { data: created, error: lErr } = await admin.from("tool_listings")
          .insert({ tool_id: toolId, dealer_id: dealerId, product_url: url, active: true, source: "manual" })
          .select("id").single();
        if (lErr) throw lErr;
        listingId = created.id;
      }
      const rp = Number(p.regular_price);
      const fx = await toCad(price, Number.isFinite(rp) ? rp : null, p.currency);
      const anomaly = await isAnomaly(admin, listingId, fx.price_cad);
      const { error: sErr } = await admin.from("price_snapshots")
        .insert({ ...snapshotRow(listingId, fx, p), is_anomaly: anomaly });
      if (sErr) throw sErr;
      return { tool_id: toolId, listing_id: listingId, price: fx.price_cad, is_anomaly: anomaly, currency: fx.currency, fx_rate: fx.fx_rate };
    }
    case "delete_dealer": {
      // Dealers auto-register from pasted hostnames, so the owner needs a way to
      // remove a wrong/junk one. tool_listings.dealer_id is ON DELETE CASCADE, so
      // this also drops that dealer's links AND their price history — never do it
      // silently: report the blast radius first and require an explicit confirm.
      req(asInt(p.id), "id required");
      const id = asInt(p.id) as number;
      const { data: dealer } = await admin.from("dealers").select("id,name").eq("id", id).maybeSingle();
      req(dealer, "dealer not found");
      const { count: listings } = await admin.from("tool_listings")
        .select("*", { count: "exact", head: true }).eq("dealer_id", id);
      const n = listings ?? 0;
      if (!p.confirm) {
        return {
          deleted: false, needs_confirm: true, dealer: dealer.name, listings: n,
          message: n
            ? `Deleting "${dealer.name}" also removes ${n} link${n === 1 ? "" : "s"} and their price history.`
            : `Delete "${dealer.name}"? It has no links.`,
        };
      }
      const { error } = await admin.from("dealers").delete().eq("id", id);
      if (error) throw error;
      return { deleted: true, dealer: dealer.name, listings_removed: n };
    }
    case "import_tools": {
      const rows: Record<string, unknown>[] = Array.isArray(p.rows) ? p.rows : [];
      req(rows.length, "rows required");
      const { data: existing } = await admin.from("tools").select("id,name");
      const byName = new Map((existing || []).map((t: { id: number; name: string }) => [(t.name || "").toLowerCase(), t.id]));
      let inserted = 0, updated = 0, skipped = 0;
      const toInsert: Record<string, unknown>[] = [];
      for (const raw of rows) {
        const f = pick(raw, TOOL_COLS);
        if (!f.name) { skipped++; continue; }
        const id = byName.get(String(f.name).toLowerCase());
        if (id) { await admin.from("tools").update({ ...f, updated_at: new Date().toISOString() }).eq("id", id); updated++; }
        else toInsert.push(f);
      }
      if (toInsert.length) { const { error } = await admin.from("tools").insert(toInsert); if (error) throw error; inserted = toInsert.length; }
      return { inserted, updated, skipped };
    }
    default:
      throw new Error(`unknown op: ${op}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Authorize: the writer token must match app_secrets.writer_token.
  const token = req.headers.get("x-writer-token") || "";
  if (!token) return json({ error: "unauthorized" }, 401);
  const { data: secret, error: sErr } = await admin.from("app_secrets").select("value").eq("key", "writer_token").single();
  if (sErr || !secret || !safeEqual(token, secret.value)) return json({ error: "unauthorized" }, 401);

  let body: { op?: string; payload?: Record<string, unknown> };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  if (!body?.op) return json({ error: "op required" }, 400);

  try {
    const result = await handle(admin, body.op, body.payload || {});
    return json({ ok: true, result });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
