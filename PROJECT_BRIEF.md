# Blackbird Tool Tracker — Project Brief (current state)

A context handoff for an AI assistant. Copy-paste the whole thing. Reflects the
**manual-first** model adopted after an earlier automated-coverage build-out was
rolled back — this supersedes any brief describing dealer discovery / catalogs.

## What it is / goal

A **price tracker + buy-checklist** for a heavy-duty mechanic's tool list
(outfitting a Ford F-250/F-550 service truck). The owner **curates the tool list
and pastes the dealer links himself**; the system's only automated job is
**refreshing prices on the links it was given**. Best price per tool, price
history, and a tiered buy-order checklist to tick tools off as they're bought.
There is **no automated dealer discovery** — that's a deliberate choice (signal
over coverage).

## Hard environment constraints (do not violate)

- **No Node.js/npm on the owner's machine.** The dashboard is a **vanilla
  offline-first PWA** (plain HTML/CSS/JS, no framework/bundler/build step); the
  **scrapers run only in GitHub Actions** (Node 22). Anything local is plain
  PowerShell or the existing static server (`web/serve.ps1`).
- **No secrets in the repo, ever** (incl. migrations/workflows). The GitHub PAT and
  writer token live only in Supabase secrets / the owner's browser.
- **Migrations are append-only + numbered** (currently through **0014**; next is
  **0015**).
- **Scrape politely** — 2 runs/day, per-dealer pacing, honest UA. No anti-bot
  evasion; the escalation path for blocked dealers is a paid proxy or the human
  bookmarklet, never stealth.
- **Never break the manual paste path** (a pasted URL must always price via the
  generic adapter). Keep the **light black-and-white theme** (no colour creep).
- **Never seed `owned`** (owner checks tools off as bought). **Never auto-create
  tools the owner didn't add** (CSV import excepted).

## Stack & infrastructure

- **Backend: Supabase** (Postgres + PostgREST + RLS). Project ref
  `ssfhjhbarkpgbelnbcun`, ca-central-1. URL `https://ssfhjhbarkpgbelnbcun.supabase.co`.
- **Repo (public):** `github.com/keithdesjardins340-boop/blackbird-tool-tracker`.
- **Dashboard:** GitHub Pages, auto-deploys on push to `main` (deploy-web.yml).
- **Scrapers:** `.github/workflows/scrape.yml` — cron 13:00 & 01:00 UTC (08:00/20:00
  Winnipeg, ±1h DST) + manual `workflow_dispatch`. Ends with a **Run report** step
  (Markdown → `$GITHUB_STEP_SUMMARY`).

### Repo layout
```
/supabase/migrations   0001–0014 (schema, views, RLS, columns; 0012/0013 added the
                       dealer-coverage schema, 0014 reverted it)
/supabase/functions/writer   Edge Function write-proxy (see Security)
/scraper/src
  run.js         THE product: scrape active listings → price_snapshot (anomaly gate, link-rot)
  report.js      run summary for the Actions UI (incl. "unpriced links")
  auto-map.js    PARKED discovery (SKU + description) — runs only if ENABLE_AUTO_MAP='true'
  match.js/sku.js  matcher used by the parked auto-map
  util/url.js    normalizeUrl (dedup)
  adapters/      kms-tools, home-depot, generic-manual, princess-auto, canadian-tire, amazon
/web             the PWA dashboard (index.html, js/app.js, js/supabase.js, css/styles.css, sw.js)
/docs/IMPROVEMENT_PLAN.md   older roadmap (P1 coverage section is superseded/parked)
```

### Database (key tables/views)
- `tools` — the list: `name, brand, pn, model_number, category, tier, quantity,
  target_price, notes, owned, auto_map_state`.
- `dealers` — the five modelled dealers (Princess Auto, KMS Tools, Home Depot Canada,
  Canadian Tire, Amazon.ca) + **Other** (legacy) + any **auto-registered** dealers
  named by hostname when a link from a new site is pasted. `scraper_status`.
- `tool_listings` — tool↔dealer URL: `product_url, sku, active, source
  (mostly 'manual'; 'auto-sku'/'auto-desc' only if auto-map is un-parked), match_score, mpn`.
- `price_snapshots` — time series: `price_cad, regular_price_cad, on_sale, in_stock,
  currency, is_anomaly, parse_via, scraped_at`. `parse_via='manual-capture'` for
  bookmarklet prices.
- `map_candidates` — parked (only populated by auto-map).
- `app_secrets` — **service-role-only** key/value table: the dashboard's
  `writer_token`, and `last_scrape_trigger` (rate-limit stamp).
- Views: `listing_latest_price`, `listing_price_stats` (both exclude `is_anomaly`),
  `dealer_health`, and **`tool_market_status`** (dashboard's main read — best/cheapest
  in-stock listing per tool + deal flags).

## Security model

The browser **never holds the service_role key**. Reads use the public anon
(publishable) key (RLS = read-only). **Writes** go through the **`writer` Edge
Function** (`verify_jwt=false`; auth is a token): the dashboard sends a per-device
**writer token** (localStorage `bbt_writer_token`) in the `x-writer-token` header;
the function validates it (constant-time) against `app_secrets.writer_token`, then
runs a **fixed op whitelist** with payloads sanitized to known columns — no generic
SQL. Ops: `toggle_owned, update_tool, insert_tool, delete_tool, insert_listing,
remove_listing, accept_candidate, add_tool_with_links, trigger_scrape, record_price,
add_listing_with_price, import_tools`.
- **Get the token:** `select value from app_secrets where key='writer_token';` in the
  Supabase SQL editor → paste into the dashboard **Settings** tab.
