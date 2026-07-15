# Blackbird Tool Price Tracker

Track Canadian heavy-duty tool prices across dealers over time and spot deals
from a dashboard. Static frontend (GitHub Pages) + Supabase backend + GitHub
Actions scheduled scrapers. Same pattern as the other Blackbird apps.

```
blackbird-tool-tracker/
├─ supabase/           SQL migrations (schema, views, RLS)
├─ scraper/            Node.js — dealer adapters, batch runner, link finder, CSV import
├─ web/                Vanilla PWA dashboard (no build step; served by serve.ps1)
└─ .github/workflows/  Cron scrapers + GitHub Pages deploy
```

## How it fits together

1. **`tools`** = your ~193-item list (from the spreadsheet).
2. **Link finder** searches each dealer for a tool's model number and proposes
   product URLs. You approve → they become **`tool_listings`** (the mapping).
3. **Scrapers** run twice daily in GitHub Actions, visit each active listing,
   and write a **`price_snapshot`** (price, sale, stock). Failures are logged to
   **`scrape_runs`**, never crash the batch.
4. **Dashboard** reads Supabase views (`tool_market_status`, `dealer_health`)
   and shows the watchlist, deals, per-tool history, and scraper health.

## Supabase

- Project: **blackbird-tool-tracker** (`ssfhjhbarkpgbelnbcun`, region ca-central-1)
- URL: `https://ssfhjhbarkpgbelnbcun.supabase.co`
- Dashboard uses the **publishable (anon) key** — read-only via RLS.
- Scrapers use the **service_role key** — set as a GitHub Actions secret, never
  committed. Get it from Supabase → Project Settings → API.

## Local dev on this machine (no Node.js)

- **Dashboard**: `web/serve.ps1` serves it on http://localhost:8125 — no build.
- **Scraper**: runs in GitHub Actions (needs Node + Playwright). To run it on a
  machine with Node: `cd scraper && npm install && node src/run.js`.

## Setup checklist

- [x] Supabase project + schema
- [x] Princess Auto adapter (Phase 1)
- [ ] Import tool list CSV (`scraper/src/import-csv.js` or via Supabase)
- [ ] Run link finder to build `tool_listings`
- [ ] Add GitHub repo + secrets (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`)
- [ ] Enable GitHub Pages (deploy workflow) → set dashboard config
- [ ] Phase 1: KMS Tools, Home Depot Canada
- [ ] Phase 2: Canadian Tire, Amazon.ca (best-effort)

See `scraper/README.md` and `web/README.md` for details.
