# Scraper

Node.js dealer adapters + batch price runner. Runs in GitHub Actions twice daily;
can also run locally on a machine with Node 22+.

## Install & run

```bash
cd scraper
npm install
npx playwright install chromium   # only needed for JS-rendered dealers
cp .env.example .env               # fill in SUPABASE_SERVICE_ROLE_KEY

node src/run.js                    # refresh prices for all active dealers (the product)
node src/run.js --dealer "KMS Tools"
node src/import-csv.js ./tools.csv                  # import a tool list
# node src/auto-map.js / link-finder.js are PARKED (discovery) — see below

```

## Architecture

- `src/util/http.js` — fetch with retry + exponential backoff, randomized
  delays, rotating desktop user-agent. Per-dealer concurrency is 1 (the runner
  processes each dealer's listings sequentially).
- `src/util/browser.js` — lazy shared Playwright browser, used only by adapters
  that set `needsJs = true`.
- `src/adapters/base.js` — the adapter interface + shared HTML extraction
  helpers (JSON-LD `Product` offers, common price/stock selectors).
- `src/adapters/<dealer>.js` — one module per dealer. Each exports:
  ```js
  export default {
    dealer: 'Princess Auto',
    needsJs: false,
    async scrape(productUrl, ctx) { return { price, regular_price, on_sale, in_stock }; },
    async search(modelNumber, ctx) { return [{ url, title, price }]; }, // for link finder
  }
  ```
- `src/run.js` — for each active dealer, opens a `scrape_runs` row, scrapes every
  active listing sequentially, writes a `price_snapshot` per success, logs every
  failure into `error_log`, and closes the run. One dealer (or listing) breaking
  never aborts the batch. **This is the product** in the manual-first model: it
  refreshes prices on the links the owner pasted; it does not discover new links.
- `src/auto-map.js` — **parked** (manual-first pivot). The description/SKU matcher
  (`match.js`, `sku.js`, `map_candidates`) is validated and kept in-tree, but the
  scrape workflow only runs it when the repo variable `ENABLE_AUTO_MAP == 'true'`.

## Adding a dealer

Under manual-first this is rarely needed — pasting a link auto-registers its
dealer by hostname (see the app's quick-add flow). For a hand-built adapter:

1. Copy `adapters/princess-auto.js` to `adapters/<dealer>.js`.
2. Implement `scrape()` (and optionally `search()` for the link finder).
3. Register it in `adapters/index.js`.
4. Make sure a matching row exists in the `dealers` table (name must match
   `adapter.dealer` exactly).
