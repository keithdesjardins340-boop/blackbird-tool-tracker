# Blackbird Tool Tracker — Project Brief

A context handoff for an AI assistant. Copy-paste this whole thing.

## What we're building

A **price tracker + buy-checklist** for a heavy-duty mechanic's tool list (~295 tools
for outfitting a Ford F-250/F-550 service truck). Goals, in order:

1. **Track the price of every tool across every Canadian dealer that sells it**, so I can
   see the single best deal per tool and buy at the right time.
2. **A checklist** to tick off tools as I buy them, grouped by buy-priority tiers.
3. **Automate finding each tool at each dealer** — by part number when one exists, and by
   product description when it doesn't (most of the list has no clean SKU).
4. Let me **paste dealer links myself** and **edit/add/remove tools** in the app, with the
   scraper adjusting automatically.

## Hard environment constraints

- **No Node.js / npm on my local machine.** Cannot run build tools, dev servers, or the
  scrapers locally. So:
  - The **dashboard is a vanilla offline-first PWA** (plain HTML/CSS/JS, service worker,
    no framework, no bundler). It's served locally by a small PowerShell static server for
    previewing and deployed as a static site.
  - The **scrapers run only in GitHub Actions** (Node 22), on a cron + manual dispatch.
- Windows 11 machine, PowerShell primary shell.

## Stack & infrastructure

- **Database/backend: Supabase** (Postgres + PostgREST + RLS).
  - Project ref: `ssfhjhbarkpgbelnbcun`, region ca-central-1.
  - RLS: anon key = read-only. Writes use the `service_role` key, which is **never committed** —
    it's pasted into (a) GitHub Actions secrets for the scraper, and (b) the dashboard's
    Settings tab (localStorage, per-device) to enable checkmarks / editing / adding links.
- **Repo (public):** `github.com/keithdesjardins340-boop/blackbird-tool-tracker`
- **Dashboard (live):** GitHub Pages, deployed via Actions on push to `main`.
- **Scrapers:** `.github/workflows/scrape.yml` — cron 08:00 & 20:00 America/Winnipeg, plus
  manual `workflow_dispatch` with inputs `dealer` (optional single dealer) and `map_limit`.

### Repo layout
```
/supabase/migrations   SQL migrations (0001…0006)
/scraper               Node scrapers (run only in CI)
  src/run.js           batch runner: scrape every active listing → price_snapshot
  src/auto-map.js      finds & creates listings (SKU path + description path)
  src/sku.js           extract part numbers from text
  src/match.js         description-similarity scoring
  src/adapters/        one per dealer + a generic fallback
/web                   the PWA dashboard (index.html, js/app.js, css/styles.css, sw.js)
```

### Database (key tables & views)
- `tools` — the master list. Columns incl. `name, brand, pn, model_number, category, tier,
  quantity, target_price, notes, owned, auto_map_state`.
- `dealers` — Princess Auto, KMS Tools, Home Depot Canada, Canadian Tire, Amazon.ca, and
  **Other** (catch-all for pasted links). `scraper_status` = active/beta/broken/paused.
- `tool_listings` — a tool↔dealer product URL. Columns incl. `product_url, sku, active,
  source ('auto-sku'|'auto-desc'|'manual'), match_score`.
- `price_snapshots` — time series of scraped prices per listing.
- `map_candidates` — suggested (unconfirmed) matches for review.
- `scrape_runs` — per-run health log.
- Views: `listing_latest_price`, `listing_price_stats`, `dealer_health`, and
  **`tool_market_status`** (the dashboard's main read — computes the single best/cheapest
  in-stock listing per tool + deal flags + `best_source`).

## Current data status

- **295 tools total**, but only **73 have a real part number**; the other ~222 are generic /
  "VERIFY" (no exact product to price) — these are the reason we added description matching.
- **owned = 0** (I don't own any of them yet; I'll check them off as I buy).
- Tiers: Tier 1 (buy first), Tier 2 (next), Tier 3 (phase-2 F-550).

## How the automated mapping works

`auto-map.js` processes unmapped tools (`auto_map_state IS NULL`), capped per run, two paths:

1. **SKU path (high confidence):** extract the part number, search the dealer, accept a
   result only if the SKU appears in it.
2. **Description path (fuzzy, for tools with no SKU):** `match.js` scores each search-result
   title vs. the tool name — term coverage + a **brand/lead-word gate** (missing brand → heavy
   penalty) + a **size-variant guard** (8" vs 12" → penalty). Thresholds: **≥0.62 auto-maps**
   (tagged `source='auto-desc'`, badged "≈ verify" in the app); **0.42–0.62** saved as
   `map_candidates` for one-tap review in the app; below → ignored.

`run.js` then scrapes every active listing and writes price snapshots. It uses a
**generic fallback adapter** (JSON-LD → price meta → price-in-markup) for any dealer without
a dedicated adapter, so a link pasted from *any* server-rendered site can be priced.

## Dealer scraping status (honest)

- **KMS Tools — works well.** Product pages are server-rendered (JSON-LD price). Search uses an
  open SearchSpring JSON API, so it's the **only dealer that supports auto-mapping** (both SKU
  and description). Primary coverage.
- **Home Depot Canada — works for pricing.** Product pages have embedded price JSON on a plain
  fetch. Its search is Akamai-blocked, so HD listings are seeded by hand/paste, not auto-mapped.
  Only stocks ~40 of the list (Milwaukee/Fluke/Stanley subset).
- **Canadian Tire, Amazon.ca — bot-protected**, not reliably scrapable yet.
- **Princess Auto — skip** (price not in HTML; mostly its own Powerfist brand).

## Dashboard features (all live)

Tabs: **Checklist** (default, tools grouped into tier windows with ✓ have-it toggles + progress),
**Prices** (cards), **Deals** (≥X% below 90-day avg or all-time low), **Health** (scraper status),
**Settings** (paste service key, CSV import). Per-tool detail overlay shows price history chart,
all dealer prices sorted cheapest-first with a **BEST** tag, an **Add a dealer link** form, a
**Suggested matches** section (accept a fuzzy find with one tap), and **Edit** (name/pn/brand/
category/tier/qty/notes; editing the pn/name re-arms the auto-mapper). A **＋** button adds new tools.

Design: clean black-and-white **light** theme (white surfaces, near-black ink, hairline grays,
grayscale charts).

## What's still open / where help is wanted

- **Broaden description matching beyond KMS** — it only runs against KMS today (the one dealer
  with an open search API). Want more dealers searchable by description.
- **Crack Canadian Tire / Amazon** pricing (bot protection) — or decide a paid scraping API
  (Zyte/ScraperAPI) is worth it.
- **Fill real part numbers** for the highest-value "VERIFY" tools so they become SKU-trackable.
- General ideas to make "every dealer, every tool" coverage more complete and accurate.
