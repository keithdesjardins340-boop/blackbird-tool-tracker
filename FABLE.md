# Blackbird Tool Tracker — cold-start handoff

Self-contained: paste this whole file into a fresh session that has no repo access
and it should be able to work. If the session IS in the repo, `CLAUDE.md` loads
automatically and says the same things — read that instead and ignore this.

---

## 1. What it is

A price tracker + buy-checklist for one person — Keith, a heavy-duty mechanic
outfitting a service truck. He curates the tool list and **pastes the dealer links
himself**. The system's only automated job is **refreshing prices on links it was
given**: best price per tool, price history, and a tiered buy-order checklist.

**There is no automated dealer discovery, and that's on purpose.** An earlier
build-out chased "every dealer, every tool", priced ~55 of 295 tools, and generated
matching noise instead of purchases. It was rolled back. Auto-map still exists but
is parked behind the repo variable `ENABLE_AUTO_MAP` (unset). Don't resurrect it
unless he asks.

Live: <https://keithdesjardins340-boop.github.io/blackbird-tool-tracker/>
Repo (public): `github.com/keithdesjardins340-boop/blackbird-tool-tracker`

## 2. How he wants you to work

**Act; don't ask.** He gave the assistant Chrome, database and git access precisely
so he doesn't have to do the steps. Don't offer menus of options, don't ask
permission for reversible work. Do it, verify it, then say what you did in plain
language.

Pause only when:
- it **spends his money** (paid APIs/proxies),
- it's **irreversible and you can't back it up first** → back it up, then proceed,
- a **platform safety guard blocks you** → say so plainly; **never route around it**
  (don't swap `truncate` for `delete from`, don't drive the SQL editor via the
  browser to redo a blocked action),
- it's a real **fork in product direction** with no defensible default.

He dislikes chrome that doesn't earn its place. If a label isn't something he'd act
on, take it off the screen. He also wants to be told the truth about what's broken —
including when you broke it.

## 3. Stack

- **Supabase** (Postgres + PostgREST + RLS) — project `ssfhjhbarkpgbelnbcun`,
  ca-central-1, `https://ssfhjhbarkpgbelnbcun.supabase.co`.
- **`/web`** — vanilla PWA. No framework, no bundler, **no build step**. GitHub
  Pages, auto-deploys on push to `main`.
- **`/scraper`** — Node 22, **runs only in GitHub Actions** (he has no Node
  locally). `run.js` is the product; cron 01:00 & 13:00 UTC.
- **`/supabase/functions/writer`** — Deno Edge Function; the ONLY write path from
  the browser.

### Data model
`tools` → `tool_listings` (one row per dealer URL) → `price_snapshots`.
Dealers **auto-register from a pasted link's hostname** (known hosts map to curated
names; anything else becomes a dealer named after its domain, priced by the generic
adapter).

Views (all `security_invoker=true` — **restate that when replacing one**):
- `tool_market_status` — the dashboard's main read (best/cheapest per tool + flags)
- `listing_latest_price`, `listing_price_stats`, `dealer_health`

Key column contract: **`price_snapshots.price_cad` is ALWAYS CAD.** `currency` is
what the page quoted, with `price_original` + `fx_rate` for audit.

### Security
The browser never holds the `service_role` key. Reads use the anon key (RLS =
read-only). Writes go through the writer function, authorized by a **writer token**
(in `app_secrets`, pasted per-device into Settings). The GitHub PAT for the
"Run price scrape now" button lives in the **`GH_PAT` function secret**.
**Never read, move, or paste credentials** — the platform will stop you, correctly.

## 4. The loop

1. **Quick-add (＋)**: a tool + multi-line dealer links → one call
   (`add_tool_with_links`); each link's dealer resolved by hostname.
2. **`run.js`** (2×/day, or the Run-price-scrape-now button → `trigger_scrape`)
   prices every active listing → `price_snapshot`. Converts to CAD, runs the
   anomaly gates, deactivates 404/410 links, logs failures.
3. **Generic adapter** (JSON-LD → meta → markup) prices a pasted link from any
   server-rendered site.
4. **Bookmarklet** for dealers CI can't reach (Canadian Tire, Amazon, sometimes
   Home Depot): captures a price from his own browser → `record_price` /
   `add_listing_with_price`.

## 5. Hard rules

- **No Node/npm locally.** Validate scraper changes with a real CI run + the run
  report. You cannot run the scraper on his machine.
