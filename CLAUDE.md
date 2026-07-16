# Blackbird Tool Tracker — working notes for Claude

Read this first. `PROJECT_BRIEF.md` has the full picture; this is the short version
plus the things that have actually bitten people here.

## What it is

A price tracker + buy-checklist for one person: Keith, a heavy-duty mechanic
outfitting a service truck. He curates his own tool list and **pastes the dealer
links himself**. The system's only automated job is **refreshing prices on links it
was given**. There is no automated discovery — that's deliberate (signal over
coverage), and auto-map is parked behind `ENABLE_AUTO_MAP`.

Live: <https://keithdesjardins340-boop.github.io/blackbird-tool-tracker/>

## How he wants you to work

**Act, don't ask.** He gave you Chrome, the database and git so he doesn't have to
do the steps. Don't hand him a menu of options or ask permission for reversible
work — do it, then say what you did. Pause only for:
- spending his money (paid APIs/proxies),
- something irreversible you can't back up first (back it up, then go),
- a platform guard blocking you — **say so plainly, never route around it**,
- a real fork in product direction with no defensible default.

He dislikes UI chrome that doesn't earn its place. If a label isn't something he'd
act on, it shouldn't be on screen.

## The shape of it

- **Supabase** (Postgres + PostgREST + RLS), project `ssfhjhbarkpgbelnbcun`.
- **`/web`** — vanilla PWA (no framework, no build step). GitHub Pages, deploys on
  push to `main`.
- **`/scraper`** — Node, **GitHub Actions only** (there is no Node on his machine).
  `run.js` is the product: price every active listing, twice daily.
- **`/supabase/functions/writer`** — the ONLY write path from the browser.

### Data model in one breath
`tools` → `tool_listings` (one per dealer URL) → `price_snapshots`. Dealers
auto-register from a pasted link's hostname. Views: `tool_market_status` (the
dashboard's main read), `listing_latest_price`, `listing_price_stats`,
`dealer_health`. All are `security_invoker=true` — restate that when replacing one.

## Hard rules

- **No Node/npm locally.** Can't run the scraper here; validate scraper changes with
  a real CI run and read the run report.
- **No secrets in the repo.** `service_role` never touches the browser. The writer
  token lives in `app_secrets`; the GitHub PAT lives in the `GH_PAT` **function
  secret**. Don't read or move credentials — the platform will (rightly) stop you.
- **Migrations are append-only.** Next is **0017**. Never edit an applied one.
- **Scrape politely**: 2×/day, honest UA, no anti-bot evasion. Blocked stays blocked
  until he opts into a proxy or uses the bookmarklet.
- **Never break the manual paste path** — a pasted URL must always price via the
  generic adapter.
- **Never seed `owned`.** He ticks tools off himself.
- Colour only where it carries meaning (tier priority, status, price direction,
  chart series). Chrome stays monochrome.

## Things that have actually gone wrong here

- **The service worker used to serve stale code.** A plain `fetch()` still consults
  the browser HTTP cache, so "network-first" wasn't fresh and deploys looked like
  they hadn't landed. Fixed with `cache:'no-cache'` + `Request(url,{cache:'reload'})`.
  **Symptom to recognise:** a cache-busted `?cb=` fetch shows the NEW file while the
  running page is OLD. Bump `CACHE` in `sw.js` on every deploy.
- **Prices were assumed CAD.** A US price got stored as if Canadian (~40% error, and
  it made the most expensive dealer look cheapest). Currency now comes off the page
  and converts via the Bank of Canada (free, no key). It **fails closed** — a
  non-CAD price we can't convert is rejected, never guessed. `price_cad` is ALWAYS
  CAD; `currency`/`price_original`/`fx_rate` keep it auditable.
- **A stat can lie when history is thin.** `at_all_time_low` was true for every
  newly-added tool (one snapshot IS its own low), so Deals flagged everything. It
  now requires `all_time_high > all_time_low` — a real observed drop.
- **A parser can read the wrong number.** myflukestore.ca served a $135 *warranty
  add-on* above the real `$725.67`; the generic adapter grabbed the first
  price-ish element. It now skips add-on/upsell/related subtrees, and `run.js`
  cross-checks each price against the tool's other dealers (>4x / <0.25x the median
  → flagged, excluded from stats).
- **Anything that adds a link must go through `attachListing()`** — it revives a
  removed link (keeping history), no-ops if present, and reports a conflict rather
  than moving a link between tools. Bare inserts throw raw duplicate-key errors, and
  an `upsert(...ignoreDuplicates)` silently made removed links un-re-addable.
- **Hidden rows still counted.** The detail view rendered listings without filtering
  `active`, so a removed link stayed on screen *and* could win the BEST tag.

## Verifying, given the constraints

You can't run the scraper locally and you can't do an authorized write without his
token — so:
- **Browser**: the in-app browser can load `localhost`; Claude-in-Chrome cannot (it
  can reach the live site, where his writer token lives, and `SB.writeApi(op, …)`
  uses that token internally without exposing it).
- Serve `/web` with an inline PowerShell `HttpListener` on a spare port —
  `-ExecutionPolicy Bypass` is blocked, so run the listener inline, not via `-File`.
  The PowerShell tool's cwd is already `blackbird-tool-tracker/`; use absolute paths.
- `computer{screenshot}` on the in-app browser tends to time out. **Verify by
  reading computed styles / the DOM**, which is better evidence than a picture.
- Deploying the Edge Function validates that it compiles. Test DB effects with SQL.
- **Clean up after yourself.** Test tools/dealers/snapshots get deleted; his data
  gets restored exactly.

## Current state

One tool ("87V Max", Tier 1) with 4 dealer links. Everything below is live and
verified end-to-end: quick-add, hostname dealers, bookmarklet capture, USD→CAD,
the scrape button (`GH_PAT` is set), the broken-link alert, dealer-scoped price
history, and the chart hover readout.

His pre-wipe 295-tool list is backed up at `backups/blackbird-FULL-BACKUP-pre-wipe.json`
(off-repo — this repo is public).
