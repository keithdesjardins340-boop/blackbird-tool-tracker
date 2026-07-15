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
const LISTING_SOURCES = new Set(["manual", "auto-desc", "auto-sku"]);

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
    case "insert_tool": {
      const fields = pick(p.fields || {}, TOOL_COLS);
      req(fields.name, "name required");
      const { data, error } = await admin.from("tools").insert(fields).select("id").single();
      if (error) throw error; return { id: data.id };
    }
    case "delete_tool": {
      req(asInt(p.id), "id required");
      const { error } = await admin.from("tools").delete().eq("id", asInt(p.id));
      if (error) throw error; return { id: asInt(p.id) };
    }
    case "insert_listing": {
      req(asInt(p.tool_id) && asInt(p.dealer_id), "tool_id + dealer_id required");
      req(typeof p.product_url === "string" && /^https?:\/\//i.test(p.product_url), "valid product_url required");
      const source = LISTING_SOURCES.has(p.source) ? p.source : "manual";
      const { error } = await admin.from("tool_listings").insert({
        tool_id: asInt(p.tool_id), dealer_id: asInt(p.dealer_id), product_url: p.product_url, active: true, source,
      });
      if (error) throw error; return { ok: true };
    }
    case "remove_listing": {
      req(asInt(p.id), "id required");
      const { error } = await admin.from("tool_listings").update({ active: false }).eq("id", asInt(p.id));
      if (error) throw error; return { id: asInt(p.id) };
    }
    case "accept_candidate": {
      req(asInt(p.tool_id) && asInt(p.dealer_id), "tool_id + dealer_id required");
      req(typeof p.product_url === "string" && /^https?:\/\//i.test(p.product_url), "valid product_url required");
      const { error } = await admin.from("tool_listings").insert({
        tool_id: asInt(p.tool_id), dealer_id: asInt(p.dealer_id), product_url: p.product_url, active: true, source: "manual",
      });
      if (error) throw error;
      if (asInt(p.cand_id)) await admin.from("map_candidates").update({ confident: true }).eq("id", asInt(p.cand_id));
      return { ok: true };
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
