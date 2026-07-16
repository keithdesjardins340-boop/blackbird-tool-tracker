# Blackbird Tool Tracker — cold-start handoff

The working brief, and it's self-contained: paste the whole file into a session with
no repo access and it can work from this alone. In the repo, `CLAUDE.md` just points
here. `PROJECT_BRIEF.md` is the deeper reference (schema, views, the writer op
whitelist); `docs/ROADMAP.md` is the work queue and what's deliberately parked.

The name is where it started, not who it's for — it applies to every model.

---

## 1. What it is

A price tracker + buy-checklist for one person — **Keith, a heavy-duty mechanic
outfitting a service truck**. He curates the tool list and **pastes the dealer links
himself**. The system's only automated job is **refreshing prices on links it was
given**: best price per tool, price history, a tiered buy-order checklist, and a
record of what he actually paid.

**Nothing is ever attached automatically, and that's the whole design.** An earlier
build-out chased "every dealer, every tool", auto-attached listings, priced ~55 of 295
tools and produced matching noise instead of purchases. He rolled it back. Auto-map
still exists behind the repo variable `ENABLE_AUTO_MAP` (unset). Don't resurrect it,
don't "fix" it, don't propose dealer catalogs — he chose signal over coverage.

**Deal discovery (2026-07-16) is the review-gated retry of that idea, and the
distinction is load-bearing.** A weekly job searches Google Shopping (SerpApi) for
tools already on the list and drops candidate *cheaper* listings into an inbox as
**leads**. It never attaches anything and never writes a price: accepting a lead means
he pastes the real dealer link, and the generic adapter prices it like any other. Its
matcher **fails closed** — no reference price, no lead; not cheaper, no lead. Gated by
`ENABLE_DISCOVERY` + a `SERPAPI_KEY` secret; both unset ⇒ it does nothing. **If it
ever starts producing noise, that's the old failure returning: turn the variable off
rather than tuning it.**

Live: <https://keithdesjardins340-boop.github.io/blackbird-tool-tracker/>
Repo (public): `github.com/keithdesjardins340-boop/blackbird-tool-tracker`

## 2. How he wants you to work

**Act; don't ask.** He gave the assistant Chrome, database and git access precisely so
he doesn't have to do the steps. Don't offer menus, don't ask permission for
reversible work. Do it, verify it, then say what you did in plain language.

Pause only when:
- it **spends his money** (paid APIs/proxies),
- it's **irreversible and you can't back it up first** → back it up, then proceed,
- a **platform safety guard blocks you** → say so plainly; **never route around it**
  (don't swap `truncate` for `delete from`, don't drive the SQL editor via the browser
  to redo a blocked action),
- it's a real **fork in product direction** with no defensible default.

Three things that fall out of that, learned the hard way:

- **Autonomy raises the verification bar, it doesn't lower it.** Nobody is checking
  behind you. "It should be fine" isn't done — see §7.
- **"Do everything yourself" never includes credentials.** He'll say it while meaning
  *stop asking me about code*. **He has twice pasted a live secret into chat** to
  unblock something (a `service_role` key; later a Supabase `sbp_` PAT). Don't use it,
  tell him to **revoke** it — a secret in a transcript is burned even after it's also
  in the right place — and when you ask for one, put *"don't send it to me"* on
  **every** ask in that message, not just one of them.
- **He reads this app WEEKLY, not daily** (he declined push alerts, 2026-07-16). So
  anything that answers *"is this number still true?"* has to be **on screen**, never
  sent to him. He also dislikes chrome that doesn't earn its place: if a label isn't
  something he'd act on, take it off. And he wants the truth about what's broken —
  including when you broke it.

## 3. Stack

- **Supabase** (Postgres + PostgREST + RLS) — project `ssfhjhbarkpgbelnbcun`,
  ca-central-1, `https://ssfhjhbarkpgbelnbcun.supabase.co`.
- **`/web`** — vanilla PWA. No framework, no bundler, **no build step**. GitHub Pages,
  auto-deploys on push to `main`. `app.js` is `type="module"` (it imports
  `js/constants.js`); `config.js`/`queue.js`/`supabase.js`/`charts.js` are classic
  scripts that run before it.
- **`/scraper`** — Node 22, **runs only in GitHub Actions** (he has no Node locally).
  `run.js` is the product; cron 01:00 & 13:00 UTC.
- **`/supabase/functions/writer`** — Deno Edge Function; the ONLY write path from the
  browser. **Deployed by `deploy-writer.yml`** on any push touching
  `supabase/functions/**` — never by hand.

### Data model
`tools` → `tool_listings` (one row per dealer URL) → `price_snapshots`.
Dealers **auto-register from a pasted link's hostname** (known hosts map to curated
names; anything else becomes a dealer named after its domain, priced by the generic
adapter).

Views (all `security_invoker=true` — **restate that when replacing one**):
- `tool_market_status` — the dashboard's main read (best/cheapest per tool + flags)
- `listing_latest_price`, `listing_price_stats`, `dealer_health`, `listing_spark`

