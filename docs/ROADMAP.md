# Blackbird Tool Tracker — Roadmap

The work queue for the post-pivot, **manual-first** tracker. [`FABLE.md`](../FABLE.md)
(cold-start handoff) and [`PROJECT_BRIEF.md`](../PROJECT_BRIEF.md) remain the source of
truth for how things work and how to work here (**act; don't ask** — defaults are chosen
below; the only pauses are the two items in §5, which cost money or hardware).
[`IMPROVEMENT_PLAN.md`](IMPROVEMENT_PLAN.md) is the older plan, kept as history — this
file is the roadmap.

One item = one commit. Verify with a real CI run / DOM evidence per the handoff. Clean up
test data after every session.

---

## 1. Finish the seven named open items

### 1.1 Offline write-queue for checkmarks
**Problem.** Ticking a tool off with no signal (remote site, in-store basement) silently
fails; the checklist's core act must work offline.
**Change.** Intercept at the `SB.writeApi()` layer: if offline or the fetch fails
network-level, enqueue `{op, payload, ts}` in IndexedDB — **queueable ops whitelist:
`toggle_owned` only for now** (it carries the desired end-state, so replay is safe and
last-write-wins is correct). Flush on `online` and on app open, oldest first; show a
small "n pending" badge; non-queueable ops get an honest "you're offline" toast. The ✓
flips optimistically from the queued state so the UI matches what will happen.
**Done when** airplane-mode toggles survive a reload and sync when connectivity returns,
with the badge counting down.

### 1.2 Lazy sparklines
Draw each sparkline only when its card enters the viewport (`IntersectionObserver`,
one shared observer), leaving a fixed-size placeholder so nothing shifts. Disconnect
observers on tab switch. **Done when** initial render of a long list does zero chart
work for off-screen cards and scrolling stays smooth on a phone.

### 1.3 Overlay focus-trap + Esc
Detail overlay: `role="dialog"` + `aria-modal="true"`, focus moves in on open, Tab
cycles inside, Esc closes, focus returns to the opening element. Applies to any other
sheet (quick-add) too. **Done when** the overlay is fully keyboard-operable and focus
never escapes behind it.

### 1.4 Aria polish
`aria-pressed` on ✓ toggles; `aria-label` on every icon-only button (＋, copy, close,
refresh); the price-history chart gets an offscreen text summary (latest, low, high,
dealer count) so it isn't a silent canvas; progress bars get `role="progressbar"` +
values. No visual change — chrome stays chrome.

### 1.5 Copy-best-price-link
One icon button on the tool card and detail header: copies the current BEST listing's
URL via `navigator.clipboard` (fallback: temporary input + select). Confirm with a
brief toast, no layout shift. **Done when** he can paste a best-price link into a text
message in two taps.

### 1.6 `node:test` harness — encode the traps as regressions
Zero new prod dependencies; Node 22's built-in runner. Two layers:
- **Pure-JS unit tests** (`scraper/test/*.test.js` + `scraper/fixtures/`): `parsePrice`
  (FR locale, `$`, narrow spaces, unit prices); generic adapter against a saved
  myflukestore-style fixture (must return $725.67, not the $135 warranty add-on);
  `normalizeUrl`; currency handling with Valet mocked **down** (must reject, never
  guess — fails closed).
- **DB-layer tests** (Actions `services: postgres:16`): apply every migration in order
  (this alone catches broken SQL), seed fixtures, assert: `at_all_time_low` requires
  `all_time_high > all_time_low`; anomaly/cross-dealer-flagged rows excluded from
  stats and from `tool_market_status` best; inactive listings never win BEST; the
  **`attachListing()` contract** (revive a removed link, no-op if present, conflict
  reported, never moves a link between tools) — test it wherever the logic lives; if
  it's inlined in the Deno function, extract the pure decision logic into a small
  shared module so it's testable.
New `test.yml` on PR + push. **Done when** every §6 trap in the handoff has a test that
fails if the bug comes back.

### 1.7 Share `DEAL_PCT`
`report.js` hardcodes −10%. Single source: `web/js/constants.js` (must live under
`/web` so Pages serves it), exported as a plain ES module; the dashboard imports it
normally and the scraper imports it by relative path (`../../web/js/constants.js`).
Put `STALE_MANUAL_DAYS` (§2.2) and any other shared thresholds there too. Don't make it
user-configurable — the scraper can't read a browser's localStorage, and a split-brain
threshold is worse than a fixed one.

