-- Blackbird Tool Price Tracker — initial schema
-- Applied to project ssfhjhbarkpgbelnbcun on 2026-07-12.
-- Tables: tools, dealers, tool_listings, price_snapshots, scrape_runs
-- Views:  listing_latest_price, listing_price_stats, tool_market_status, dealer_health
-- RLS:    anon/authenticated read-only; writes via service_role (bypasses RLS)

create table if not exists dealers (
  id             bigint generated always as identity primary key,
  name           text not null unique,
  base_url       text not null,
  scraper_status text not null default 'active'
                 check (scraper_status in ('active','paused','broken','beta')),
  created_at     timestamptz not null default now()
);

create table if not exists tools (
  id            bigint generated always as identity primary key,
  name          text not null,
  brand         text,
  model_number  text,
  category      text,
  tier          text,
  target_price  numeric(10,2),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists tools_brand_model_uidx
  on tools (lower(coalesce(brand,'')), lower(coalesce(model_number,'')))
  where model_number is not null;

create table if not exists tool_listings (
  id           bigint generated always as identity primary key,
  tool_id      bigint not null references tools(id) on delete cascade,
  dealer_id    bigint not null references dealers(id) on delete cascade,
  product_url  text not null,
  sku          text,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (dealer_id, product_url)
);
create index if not exists tool_listings_tool_idx   on tool_listings (tool_id);
create index if not exists tool_listings_dealer_idx on tool_listings (dealer_id);

create table if not exists price_snapshots (
  id                 bigint generated always as identity primary key,
  listing_id         bigint not null references tool_listings(id) on delete cascade,
  price_cad          numeric(10,2),
  regular_price_cad  numeric(10,2),
  on_sale            boolean,
  in_stock           boolean,
  scraped_at         timestamptz not null default now()
);
create index if not exists price_snapshots_listing_time_idx
  on price_snapshots (listing_id, scraped_at desc);

create table if not exists scrape_runs (
  id          bigint generated always as identity primary key,
  dealer_id   bigint references dealers(id) on delete set null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok_count    integer not null default 0,
  fail_count  integer not null default 0,
  error_log   jsonb not null default '[]'::jsonb
);
create index if not exists scrape_runs_dealer_time_idx
  on scrape_runs (dealer_id, started_at desc);

create or replace view listing_latest_price with (security_invoker = true) as
select distinct on (ps.listing_id)
  ps.listing_id, ps.price_cad, ps.regular_price_cad, ps.on_sale, ps.in_stock, ps.scraped_at
from price_snapshots ps
order by ps.listing_id, ps.scraped_at desc;

create or replace view listing_price_stats with (security_invoker = true) as
select
  listing_id,
  avg(price_cad) filter (where scraped_at >= now() - interval '90 days') as avg_90d,
  min(price_cad) filter (where scraped_at >= now() - interval '90 days') as low_90d,
  min(price_cad) as all_time_low,
  count(*)       as snapshot_count
from price_snapshots
group by listing_id;

create or replace view tool_market_status with (security_invoker = true) as
with active_listings as (
  select
    tl.id as listing_id, tl.tool_id, tl.dealer_id, tl.product_url,
    d.name as dealer_name,
    llp.price_cad, llp.regular_price_cad, llp.on_sale, llp.in_stock, llp.scraped_at,
    lps.avg_90d, lps.low_90d, lps.all_time_low, lps.snapshot_count
  from tool_listings tl
  join dealers d on d.id = tl.dealer_id
  left join listing_latest_price  llp on llp.listing_id = tl.id
  left join listing_price_stats   lps on lps.listing_id = tl.id
  where tl.active = true
),
best as (
  select distinct on (tool_id) *
  from active_listings
  where price_cad is not null
  order by tool_id, (coalesce(in_stock, true)) desc, price_cad asc
)
select
  t.id as tool_id, t.name, t.brand, t.model_number, t.category, t.tier, t.target_price,
  b.listing_id  as best_listing_id,
  b.dealer_id   as best_dealer_id,
  b.dealer_name as best_dealer,
  b.product_url as best_url,
  b.price_cad   as best_price,
  b.regular_price_cad, b.on_sale, b.in_stock,
  b.scraped_at  as best_scraped_at,
  b.avg_90d, b.all_time_low, b.snapshot_count,
  case when b.avg_90d is not null and b.avg_90d > 0
       then round(((b.price_cad - b.avg_90d) / b.avg_90d) * 100, 1) end as pct_vs_avg_90d,
  case when b.all_time_low is not null and b.price_cad is not null
            and b.price_cad <= b.all_time_low then true else false end   as at_all_time_low,
  case when t.target_price is not null and b.price_cad is not null
            and b.price_cad <= t.target_price then true else false end   as at_or_below_target
from tools t
left join best b on b.tool_id = t.id;

create or replace view dealer_health with (security_invoker = true) as
select distinct on (d.id)
  d.id as dealer_id, d.name, d.scraper_status,
  sr.started_at as last_run_at, sr.finished_at, sr.ok_count, sr.fail_count, sr.error_log
from dealers d
left join scrape_runs sr on sr.dealer_id = d.id
order by d.id, sr.started_at desc nulls last;

alter table dealers         enable row level security;
alter table tools           enable row level security;
alter table tool_listings   enable row level security;
alter table price_snapshots enable row level security;
alter table scrape_runs     enable row level security;

create policy "anon read dealers"         on dealers         for select to anon, authenticated using (true);
create policy "anon read tools"           on tools           for select to anon, authenticated using (true);
create policy "anon read tool_listings"   on tool_listings   for select to anon, authenticated using (true);
create policy "anon read price_snapshots" on price_snapshots for select to anon, authenticated using (true);
create policy "anon read scrape_runs"     on scrape_runs     for select to anon, authenticated using (true);

grant select on listing_latest_price, listing_price_stats, tool_market_status, dealer_health
  to anon, authenticated;

insert into dealers (name, base_url, scraper_status) values
  ('Princess Auto',    'https://www.princessauto.com', 'active'),
  ('KMS Tools',        'https://www.kmstools.com',     'active'),
  ('Home Depot Canada','https://www.homedepot.ca',     'active'),
  ('Canadian Tire',    'https://www.canadiantire.ca',  'beta'),
  ('Amazon.ca',        'https://www.amazon.ca',        'beta')
on conflict (name) do nothing;