Key column contract: **`price_snapshots.price_cad` is ALWAYS CAD.** `currency` is what
the page quoted, with `price_original` + `fx_rate` for audit.

### Security
The browser never holds the `service_role` key. Reads use the anon key (RLS =
read-only). Writes go through the writer function, authorized by a **writer token** (in
`app_secrets`, pasted per-device into Settings). The GitHub PAT for the "Run price
scrape now" button lives in the **`GH_PAT` function secret**. **Never read, move, or
paste credentials.** `--no-verify-jwt` in `deploy-writer.yml` is load-bearing: auth is
the writer token, so JWT verification would 401 every write in the app.

## 4. The loop

1. **Quick-add (＋)**: a tool + multi-line dealer links → one call
   (`add_tool_with_links`); each link's dealer resolved by hostname.
2. **`run.js`** (2×/day, or the Run-price-scrape-now button → `trigger_scrape`) prices
   every active listing → `price_snapshot`. Converts to CAD, runs the anomaly gates,
   deactivates 404/410 links, logs failures.
3. **Generic adapter** (JSON-LD → meta → markup) prices a pasted link from any
   server-rendered site.
4. **Bookmarklet** for dealers CI can't reach (Canadian Tire, Amazon, sometimes Home
   Depot): captures a price from his own browser → `record_price` /
   `add_listing_with_price`.
5. **✓ records the buy** — ticking a tool offers a two-field confirm (dealer + what he
   paid), defaulted from today's best. **Skip must stay one tap**; a checkmark can
   never become a form he has to fill in in a parts aisle.

## 5. Hard rules

- **No Node/npm locally.** Validate scraper changes with a real CI run + the run
  report. `test.yml` runs the suite on every push/PR and reports its counts to the run
  page — that's your fastest honest feedback loop.
- **No secrets in the repo, ever.**
- **Migrations are append-only and numbered.** The next number is whatever's highest in
  `supabase/migrations/` plus one — **read the folder**, don't trust a number in a doc
  (they go stale; this one already did).
- **Scrape politely**: 2×/day, honest UA, per-dealer pacing, **no anti-bot evasion**.
  Blocked stays blocked until he opts into a proxy or uses the bookmarklet.
- **Never break the manual paste path** — a pasted URL must always price via the
  generic adapter.
- **Never seed `owned`** — he ticks tools off as he buys them. Asked once, he said *"I
  have nothing on the list yet."*
- **Colour only where it carries meaning** (tier priority, status, price direction,
  chart series); chrome stays monochrome. Chart palettes are CVD-validated — if you
  change one, re-validate it against the `#ffffff` surface (§7 says how, with no Node).
- **Every op that attaches a link must go through `attachListing()`** (revive a removed
  link, no-op if present, report a conflict, never move a link between tools).
- **Don't hand-bump `CACHE` in `sw.js`** — `deploy-web.yml` stamps the commit SHA into
  it. Don't reword that line either; the deploy fails if its `sed` matches nothing.
- **Shared thresholds live in `web/js/constants.js`** (`DEAL_PCT`, `STALE_MANUAL_DAYS`,
  `PRICE_AGE_CHIP_DAYS`, `SEARCH_FROM_TOOLS`) — imported by both the dashboard and the
  scraper. Don't re-hardcode one; a test will catch you.

## 6. Traps — things that actually went wrong here

Every one of these has a test now. Add to them rather than around them.

- **The service worker served stale code.** A plain `fetch()` still consults the
  browser's HTTP cache, so "network-first" wasn't fresh and deploys looked like they
  never landed. Fixed with `cache:'no-cache'` + `Request(url,{cache:'reload'})`.
  *Symptom:* a cache-busted `?cb=` fetch shows the NEW file while the running page is
  OLD.
- **Prices were assumed CAD.** A US price was stored as if Canadian (~40% error — it
  made the most expensive dealer look like the cheapest). Currency now comes off the
  page and converts via the Bank of Canada Valet API. It **fails closed**: a non-CAD
  price we can't convert is rejected, never guessed. A cached rate up to 7 days old is
  allowed (`fx_rates`), dated by Valet's own observation day — never by fetch time, or
  a Friday rate looks fresh all weekend.
- **Stats lie when history is thin.** `at_all_time_low` was true for every new tool (one
  snapshot IS its own low) so Deals flagged everything. It now requires
  `all_time_high > all_time_low` — a real observed drop. **Watch for this shape.**
- **A parser can read the wrong number.** myflukestore.ca served a $135 *warranty
  add-on* above the real $725.67. The generic adapter skips add-on/upsell/related
  subtrees, and `run.js` cross-checks every price against the tool's other dealers.
- **Hidden rows still counted.** The detail view rendered listings without filtering
  `active`, so a removed link stayed visible *and* could win BEST.
- **`upsert(…ignoreDuplicates)` made removed links un-re-addable** — the row still
  existed with `active=false`, so the insert silently did nothing.