---

## 2. High-value additions for the manual-first loop

### 2.1 Deal + target-price push alerts (ntfy.sh — free, no account)
The tracker's job is *buy at the right time*; that signal has to reach his phone on
rotation, not wait for him to open a tab.
- Generate a random topic (`bbt-<24 hex>`), store as Actions secret `NTFY_TOPIC`; add a
  post-run step: `curl -d "<msg>" ntfy.sh/$TOPIC` for (a) best price crossing **at or
  under `target_price`**, (b) a drop ≥ `DEAL_PCT` vs the 90-day avg, (c) a run-level
  failure. Skip silently if the secret is unset.
- **Dedup or it becomes noise:** a small `alerts_sent (tool_id, kind, price_cad,
  sent_at)` table (next migration number — read the folder); re-alert the same tool
  only if the price dropped further by ≥2% or 14 days passed.
- Subscribe instructions (topic + ntfy app link) go in the README and a one-line note
  in Settings. Sending pushes before he subscribes is harmless — implement, then tell
  him the topic.
**Done when** dropping a listing's price in a test writes exactly one push, and a rerun
at the same price sends nothing.

### 2.2 Manual/bookmarklet price staleness — protect the BEST tag
**Problem.** CT/Amazon prices only update when he sweeps with the bookmarklet. A
3-week-old captured price can silently hold the BEST tag against fresh scraped prices —
that's the currency bug's shape again: a confident number that isn't current.
**Change.** Every displayed price older than 7 days gets a quiet age chip ("12 d").
For **manual-source** snapshots only, `tool_market_status` excludes the listing from
BEST once its latest price is older than `STALE_MANUAL_DAYS` (default **21**, shared
constant); the listing stays visible with a "stale — recapture" chip that deep-links
the bookmarklet flow. Restate `security_invoker=true` when replacing the view. Status
colour may carry this (it's meaning), per the palette rules.
**Done when** a stale captured price can't win BEST but is still shown, aged, one tap
from recapture.

### 2.3 Purchase capture on ✓ + real progress math
He's buying tools for a business; the checklist should record the buy, not just the
tick.
- ✓ ON opens a two-field confirm: dealer (default = current BEST listing) and price
  (default = that listing's latest `price_cad`), date = now. **[Save] / [Skip]** —
  Skip just ticks, zero friction preserved. New nullable columns on `tools`:
  `purchase_price_cad, purchased_at, purchase_listing_id` (next migration number).
  ✓ OFF clears them with an undo toast.
- Checklist headers get the money view: per tier and total — `spent $X · remaining
  ≈ $Y at today's best` where remaining = Σ best_price × `quantity` over unowned
  priced tools, with an honest "(n unpriced)" suffix. CSV/JSON export includes the
  purchase fields (his capex record).
**Done when** checking off the 87V Max records where and for how much, and the Tier 1
header's numbers move accordingly.

### 2.4 Stop hand-bumping `CACHE` — stamp it at deploy
The stale-service-worker trap survives on a human rule ("bump CACHE every deploy").
Remove the human: in `deploy-web.yml`, before publishing, substitute the commit SHA
into `sw.js` (`const CACHE = 'bbt-<sha>'`). Deploy-time substitution only — the repo
file keeps a placeholder; `/web` still has no build step for development. Document it
in the README so the magic is on the record. **Done when** two consecutive deploys
produce different cache names with no manual edit, and the update toast fires.

### 2.5 Weekly automatic backup
The pre-wipe backup was manual and one-time. Add `backup.yml` (weekly cron): a small
Node script dumps `tools`, `tool_listings`, `dealers`, and each listing's latest price
to JSON and uploads it as an Actions **artifact** (90-day retention) — off-repo by
construction, no secrets in the dump (service key read stays in CI). **Done when** a
dated artifact appears weekly and restoring from it is documented in one README
paragraph.

### 2.6 FX robustness within fail-closed
Valet is queried live; if it's down, every non-CAD price in the run is rejected. Cache
the last successful daily rate (tiny `fx_rates(currency, rate, as_of)` table, same
migration as 2.1/2.3 if convenient): use a cached rate up to **7 days** old (still
recorded in `fx_rate` per the audit contract), reject beyond that. Fail-closed stands —
this just narrows "Valet hiccuped" from "lost the run's USD prices" to "used
yesterday's rate, said so."

### 2.7 Show the conversion audit — ✅ already shipped
Converted rows already store `price_original` + `fx_rate`; surface them: detail-view
converted prices get a small secondary line — `US$635.99 · 1.4051 · Jul 14`. It earns
its place: it's the answer to "why does fluke.com say a different number than the app."

**Already done** — `fxNote()` in `app.js` has been rendering this all along, as
`$893.63 · Jul 16 · converted from 635.99 USD @ 1.4051` on each dealer row.
Verified in the browser against a seeded USD listing. Nothing to build.

### 2.8 Deploy the writer from CI, not by hand
**Problem.** `supabase/functions/writer/` is deployed by copying its source into a
deploy call. It's ~600 lines, and it is the ONLY write path the browser has: a
hand-copy is a chance to corrupt it, and nothing checks that what's deployed matches
what's in the repo. The repo is the source of truth everywhere else here; for this
one file it's a convention held up by care.
**Change.** A `deploy-writer.yml` on push to `main` (paths: `supabase/functions/**`)
running the Supabase CLI (`supabase functions deploy writer --project-ref …`), with a
`SUPABASE_ACCESS_TOKEN` repo secret. Keep `verify_jwt=false` — auth is the writer
token, per the security model. **Done when** a push touching the function redeploys
it with no hand-copying, and the deployed version matches the commit.
**Needs him:** a Supabase access token minted and added as a GitHub secret. Costs
nothing, but it's his credential — never read or paste it.

---

## 3. Polish as the list grows

- **3.1 Checklist search/filter** — a single input filtering name/brand/pn, appearing
  only once the list exceeds ~15 tools (before that it's chrome). Persists per tab
  session, clears with Esc.
- **3.2 Persist last active tab** — check whether it survived the rebuild; if not,
  localStorage `bbt_last_tab`.
- **3.3 Snapshot retention** — not urgent at curated-list volume; revisit when
  `price_snapshots` passes ~250k rows (compact >180 d to daily minima).

## 4. Parked — do not touch unless he asks

Auto-map / discovery (`ENABLE_AUTO_MAP` stays unset), dealer catalogs, Flipp,
description matching, Keepa, Zyte/home-proxy for HD/CT/Amazon. The bookmarklet is the
sanctioned path for blocked dealers.

## 5. The only two pauses (per his rules — they cost money/hardware)

1. **Home residential proxy** for HD auto-refresh (needs an always-on device of his).
2. **Zyte / Keepa** paid coverage. Everything else in this doc: act, verify, report.

## 6. Suggested order

| Session | Items |
|---|---|
| 1 | ✅ 1.6 test harness + fixtures (locks the traps in before touching anything else) |
| 2 | ✅ 1.7 shared constants · ✅ 2.4 CACHE stamping · ✅ 2.5 weekly backup · ⏸ 2.8 writer deploy (needs his token) |
| 3 | ✅ 2.2 staleness guard · ✅ 2.7 conversion audit line (was already shipped) |
| 4 | ✅ 1.1 offline queue · ✅ 1.2 lazy sparklines |
| 5 | 2.3 purchase capture + progress math |
| 6 | 2.1 ntfy alerts · 1.3–1.5 a11y + copy-link · §3 as reached |

`STALE_MANUAL_DAYS` already lives in `web/js/constants.js`, so 2.2 has its constant
waiting.

## 7. Guardrails — current, binding

- Everything in the cold-start handoff §5–§7 stands: no local Node; `/web` stays
  vanilla with **no dev build step** (2.4's deploy-time stamp is the documented
  exception at deploy only); no secrets in the repo; migrations append-only, **number
  read from the folder**, never edit an applied one; polite scraping, no anti-bot
  evasion; never break the manual paste path; never seed `owned`; every link attach
  goes through `attachListing()`.
- **`price_cad` is always CAD**; currency handling fails closed (2.6 refines the
  window, not the principle).
- Views are replaced with `security_invoker=true` restated, every time.
- Colour only where it carries meaning; chart palettes stay CVD-validated against
  `#ffffff` — re-validate if 2.2's status chips touch the palette.
- **Never bump `CACHE` by hand** (2.4 landed): `deploy-web.yml` stamps the commit SHA
  into `sw.js` at deploy. The repo copy stays `bbt-shell-dev`.
- Clean up all test tools/dealers/snapshots after each session and restore his data
  exactly; his live list is small and hand-built — treat every row as his.
