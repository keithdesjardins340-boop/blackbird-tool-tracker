# Blackbird Tool Price Tracker

Track Canadian heavy-duty tool prices across dealers over time and spot deals
from a dashboard. Static frontend (GitHub Pages) + Supabase backend + GitHub
Actions scheduled scrapers. Same pattern as the other Blackbird apps.

```
blackbird-tool-tracker/
├─ supabase/           SQL migrations (schema, views, RLS)
├─ scraper/            Node.js — dealer adapters + batch price runner, CSV import (auto-map parked)
├─ web/                Vanilla PWA dashboard (no build step; served by serve.ps1)
└─ .github/workflows/  Cron scrapers + GitHub Pages deploy
```

## How it fits together (manual-first)

1. **`tools`** = your own curated list. Add a tool in the dashboard's quick-add
   (**＋**) and paste the dealer links you want tracked — the dealer for each link is
   detected from its hostname (auto-registered if it's a new site). Links become
   **`tool_listings`**. There is **no automated discovery**; the scraper only refreshes
   links you gave it.
2. **Scrapers** run twice daily in GitHub Actions (or on demand via the dashboard's
   **Run price scrape now** button), visit each active listing, and write a
   **`price_snapshot`** (price, sale, stock). Failures are logged to **`scrape_runs`**,
   never crash the batch.
3. For dealers CI can't reach (Canadian Tire, Amazon), the **bookmarklet** captures a
   price from your own browser (see below).
4. **Dashboard** reads Supabase views (`tool_market_status`, `dealer_health`) and shows
   the checklist, deals, per-tool history, and scraper health.

## Supabase

- Project: **blackbird-tool-tracker** (`ssfhjhbarkpgbelnbcun`, region ca-central-1)
- URL: `https://ssfhjhbarkpgbelnbcun.supabase.co`
- Dashboard uses the **publishable (anon) key** — read-only via RLS.
- Scrapers use the **service_role key** — set as a GitHub Actions secret, never
  committed. Get it from Supabase → Project Settings → API.
- **Dashboard writes** (checkmarks, edits, links, CSV import) go through the
  **`writer` Edge Function** (`supabase/functions/writer`, `verify_jwt=false`),
  authorized by a **writer token** stored in the service-role-only `app_secrets`
  table (migration 0007). The browser holds only that token (per-device, in
  localStorage) — never the service_role key. **Get the token** (to paste into
  the dashboard Settings tab): run `select value from app_secrets where key =
  'writer_token';` in the Supabase SQL editor. **Rotate/revoke**: `update
  app_secrets set value = encode(gen_random_bytes(24),'hex') where key =
  'writer_token';` then re-paste the new value on each device.

## Capture a price with the bookmarklet

Canadian Tire and Amazon.ca (and sometimes Home Depot) block the scraper, so their
prices can't be refreshed automatically. The **bookmarklet** lets you grab a price
straight from your own browser: open the product page, click the bookmarklet, and
the dashboard opens with the captured title/price/URL ready to save — either onto
an existing tracked link, or as a new link on a tool you pick.

Make a new bookmark and paste this as its **URL** (it's plain JS — no install, no
build). If your dashboard isn't at the address below, change that one URL inside it:

```
javascript:(function(){function P(){for(const s of document.querySelectorAll('script[type="application/ld+json"]')){try{const d=JSON.parse(s.textContent);const a=Array.isArray(d)?d:(d['@graph']||[d]);for(const o of a){const t=o&&o['@type'];if(t==='Product'||(Array.isArray(t)&&t.includes('Product'))){let f=o.offers;if(Array.isArray(f))f=f[0];const p=f&&(f.price||f.lowPrice||f.highPrice);if(p)return{title:o.name,price:p}}}}catch(e){}}const m=document.querySelector('meta[property="product:price:amount"],meta[property="og:price:amount"],meta[itemprop="price"]');if(m)return{title:(document.querySelector('meta[property="og:title"]')||{}).content||document.title,price:m.content};return null}var d=P();if(!d||!d.price){alert('No price found on this page.');return}var q={title:d.title||document.title,price:String(d.price),url:location.href};var b=btoa(unescape(encodeURIComponent(JSON.stringify(q))));window.open('https://keithdesjardins340-boop.github.io/blackbird-tool-tracker/#import='+b,'_blank')})();
```

It reads the price from the page's structured data (JSON-LD, then meta tags), so it
works on most retail product pages. The dashboard validates everything server-side
(same anomaly gate as the scraper) and needs your access token to save.

## "Run price scrape now" button (optional)

The dashboard's **Run price scrape now** button (Settings → section 4, and the
Health tab) kicks off a scrape immediately instead of waiting for the twice-daily
cron. It's rate-limited to once every 10 minutes. It only works once you give the
writer function a GitHub token to start the workflow — until then the button
explains that it isn't set up.

One-time setup (nothing sensitive touches the browser or the repo):

1. Create a **fine-grained personal access token** on GitHub (Settings →
   Developer settings → Fine-grained tokens): scope it to **only this repo**, with
   **Actions: Read and write** permission. Copy the token.
2. In the Supabase dashboard → Edge Functions → **writer** → Secrets, add a secret
   named **`GH_PAT`** with the token as its value. (Optional overrides: `GH_REPO`
   defaults to `keithdesjardins340-boop/blackbird-tool-tracker`, `GH_REF` to `main`.)

The PAT lives only in the function's secrets — it's never returned by any
operation, stored in the browser, or committed. To revoke, delete the token on
GitHub or remove the `GH_PAT` secret.

## Resetting to a clean tool list (owner-run)

The app is moving to a **manual-first** model: you curate your own tool list and
paste the dealer links; the scrapers only refresh prices on links you gave them.
To start that list from scratch, do this yourself in the Supabase SQL editor —
**Claude never runs the reset.**

1. **Back up first.** Dashboard → Settings → **Export CSV** *and* **Export JSON**
   (tools, owned flags, and prices). Save the files off-repo (Drive/local). The
   repo is public, so don't commit them unless you mean to.
2. **Wipe**, in the Supabase SQL editor (same place the writer token lives):
   ```sql
   truncate table price_snapshots, map_candidates, tool_listings, tools
     restart identity cascade;
   ```
   `dealers`, `scrape_runs`, `app_secrets`, all views, and all functions are left
   untouched.
3. **Verify:** the dashboard shows an empty checklist, and the next scrape run
   reports 0 listings and 0 failures.

Then rebuild the list from the app's quick-add (tool + pasted links). Note: the
Deals tab's "all-time low" reads are noisy for the first couple of weeks after a
wipe while price history rebuilds, then settle.

## Local dev on this machine (no Node.js)

- **Dashboard**: `web/serve.ps1` serves it on http://localhost:8125 — no build.
- **Scraper**: runs in GitHub Actions (needs Node + Playwright). To run it on a
  machine with Node: `cd scraper && npm install && node src/run.js`.

## Status

Live and deployed: the Supabase schema + views, the `writer` Edge Function, the
GitHub Pages dashboard, and the twice-daily scraper (GitHub Actions secrets
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`). Day-to-day use is: add tools and paste
links in the dashboard, and let the scraper — or the **Run price scrape now** button —
keep prices fresh. See `scraper/README.md` for the scraper internals.