- **No secrets in the repo, ever.**
- **Migrations are append-only and numbered.** The next number is whatever's highest
  in `supabase/migrations/` plus one — read the folder, don't trust a number written
  in a doc (they go stale). Never edit an applied migration; to undo one, add a new
  one that reverses it.
- **Scrape politely**: 2×/day, honest UA, per-dealer pacing, **no anti-bot evasion**.
  Blocked stays blocked until he opts into a proxy or uses the bookmarklet.
- **Never break the manual paste path** — a pasted URL must always price via the
  generic adapter.
- **Never seed `owned`** — he ticks tools off as he buys them.
- **Colour only where it carries meaning** (tier priority, status, price direction,
  chart series); chrome stays monochrome. Chart palettes are CVD-validated — if you
  change one, re-validate it against the `#ffffff` surface.
- **Every op that attaches a link must go through `attachListing()`** (revive a
  removed link, no-op if present, report a conflict, never move a link between
  tools).

## 6. Traps — things that actually went wrong here

- **The service worker served stale code.** A plain `fetch()` still consults the
  browser's HTTP cache, so "network-first" wasn't fresh and deploys looked like they
  never landed. Fixed with `cache:'no-cache'` + `Request(url,{cache:'reload'})`.
  *Symptom:* a cache-busted `?cb=` fetch shows the NEW file while the running page is
  OLD. **Bump `CACHE` in `sw.js` on every deploy.**
- **Prices were assumed CAD.** A US price was stored as if Canadian (~40% error —
  it made the most expensive dealer look like the cheapest). Currency now comes off
  the page and converts via the Bank of Canada Valet API (free, no key). It **fails
  closed**: a non-CAD price we can't convert is rejected, never guessed.
- **Stats lie when history is thin.** `at_all_time_low` was true for every new tool
  (one snapshot IS its own low) so Deals flagged everything. It now requires
  `all_time_high > all_time_low` — a real observed drop. Watch for this shape of bug.
- **A parser can read the wrong number.** myflukestore.ca served a $135 *warranty
  add-on* above the real $725.67. The generic adapter now skips
  add-on/upsell/related subtrees, and `run.js` cross-checks every price against the
  tool's other dealers (>4× / <0.25× the median → flagged, kept for audit, excluded
  from stats).
- **Hidden rows still counted.** The detail view rendered listings without filtering
  `active`, so a removed link stayed visible *and* could win the BEST tag.
- **`upsert(…ignoreDuplicates)` made removed links un-re-addable** — the row still
  existed with `active=false`, so the insert silently did nothing.

## 7. Verifying, given the constraints

- **Browser**: the in-app browser can load `localhost`; **Claude-in-Chrome cannot**
  (it reaches the live site, where his writer token lives — `SB.writeApi(op, …)`
  uses that token internally without exposing it to you).
- Serve `/web` with an inline PowerShell `HttpListener` on a spare port.
  `-ExecutionPolicy Bypass` is blocked, so run the listener **inline**, not via
  `-File`. The PowerShell tool's cwd is already `blackbird-tool-tracker/` — use
  absolute paths.
- `computer{screenshot}` on the in-app browser tends to time out. **Verify by reading
  computed styles / the DOM** — better evidence than a picture anyway.
- Deploying the Edge Function proves it compiles. Test DB effects with SQL.
- **Clean up after yourself**: delete test tools/dealers/snapshots and restore his
  data exactly.

## 8. Current state

One tool — **"87V Max" (Tier 1)** — with 4 dealer links (itm.com $725.67 best,
myflukestore.ca $725.67, Amazon.ca $854.77, fluke.com $893.50 converted from
$635.99 USD). He is rebuilding his list by hand after a deliberate full wipe; the
pre-wipe 295-tool list is backed up at
`backups/blackbird-FULL-BACKUP-pre-wipe.json` (kept off-repo — this repo is public).

Live and verified end-to-end: quick-add, hostname dealers, bookmarklet capture,
USD→CAD, the scrape button (`GH_PAT` is set), the broken-link alert, dealer-scoped
price history, chart hover, the scrape clock, and the 3-tier checklist.

**Open / not done:** offline write-queue for checkmarks, lazy sparklines, overlay
focus-trap + Esc, aria polish, copy-best-price-link, a `node:test` harness, and
`report.js` hardcodes the −10% deal threshold instead of sharing `DEAL_PCT`.
