-- Dealer catalog cache (plan item 3.2) — the DB-backed product index that lets
-- the `catalog` search source auto-map tools with ZERO live search requests.
--
-- catalog-sync.js pages a Shopify store's public /products.json (≤1 req/sec,
-- weekly) and upserts one row per product here. auto-map's `catalog` source then
-- queries THIS table (not the dealer) for both the SKU and description paths.
--
-- One row per product URL (unique dealer_id,url). For multi-variant products we
-- store the representative (available-or-first) variant's sku + price, which is
-- what the shopify pricing adapter reads too — consistent by construction.
create table if not exists dealer_catalog (
  id          bigint generated always as identity primary key,
  dealer_id   bigint not null references dealers(id) on delete cascade,
  url         text   not null,
  title       text,
  vendor      text,
  sku         text,
  -- Normalized SKU for the includes-match auto-map uses (mirrors sku.js normSku:
  -- lowercase, strip non-alphanumerics). Generated so it can never drift from the
  -- raw sku. Handles dealer-prefixed SKUs (MPR "AUL-MV400" → "aulmv400" still
  -- contains a manufacturer "mv400").
  sku_norm    text generated always as (lower(regexp_replace(coalesce(sku, ''), '[^a-zA-Z0-9]+', '', 'g'))) stored,
  price       numeric,
  available   boolean,
  fetched_at  timestamptz not null default now(),
  unique (dealer_id, url)
);

-- Trigram indexes make the source's `ilike '%needle%'` lookups index-accelerated
-- (leading-wildcard, so a btree wouldn't help) on both the SKU and title paths.
create extension if not exists pg_trgm;
create index if not exists dealer_catalog_sku_norm_trgm on dealer_catalog using gin (sku_norm gin_trgm_ops);
create index if not exists dealer_catalog_title_trgm    on dealer_catalog using gin (title gin_trgm_ops);
create index if not exists dealer_catalog_dealer        on dealer_catalog (dealer_id);
