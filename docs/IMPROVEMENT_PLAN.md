# Blackbird Tool Tracker — Improvement Plan (handoff)

Prioritized work plan (P0 → P3). One item = one PR/commit. Respect the guardrails at the bottom.

## P0 — Security & correctness (first)
- **2.1 Get `service_role` out of the browser.** It bypasses RLS = full admin to anyone with devtools on that device. Fix: Supabase Edge Function `writer` holding the service key as a secret, authorized by a random `WRITER_TOKEN`; dashboard stores only the token. Whitelist ops (toggle_owned, update_tool, insert_tool, insert_listing, accept_candidate, reject_candidate, set_dealer_status) — no generic SQL passthrough. Alt: custom `writer` JWT + limited Postgres role/policies.
- **2.2 Price parsing correctness.** Prefer JSON-LD offer price; capture regular/was price; shared `parsePrice` handling `1 234,56 $` / `$1,234.56` / narrow no-break spaces; reject unit prices; capture currency (≠CAD → flag, not average). Anomaly gate: price ≤0, >5×, or <0.2× trailing median → `is_anomaly=true`, excluded from stats. Migration 0007 adds `regular_price, currency, in_stock, is_anomaly` to price_snapshots.
- **2.3 Stock detection.** Map JSON-LD availability → in_stock; best-per-tool must be in-stock.
- **2.4 Listing dedup + indexes.** Shared `normalizeUrl()` (strip utm/tracking/fragment, lowercase host) in auto-map + the Add-link form; unique index (tool_id,dealer_id,product_url); indexes on snapshots/listings/tools; 404/410 → active=false + Health surface.
- **2.5 Cron timezone sanity.** Actions cron is UTC; Winnipeg is DST. Verify/fix expressions, comment the math.

## P1 — Coverage ("every dealer, every tool")
- **3.1 Sitemap-based catalogs (biggest unlock).** Fetch dealer product sitemaps (slugs are enough text for match.js); prefilter to tools; store in `dealer_catalog`; weekly refresh; add a 3rd auto-map path scoring against catalog slugs then confirming via one page fetch. Unlocks Home Depot without its blocked search.
- **3.2 Web-search fallback for mapping.** Brave/Google PSE API in CI, budget-capped (`site:domain brand model`), persist attempts.
- **3.3 Amazon.ca → API, not scraping.** Keepa (~€19/mo, ASIN-keyed, historical) recommended. PA-API needs Associates sales (probably N/A). Else pause with a note. **Keith decides.**
- **3.4 Canadian Tire pricing.** (1) Timebox plain-fetch probe of the PDP price JSON. (2) Add `fetchVia(url,{mode})` (direct|zyte|scraperapi) per-dealer `fetch_mode`; Zyte pay-per-use first (few $/mo at this volume). (3) Else broken + revisit. No headless stealth in CI (datacenter IPs get blocked).
- **3.5 Part-number harvester.** When any page is parsed, capture JSON-LD mpn/gtin/brand; if parent tool pn empty + confirmed listing, suggest a PN (one-tap "Set PN") — re-arms the SKU path. Zero new requests.
- **3.6 Optional LLM verification of the 0.42–0.62 band.** Opt-in Actions step → claude-haiku-4-5 strict-JSON same-product? yes/no/unsure; auto-promote/reject confident, leave unsure. Cap ~50/run; skip if no key. **Keith opts in.**

## P2 — Robustness & ops
- **4.1 Workflow hardening.** concurrency group (no overlap/double-insert); per-dealer matrix fail-fast:false + timeouts; upload failed HTML as artifact; run report to `$GITHUB_STEP_SUMMARY`.
- **4.2 ntfy.sh push alerts.** Random topic in secrets; alert on new Deal / dealer broken / run failure; Settings shows subscribe note.
- **4.3 Polite resilient fetch.** central fetchVia: retry×2 backoff+jitter, per-dealer concurrency ~4 + min-delay ~1s, one honest UA, Accept-Language en-CA,fr-CA.
- **4.4 Auto-pause broken dealers.** 3 consecutive failed runs → broken + alert; re-activate control in Health.
- **4.5 Snapshot retention.** Monthly compaction: rows >180d collapse to 1/listing/day (keep daily min). Keep inserting every run.
- **4.6 Tests, zero new deps.** node:test + fixtures per dealer (normal/sale/FR/OOS); unit tests for adapters, parsePrice, normalizeUrl, sku.js, match.js vs a ~30-triple labeled truth set; test.yml on PR+main.
- **4.7 match.js upgrades (measure vs truth set).** unit normalizer (1/2" ↔ 1/2 in ↔ 0.5in; ft-lb; pc) — do NOT equate imperial↔metric (flag as variant); brand alias table; partial model-number boost; accessory guard (price <~20% category median → penalize).
- **4.8 Generic adapter hardening.** traverse @graph/arrays; JSON-LD → microdata → og/product meta → markup; log parse_via.

## P3 — Dashboard & field UX
- **5.1 True offline checklist** (IndexedDB cache + "as of" stamp).
- **5.2 Offline write queue** for checkmarks (flush on online; "n pending" badge).
- **5.3 Export/backup** tools+owned+prices as CSV/JSON.
- **5.4 sw.js versioning** per-deploy cache name + "new version" toast.
- **5.5 Rendering perf** (IntersectionObserver sparklines; collapse/virtualize if needed).
- **5.6 UX wins** (focus-trap+Esc on overlay, aria-pressed toggles, persist tab, copy-best-price-link).

## Suggested order
1: 2.1 · 2.4 · 2.5 | 2: 2.2+2.3 (mig 0007) · 4.8 | 3: 3.1 (HD first, CT probe) | 4: 4.1 · 4.2 · 4.4 | 5: 3.5 · 4.6 | 6: 4.7 · 3.2 | 7+: 3.3/3.4 paid decisions · P3.

## Decisions to surface to Keith (don't decide unilaterally)
1. Keepa for Amazon.ca (~€19/mo)? 2. Zyte pay-per-use for Canadian Tire (few $/mo)? 3. LLM candidate verification (pennies/mo, needs ANTHROPIC_API_KEY)? 4. Deal-alert threshold (default ≥10% under 90-day avg, or all-time low).

## Guardrails — never violate
- No local Node/npm assumptions; everything runs in GitHub Actions; local = plain PowerShell / existing static server.
- Web app stays vanilla — no framework/bundler/build step for /web (plain ES modules/HTML/CSS).
- No secrets in the repo ever (incl. migrations/fixtures/workflows); new secrets → Actions/function secrets + a README line (name + purpose).
- Migrations append-only + numbered (next 0007); never edit an applied one.
- Scrape politely: 2 runs/day, per-dealer rate limits, honest UA; no anti-bot evasion — escalate to paid-API path.
- Never break the manual paste path (generic adapter must always price a pasted URL).
- Keep the light black-and-white theme; no color creep.
