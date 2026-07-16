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
javascript:(function(){function P(){for(const s of document.querySelectorAll('script[type="application/ld+json"]')){try{const d=JSON.parse(s.textContent);const a=Array.isArray(d)?d:(d['@graph']||[d]);for(const o of a){const t=o&&o['@type'];if(t==='Product'||(Array.isArray(t)&&t.includes('Product'))){let f=o.offers;if(Array.isArray(f))f=f[0];const p=f&&(f.price||f.lowPrice||f.highPrice);if(p)return{title:o.name,price:p,currency:f.priceCurrency||''}}}}catch(e){}}const m=document.querySelector('meta[property="product:price:amount"],meta[property="og:price:amount"],meta[itemprop="price"]');if(m){const c=document.querySelector('meta[property="product:price:currency"],meta[property="og:price:currency"],meta[itemprop="priceCurrency"]');return{title:(document.querySelector('meta[property="og:title"]')||{}).content||document.title,price:m.content,currency:(c&&c.content)||''}}return null}var d=P();if(!d||!d.price){alert('No price found on this page.');return}var q={title:d.title||document.title,price:String(d.price),currency:d.currency||'',url:location.href};var b=btoa(unescape(encodeURIComponent(JSON.stringify(q))));window.open('https://keithdesjardins340-boop.github.io/blackbird-tool-tracker/#import='+b,'_blank')})();
```

It reads the price from the page's structured data (JSON-LD, then meta tags), so it
works on most retail product pages. It also grabs the page's **currency** — a US
price is converted to CAD at the Bank of Canada's rate when you save, rather than
being recorded as if it were Canadian. The dashboard validates everything
server-side (same anomaly gate as the scraper) and needs your access token to save.

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

## Resetting to a clean tool list

The app is **manual-first**: you curate your own tool list and paste the dealer
links; the scrapers only refresh prices on links you gave them. To start that list
from scratch:

**An assistant may run this reset on request** — but only after taking and
**verifying a full backup** (that precondition is not optional; it's what makes the
wipe recoverable). Note that a platform safety guard may still refuse an automated
mass-delete regardless of this document; if it does, run the SQL yourself in the
Supabase SQL editor.

1. **Back up first.** Dashboard → Settings → **Export CSV** *and* **Export JSON**
   (tools, owned flags, and prices) — or dump every table to JSON. Save it off-repo
   (Drive/local); the repo is public, so don't commit it unless you mean to.
   Verify the row counts match the database before wiping.
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

## Deal alerts on your phone (optional, free — currently OFF)

> **Not in use.** Keith checks the app weekly and doesn't want notifications, so
> `NTFY_TOPIC` is deliberately unset and the alert step does nothing. The code is
> kept in-tree and inert in case that changes. Freshness is answered in-app instead:
> the age chip on any price over a week old, the scrape clock, and the Health dot.
> Everything below is what it would take to turn it on.

The tracker's job is *buy at the right time*, and that signal is no use sitting in
a tab. After each scrape it can push a notification when a tool you still need
hits **at or under your target price**, or drops **10% or more below its 90-day
average** — plus one if the scrape itself fails (a silently broken scraper leaves
the app showing stale prices with confidence).

It uses [ntfy.sh](https://ntfy.sh): free, no account. The **topic** is both the
address and the only secret — anyone who knows it can read your alerts — so treat
it like a password. It is never printed in the logs.

**To turn it on:**

1. Pick a topic nobody could guess, e.g. `bbt-` plus ~24 random hex characters.
2. GitHub → repo **Settings → Secrets and variables → Actions → New repository
   secret**, named `NTFY_TOPIC`, with that value.
3. Install the ntfy app (iOS/Android) or open `https://ntfy.sh/<your-topic>` in a
   browser, and **subscribe to the same topic**.

Until the secret exists the alert step does nothing at all, so the scrape is
unaffected either way. Alerts are deduplicated: the same tool is only re-announced
if its price drops a further ≥2%, or 14 days pass — an alert you learn to swipe
away is worse than no alert.

## Deal discovery (optional, free — currently OFF)

