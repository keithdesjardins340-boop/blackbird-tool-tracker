// The DB layer: what the views PROMISE the dashboard.
//
// tool_market_status is the dashboard's main read — best price, deal flags, the
// BEST tag. Most of this project's real bugs were views quietly answering wrong
// (a new tool flagged as an all-time low; a removed link still winning BEST; a
// $135 misparse becoming the cheapest price). Those are SQL bugs, and only a
// real Postgres can catch them.
//
// Every test runs inside a transaction that is rolled back, so they can't see
// each other's rows and the database ends as it started.

import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { applyMigrations } from './apply-migrations.js';
import { decideAttach } from '../../../supabase/functions/writer/attach.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  // Loud on purpose. A skip here would turn "the DB tests never ran" into a
  // green check — the exact silent-pass this harness exists to prevent.
  throw new Error('DATABASE_URL is required for the DB tests (see .github/workflows/test.yml)');
}

const client = new pg.Client({ connectionString: DATABASE_URL });

before(async () => {
  await client.connect();
  await applyMigrations(client);
});
after(async () => { await client.end(); });

beforeEach(async () => { await client.query('begin'); });
afterEach(async () => { await client.query('rollback'); });

// ---- fixtures -------------------------------------------------------------

const q = async (sql, params) => (await client.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

const seedTool = async (name, extra = {}) =>
  (await one(
    'insert into tools (name, tier, target_price) values ($1, $2, $3) returning id',
    [name, extra.tier ?? 'Tier 1', extra.target_price ?? null],
  )).id;

const seedDealer = async (name) =>
  (await one(
    'insert into dealers (name, base_url) values ($1, $2) returning id',
    [name, `https://${name.toLowerCase().replace(/\s+/g, '')}.example`],
  )).id;

const seedListing = async (toolId, dealerId, url, active = true) =>
  (await one(
    'insert into tool_listings (tool_id, dealer_id, product_url, active, source) values ($1,$2,$3,$4,$5) returning id',
    [toolId, dealerId, url, active, 'manual'],
  )).id;

/** A price snapshot `hoursAgo` in the past. */
const snap = async (listingId, price, { anomaly = false, hoursAgo = 0, inStock = true } = {}) =>
  (await one(
    `insert into price_snapshots (listing_id, price_cad, is_anomaly, in_stock, scraped_at)
     values ($1, $2, $3, $4, now() - make_interval(hours => $5::int)) returning id`,
    [listingId, price, anomaly, inStock, hoursAgo],
  )).id;

const marketStatus = (toolId) =>
  one('select * from tool_market_status where tool_id = $1', [toolId]);

// ---- the migrations themselves --------------------------------------------

test('every migration applied, and the objects the app reads exist', async () => {
  const views = (await q(
    `select table_name from information_schema.views where table_schema = 'public'`,
  )).map((r) => r.table_name).sort();
  assert.deepEqual(views, ['dealer_health', 'listing_latest_price', 'listing_price_stats', 'tool_market_status']);

  const tables = (await q(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`,
  )).map((r) => r.table_name);
  for (const t of ['tools', 'dealers', 'tool_listings', 'price_snapshots', 'scrape_runs', 'app_secrets', 'map_candidates']) {
    assert.ok(tables.includes(t), `missing table: ${t}`);
  }
});

test('0014 really reverted the parked dealer-coverage schema', async () => {
  // 0012/0013 added it and 0014 reverts it — the pair nets to nothing. If a
  // future edit to that history breaks the ordering, the net effect changes.
  const tables = (await q(
    `select table_name from information_schema.tables where table_schema = 'public'`,
  )).map((r) => r.table_name);
  assert.ok(!tables.includes('dealer_catalog'), 'dealer_catalog should be gone after 0014');

  const cols = (await q(
    `select column_name from information_schema.columns where table_name = 'dealers'`,
  )).map((r) => r.column_name);
  assert.ok(!cols.includes('search_source'));
  assert.ok(!cols.includes('platform'));
});

test('the read-only RLS posture survives every migration', async () => {
  // The security model rests on this: the browser's anon key can read and
  // nothing else. A migration that forgot to re-enable RLS would hand anyone
  // with devtools a write path.
  const rows = await q(
    `select relname, relrowsecurity from pg_class
      where relnamespace = 'public'::regnamespace and relkind = 'r'`,
  );
  for (const t of ['tools', 'dealers', 'tool_listings', 'price_snapshots', 'scrape_runs', 'app_secrets', 'map_candidates']) {
    const row = rows.find((r) => r.relname === t);
    assert.ok(row?.relrowsecurity, `RLS should be enabled on ${t}`);
  }
  // app_secrets holds the writer token: RLS on, and deliberately NO policy, so
  // only the service role (which bypasses RLS) can read it.
  const policies = await q(`select policyname from pg_policies where tablename = 'app_secrets'`);
  assert.equal(policies.length, 0, 'app_secrets must have no policy — service role only');
});

// ---- at_all_time_low: a new tool is not a deal -----------------------------

test('one snapshot is NOT an all-time low', async () => {
  // The bug that made Deals flag everything: with a single observation the price
  // IS its own minimum. An all-time low has to mean the price actually dropped.
  const tool = await seedTool('87V Max (single snapshot)');
  const dealer = await seedDealer('Test KMS');
  const listing = await seedListing(tool, dealer, 'https://kms.example/87v');
  await snap(listing, 725.67);

  const s = await marketStatus(tool);
  assert.equal(Number(s.best_price), 725.67);
  assert.equal(s.at_all_time_low, false);
});

test('a price that never moved is NOT an all-time low', async () => {
  const tool = await seedTool('87V Max (flat)');
  const dealer = await seedDealer('Test KMS flat');
  const listing = await seedListing(tool, dealer, 'https://kms.example/87v-flat');
  await snap(listing, 725.67, { hoursAgo: 48 });
  await snap(listing, 725.67, { hoursAgo: 24 });
  await snap(listing, 725.67, { hoursAgo: 0 });

  const s = await marketStatus(tool);
  assert.equal(s.at_all_time_low, false, '725, 725, 725 is the low, but nothing dropped');
});

test('an observed drop IS an all-time low', async () => {
  const tool = await seedTool('87V Max (real drop)');
  const dealer = await seedDealer('Test KMS drop');
  const listing = await seedListing(tool, dealer, 'https://kms.example/87v-drop');
  await snap(listing, 800.00, { hoursAgo: 48 });
  await snap(listing, 725.67, { hoursAgo: 0 });

  const s = await marketStatus(tool);
  assert.equal(s.at_all_time_low, true);
  assert.equal(Number(s.best_price), 725.67);
});

// ---- anomalies stay out of the numbers -------------------------------------

test('a flagged snapshot cannot become the latest price, the low, or BEST', async () => {
  // The myflukestore shape: a $135 warranty add-on read as the product price.
  // It is kept for audit, but it must not touch a single number the app shows.
  const tool = await seedTool('87V Max (anomaly)');
  const dealer = await seedDealer('Test Fluke store');
  const listing = await seedListing(tool, dealer, 'https://fluke.example/87v');
  await snap(listing, 725.67, { hoursAgo: 1 });
  await snap(listing, 135.00, { hoursAgo: 0, anomaly: true }); // newer AND cheaper

  const latest = await one('select * from listing_latest_price where listing_id = $1', [listing]);
  assert.equal(Number(latest.price_cad), 725.67, 'the newest CLEAN price, not the newest row');

  const stats = await one('select * from listing_price_stats where listing_id = $1', [listing]);
  assert.equal(Number(stats.all_time_low), 725.67, 'a bad parse must never become the all-time low');
  assert.equal(Number(stats.snapshot_count), 1, 'flagged rows are excluded from the count');

  const s = await marketStatus(tool);
  assert.equal(Number(s.best_price), 725.67);
  assert.equal(s.at_all_time_low, false, 'and it must not manufacture a deal either');
});

test('a listing whose ONLY price is flagged cannot win BEST', async () => {
  // The cross-dealer gate's job: a link that is wrong every time (an add-on, an
  // accessory, a deposit) looks perfectly stable to a self-comparison, and would
  // otherwise be crowned cheapest forever.
  const tool = await seedTool('87V Max (bad dealer)');
  const good = await seedDealer('Test good dealer');
  const bad = await seedDealer('Test bad dealer');
  const goodListing = await seedListing(tool, good, 'https://good.example/87v');
  const badListing = await seedListing(tool, bad, 'https://bad.example/87v');
  await snap(goodListing, 725.67);
  await snap(badListing, 135.00, { anomaly: true });

  const s = await marketStatus(tool);
  assert.equal(Number(s.best_price), 725.67);
  assert.equal(s.best_dealer, 'Test good dealer');
  assert.equal(Number(s.best_listing_id), Number(goodListing));
});

// ---- removed links stay removed --------------------------------------------

test('an inactive listing never wins BEST, however cheap', async () => {
  // "Hidden rows still counted" (FABLE.md §6): the detail view rendered listings
  // without filtering active, so a removed link stayed visible AND could win.
  const tool = await seedTool('87V Max (removed link)');
  const live = await seedDealer('Test live dealer');
  const gone = await seedDealer('Test removed dealer');
  const liveListing = await seedListing(tool, live, 'https://live.example/87v');
  const deadListing = await seedListing(tool, gone, 'https://gone.example/87v', false);
  await snap(liveListing, 725.67);
  await snap(deadListing, 499.00); // cheaper, but this link is not tracked anymore

  const s = await marketStatus(tool);
  assert.equal(Number(s.best_price), 725.67);
  assert.equal(s.best_dealer, 'Test live dealer');
});

test('an in-stock listing beats a cheaper out-of-stock one', async () => {
  // A price you cannot buy at is not the best price.
  const tool = await seedTool('87V Max (stock)');
  const a = await seedDealer('Test in stock');
  const b = await seedDealer('Test out of stock');
  const inStock = await seedListing(tool, a, 'https://a.example/87v');
  const outOfStock = await seedListing(tool, b, 'https://b.example/87v');
  await snap(inStock, 725.67, { inStock: true });
  await snap(outOfStock, 499.00, { inStock: false });

  const s = await marketStatus(tool);
  assert.equal(Number(s.best_price), 725.67);
  assert.equal(s.in_stock, true);
});

test('target price and the 90-day comparison read off the BEST listing', async () => {
  const tool = await seedTool('87V Max (target)', { target_price: 750 });
  const dealer = await seedDealer('Test target dealer');
  const listing = await seedListing(tool, dealer, 'https://target.example/87v');
  await snap(listing, 800.00, { hoursAgo: 72 });
  await snap(listing, 700.00, { hoursAgo: 0 });

  const s = await marketStatus(tool);
  assert.equal(s.at_or_below_target, true, '700 is under his 750 target');
  assert.equal(Number(s.avg_90d), 750, '(800 + 700) / 2');
  assert.equal(Number(s.pct_vs_avg_90d), -6.7, '700 vs 750');
});

test('a tool with no priced link still appears, with nulls', async () => {
  // The checklist lists what he owns and wants, priced or not — a tool must never
  // vanish just because no dealer answered.
  const tool = await seedTool('Unpriced tool');
  const s = await marketStatus(tool);
  assert.ok(s, 'the tool row must still be there');
  assert.equal(s.best_price, null);
  assert.equal(s.at_all_time_low, false);
  assert.equal(s.at_or_below_target, false);
});

// ---- the attachListing() contract, against the real constraint --------------

/** Mirror of the writer's attachListing(), over SQL instead of PostgREST. */
async function attachViaSql(toolId, dealerId, url) {
  const existing = await one(
    'select id, tool_id, active from tool_listings where dealer_id = $1 and product_url = $2',
    [dealerId, url],
  );
  const d = decideAttach(existing, toolId);
  if (d.state === 'conflict' || d.state === 'already') return d;
  if (d.state === 'revived') {
    await client.query('update tool_listings set active = true where id = $1', [d.id]);
    return d;
  }
  const created = await one(
    `insert into tool_listings (tool_id, dealer_id, product_url, active, source)
     values ($1, $2, $3, true, 'manual') returning id`,
    [toolId, dealerId, url],
  );
  return { state: 'added', id: created.id };
}

test('attach: the unique key really is (dealer_id, product_url)', async () => {
  // decideAttach's whole reason for existing is this constraint. If the schema
  // ever stopped enforcing it, the "one link lives in one place" rule would be
  // a comment rather than a fact.
  const tool = await seedTool('Attach: constraint');
  const dealer = await seedDealer('Test attach dealer');
  await seedListing(tool, dealer, 'https://attach.example/87v');
  await assert.rejects(
    () => seedListing(tool, dealer, 'https://attach.example/87v'),
    /duplicate key|unique/i,
  );
});

test('attach: add, then re-add is a no-op', async () => {
  const tool = await seedTool('Attach: re-add');
  const dealer = await seedDealer('Test re-add dealer');
  const url = 'https://readd.example/87v';

  const first = await attachViaSql(tool, dealer, url);
  assert.equal(first.state, 'added');

  const second = await attachViaSql(tool, dealer, url);
  assert.equal(second.state, 'already');
  assert.equal(Number(second.id), Number(first.id), 'same row, not a duplicate');

  const rows = await q('select id from tool_listings where dealer_id = $1 and product_url = $2', [dealer, url]);
  assert.equal(rows.length, 1);
});

test('attach: a removed link comes BACK, with its price history', async () => {
  const tool = await seedTool('Attach: revive');
  const dealer = await seedDealer('Test revive dealer');
  const url = 'https://revive.example/87v';

  const added = await attachViaSql(tool, dealer, url);
  await snap(added.id, 725.67);
  await client.query('update tool_listings set active = false where id = $1', [added.id]); // he removes it

  const again = await attachViaSql(tool, dealer, url);
  assert.equal(again.state, 'revived');
  assert.equal(Number(again.id), Number(added.id));

  const row = await one('select active from tool_listings where id = $1', [added.id]);
  assert.equal(row.active, true);
  const s = await marketStatus(tool);
  assert.equal(Number(s.best_price), 725.67, 'the old prices came back with it');
});

test('attach: a link is NEVER moved to another tool', async () => {
  const toolA = await seedTool('Attach: tool A');
  const toolB = await seedTool('Attach: tool B');
  const dealer = await seedDealer('Test conflict dealer');
  const url = 'https://conflict.example/87v';

  const added = await attachViaSql(toolA, dealer, url);
  await snap(added.id, 725.67);

  const moved = await attachViaSql(toolB, dealer, url);
  assert.equal(moved.state, 'conflict', 'B must be told, not served');

  const row = await one('select tool_id, active from tool_listings where id = $1', [added.id]);
  assert.equal(Number(row.tool_id), Number(toolA), 'the link stayed on tool A');

  const b = await marketStatus(toolB);
  assert.equal(b.best_price, null, "and A's price history did not follow it to B");
});

test('attach: a removed link belonging to another tool is still a conflict', async () => {
  // The subtle one: "removed" is not "free". Reviving it onto B would be exactly
  // the silent move we refuse to make.
  const toolA = await seedTool('Attach: inactive tool A');
  const toolB = await seedTool('Attach: inactive tool B');
  const dealer = await seedDealer('Test inactive conflict dealer');
  const url = 'https://inactive-conflict.example/87v';

  const added = await attachViaSql(toolA, dealer, url);
  await client.query('update tool_listings set active = false where id = $1', [added.id]);

  const moved = await attachViaSql(toolB, dealer, url);
  assert.equal(moved.state, 'conflict');

  const row = await one('select tool_id, active from tool_listings where id = $1', [added.id]);
  assert.equal(Number(row.tool_id), Number(toolA));
  assert.equal(row.active, false, 'and it stays removed');
});