- **A stale hand-capture could hold BEST.** CT/Amazon prices only refresh when he
  sweeps with the bookmarklet, so a 3-week-old capture could beat today's real price.
  `tool_market_status` drops a manual capture from BEST past `STALE_MANUAL_DAYS`; it
  stays visible, aged, one tap from recapture.
- **⚠️ The Data API caps EVERY response at 1000 rows, SILENTLY** (Supabase → Data API →
  Settings → Max rows). No error, just fewer rows. The sparkline query pulled ~180
  snapshots per listing per 90 days — it would have broken at ~6 priced tools, and
  being ordered ascending, the rows it dropped were *today's*. **Any read that grows
  with the list or with time must page (`util/page.js` `fetchAll`), collapse
  server-side (`listing_spark`, `listing_latest_price`), or fetch `desc` + `limit` so
  truncation loses the OLDEST.** Invisible on his tiny dataset — reason about it, you
  cannot test it with 22 snapshots.
- **An offline purchase vanished from the money line.** The queue overlay restored the
  tick but not the price, and an owned tool with no `purchase_price_cad` counts toward
  neither *spent* nor *remaining*. Restore the whole queued end-state, not part of it.
- **`scraper/src/supabase.js` calls `process.exit(1)`** without its env vars. Never
  import it at the top of a module a test imports — the test file dies with a bare
  "exit code 1". Import it lazily inside the function (`alerts.js`) or inject the DB
  access (`fx.js` takes a `store`).

The shape they share: **a confident number that isn't true.** When choosing, prefer
the honest failure — no price beats a wrong one, because "no price" sends him to look
and a stale number sends him to the store.

## 7. Verifying, given the constraints

- **Browser**: the in-app Browser pane can load `localhost`; **Claude-in-Chrome
  cannot** (it reaches the live site, where his writer token lives — `SB.writeApi(op,…)`
  uses that token internally without exposing it to you).
- Serve `/web` with an inline PowerShell `HttpListener` on a spare port, **in the
  background** (a foreground one dies with its parent). `-ExecutionPolicy Bypass` is
  blocked, so run the listener inline, not via `-File`. Serve `.js` as
  `text/javascript` or the ES-module import of `constants.js` fails.
- **`IntersectionObserver` never fires in the in-app Browser pane** (it doesn't really
  paint) and not in a Chrome tab whose `visibilityState` is `hidden` — the default for
  claude-in-chrome tabs. Lazy-render code looks broken (0 drawn) when it's fine. Take a
  `computer{screenshot}` to force the tab visible, then re-measure.
- `computer{screenshot}` on the in-app pane tends to time out. **Verify by reading
  computed styles / the DOM** — better evidence than a picture anyway.
- **GitHub Actions logs are NOT readable anonymously** even though the repo is public.
  Use claude-in-chrome (he's signed in), or `api.github.com/.../actions/runs/<id>/jobs`
  for per-step conclusions.
- To exercise the dashboard against a LONG list without touching the DB, stub
  `SB.select` (a read) to return fakes and click Refresh. Reload to drop the stub.
- **Prove a new regression test actually bites**: push a throwaway `verify/**` branch
  with the bug reintroduced (that branch's own `test.yml` controls its triggers, so
  widening `push.branches` there is enough — no PR needed). Delete the branch after.
- Chart palettes: no Node, so run the dataviz `validate_palette.js` in the browser via
  the same inline listener and read `window.__RESULT`.
- **Clean up after yourself**: take a row-count baseline BEFORE testing, name test rows
  `ZZ TEST%`, delete them after, and re-check the counts. His live list is small and
  hand-built — treat every row as his.

## 8. Current state (2026-07-16 — verify, don't trust)

He is rebuilding his list **by hand** after a deliberate full wipe, so it's a handful
of tools and growing — **read the tables, don't trust a count here**. The first is
**"87V Max" (Tier 1)** with 4 dealer links (itm.com and myflukestore.ca $725.67,
Amazon.ca $854.77, fluke.com $893.50 converted from $635.99 USD). Dealers beyond the
five modelled ones auto-register from the hostnames he pastes. The pre-wipe 295-tool
list is backed up **beside the repo, not in it** — `../backups/blackbird-FULL-BACKUP-pre-wipe.json`
(i.e. `Blackbird tools/backups/`), deliberately off-repo because this repo is public.
`backup.yml` now dumps the database to a private Actions artifact weekly.

**The roadmap is done and nothing is waiting on him.** What's left is parked by his
choice (auto-map, push alerts) or costs money/hardware (Zyte/Keepa, a home proxy).
Snapshot retention isn't due until `price_snapshots` passes ~250k rows; it's at 22.

Live and verified end-to-end: quick-add, hostname dealers, bookmarklet capture,
USD→CAD, the scrape button, the broken-link alert, dealer-scoped price history, chart
hover, the scrape clock, the 3-tier checklist, purchase capture, the offline
write-queue, and lazy sparklines.

**The real bottleneck is not code — it's that the list has 2 tools on it.** The most
useful thing that can happen next is him pasting dealer links; that's where the
remaining bugs live, and curating the list is his by design.