Once a week, this can search Google Shopping for the tools already on your list and
drop **candidate cheaper listings** into a review inbox on the Deals tab. It never
attaches anything and never records a price: a lead's price is shown as `~$X
unverified`, because it came off a search result and hasn't been through the scraper
or the CAD conversion. Press **Add link**, paste the real dealer URL, and it becomes a
tracked listing like any other — same path as a link you paste yourself.

**To turn it on:**

1. Free [SerpApi](https://serpapi.com) account → copy the API key.
2. Repo → Settings → Secrets and variables → Actions → **New repository secret**
   `SERPAPI_KEY`. **Don't send it to anyone** — it goes browser-to-browser.
3. Same screen → **Variables** tab → `ENABLE_DISCOVERY` = `true`.
4. Actions → Deal discovery → **Run workflow** → tick **dry_run** for the first go.
   That searches without saving anything and prints what it found, so you can see
   whether the results are worth having before it writes a single row.

**The budget, because past a point this costs money.** SerpApi's free tier is ~250
searches/month and this spends **one search per tool per run**. So it runs weekly, 40
tools per run — about **172 searches/month, inside the free tier** — and works through
the list least-recently-searched first. A 295-tool list therefore takes ~7 weeks to
sweep once. Raising `DISCOVERY_MAX_TOOLS` or the cron frequency past ~250/month means
a paid plan; that's a decision with a price on it.

**What to watch on the first real run.** If the only merchants it finds are Amazon and
fluke.com — dealers you already track, which get filtered out — then Shopping isn't
reaching your niche industrial dealers and this feature isn't earning its keep. Turn
`ENABLE_DISCOVERY` back off. If a new merchant with a genuinely lower price shows up,
it's working.

## Backups

The **Weekly backup** workflow runs every Monday and dumps the whole database
(`tools`, `tool_listings`, `price_snapshots`, `map_candidates`, `dealers`) to JSON,
uploaded as a GitHub Actions **artifact** with 90-day retention. It never lands in
the repo — this repo is public and the dump is your entire list. The writer token
(`app_secrets`) is deliberately **not** in the dump. You can also run it any time:
Actions → Weekly backup → Run workflow.

**To restore:** download the artifact from the run (Actions → Weekly backup → the
run → Artifacts), then in the Supabase SQL editor insert the rows back in this
order — `dealers`, `tools`, `tool_listings`, `price_snapshots` — because each
depends on the one before it. The JSON keeps the original `id`s, so the simplest
path is to load each array into a temp table and `insert … select`, then re-run
`select setval(pg_get_serial_sequence('tools','id'), (select max(id) from tools))`
(and the same for the other three) so new rows don't collide with restored ids.
The same file shape is used by `backups/blackbird-FULL-BACKUP-pre-wipe.json`, so
this works for that one too.

## Local dev on this machine (no Node.js)

- **Dashboard**: `web/serve.ps1` serves it on http://localhost:8125 — no build.
- **Scraper**: runs in GitHub Actions (needs Node + Playwright). To run it on a
  machine with Node: `cd scraper && npm install && node src/run.js`.
- **Tests**: `test.yml` runs them on every push and PR, and reports the counts on
  the run page. With Node: `cd scraper && npm test` (the DB layer needs a Postgres
  and a `DATABASE_URL` — see the workflow).

## The one deploy-time trick: the service-worker cache name

`web/sw.js` has to use a different `CACHE` name on every deploy — otherwise
browsers keep serving the old app and a deploy looks like it never landed. That
used to be a rule someone had to remember; now `deploy-web.yml` rewrites this line
with the commit SHA just before publishing:

```js
const CACHE = 'bbt-shell-dev'; // DEPLOY_STAMP
```

So: **don't bump it by hand, and don't reword that line** — the deploy fails
loudly if it can't find it, rather than shipping a worker that can't bust its
cache. It's the only substitution that happens at deploy; the file in the repo is
plain valid JS, and `/web` still has no build step for development.

## Status

Live and deployed: the Supabase schema + views, the `writer` Edge Function, the
GitHub Pages dashboard, and the twice-daily scraper (GitHub Actions secrets
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`). Day-to-day use is: add tools and paste
links in the dashboard, and let the scraper — or the **Run price scrape now** button —
keep prices fresh. See `scraper/README.md` for the scraper internals.