- **Rotate/revoke:** `update app_secrets set value=encode(gen_random_bytes(24),'hex')
  where key='writer_token';` then re-paste on each device.
- The Actions scraper uses the real service_role key (a GitHub secret, server-side).
- `trigger_scrape` uses a separate **`GH_PAT`** Supabase **function secret** (a
  fine-grained GitHub PAT, this repo only, Actions r/w) — never returned or in the
  browser/repo. Absent → the button self-explains and does nothing.

## The core loop (manual-first)

1. **Quick-add** (the ＋ button): a tool + a multi-line list of dealer links, saved in
   one call (`add_tool_with_links`). Each link's dealer is **resolved by hostname**
   server-side — known hosts map to the modelled dealers, anything else auto-registers
   a dealer named by its domain, priced by the generic adapter.
2. **`run.js`** (twice-daily cron, or the **Run price scrape now** button →
   `trigger_scrape`) refreshes the price of every active listing → `price_snapshot`.
   Anomaly gate flags junk prices out of stats; 404/410 deactivates dead links;
   `parse_via` records how each price was read. The report's **"unpriced links"**
   section surfaces any dead/blocked link immediately.
3. **Generic adapter** (JSON-LD → price meta → price-in-markup) prices a pasted link
   from any server-rendered site — no dealer-specific code needed.
4. **Bookmarklet capture** for dealers CI can't refresh (see below): grabs a price
   from the owner's own browser and saves it via `record_price` /
   `add_listing_with_price` (same anomaly gate, server-side).

**Auto-map is parked**, not deleted: `auto-map.js` + `match.js`/`sku.js`/
`map_candidates` stay in-tree, but the scrape workflow's auto-map step only runs when
the repo variable `ENABLE_AUTO_MAP == 'true'` (unset by default). Setting it, plus the
older coverage plan, is how discovery would come back.

## Dealer status (honest)

- **KMS Tools, and most server-rendered independents** — refresh reliably from CI.
- **Home Depot Canada** — product pages price via embedded JSON, but reliability is
  degrading: from GitHub's datacenter IP the Akamai block rate is high and variable
  (a fast-fail cap keeps failures cheap but can't make them succeed).
- **Canadian Tire, Amazon.ca** — bot-protected, **not refreshable from CI**. Price
  them with the **bookmarklet** (or, if the owner opts in, a paid proxy/Keepa).
- **Princess Auto** — skip (price not in HTML; own-brand).

## Bookmarklet capture (the CT/Amazon answer)

A plain-JS bookmarklet (documented in the README, no build) reads a product page's
JSON-LD/meta price and opens the dashboard at `…/#import=<base64>`. The dashboard
previews it and writes via the writer's `record_price` (existing listing) or
`add_listing_with_price` (new listing + first snapshot). Paste-time notes in the app
flag CT/Amazon ("use the bookmarklet") and HD ("refreshes intermittently").

## Dashboard features (all live)

Tabs: **Checklist** (tier windows + ✓ toggles + progress; **works fully offline** from
a localStorage cache with a stale-data bar), **Prices**, **Deals**, **Health**,
**Settings** (writer token, CSV import, **CSV/JSON export**, **Run price scrape now**).
Per-tool detail: price-history chart, all dealer prices sorted cheapest-first with a
**BEST** tag, **Add dealer links** (multi-line paste). **＋** opens **quick-add**
(tool + links). Bookmarklet **#import=** opens a save-price modal. Clean B&W light
theme; grayscale charts. A service-worker **update toast** appears after a deploy.

## Data / reset

`owned = 0` (never seed). The tool list is **owner-curated**; a documented one-time
**reset** (`truncate price_snapshots, map_candidates, tool_listings, tools restart
identity cascade` in the Supabase SQL editor, after Export CSV+JSON) lets the owner
start a clean list — **an AI must never run the reset**. After a wipe the Deals tab's
"all-time low" is noisy for a couple of weeks while history rebuilds.

## Status / open items

- **Manual-first pivot: complete and deployed.** Quick-add, hostname dealers,
  bookmarklet capture, the scrape button, parked auto-map, and the "unpriced links"
  report are all live.
- **Owner actions:** re-paste a current writer token if the saved one is stale;
  run the wipe when ready; optionally add `GH_PAT` (enables the scrape button) and/or
  set `ENABLE_AUTO_MAP=true` (un-parks discovery).
- **Leftover UX polish (unaffected):** overlay focus-trap/Esc, aria, persist tab,
  copy-best-price-link, offline write-queue for checkmarks, lazy sparklines, a smarter
  deal rule, a `node:test` harness.
- **Coverage is parked, owner-gated:** reliable HD/CT/Amazon would need a paid proxy
  (Zyte) or Keepa (Amazon). Not pursued under manual-first unless the owner asks.

## Notes for whoever continues

- The scraper can't run locally (no Node) — validate scraper changes with a CI run and
  read the run report / `dealer_health`. No `gh` CLI locally.
- Scrapes can be kicked from the dashboard's **Run price scrape now** button (needs
  `GH_PAT`) or the Actions UI (Run workflow).
- Deal detection needs price history to be meaningful; it self-corrects over a few runs.
