-- Price correctness: tag snapshots we don't trust (bad parse — non-positive or
-- wildly off the listing's recent median) so one bad scrape can't poison the
-- 90-day average / all-time-low / latest-price that the Deals tab keys on.
-- Anomalies are still recorded (for audit) but excluded from every stats view.
alter table price_snapshots add column if not exists currency   text default 'CAD';
alter table price_snapshots add column if not exists is_anomaly boolean not null default false;

create index if not exists price_snapshots_clean_idx
  on price_snapshots (listing_id, scraped_at desc) where is_anomaly = false;

create or replace view listing_latest_price with (security_invoker = true) as
select distinct on (ps.listing_id)
  ps.listing_id, ps.price_cad, ps.regular_price_cad, ps.on_sale, ps.in_stock, ps.scraped_at
from price_snapshots ps
where ps.is_anomaly = false
order by ps.listing_id, ps.scraped_at desc;

create or replace view listing_price_stats with (security_invoker = true) as
select
  listing_id,
  avg(price_cad) filter (where scraped_at >= now() - interval '90 days') as avg_90d,
  min(price_cad) filter (where scraped_at >= now() - interval '90 days') as low_90d,
  min(price_cad) as all_time_low,
  count(*)       as snapshot_count
from price_snapshots
where is_anomaly = false
group by listing_id;
