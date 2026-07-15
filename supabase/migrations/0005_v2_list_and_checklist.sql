-- v2 master list fields + the "owned / have it" checkmark (synced via service key).
alter table tools add column if not exists pn       text;
alter table tools add column if not exists quantity integer;
alter table tools add column if not exists owned    boolean not null default false;

-- Expose the new fields to the dashboard view (append-only for CREATE OR REPLACE).
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
  select distinct on (tool_id) * from active_listings
  where price_cad is not null
  order by tool_id, (coalesce(in_stock, true)) desc, price_cad asc
)
select
  t.id as tool_id, t.name, t.brand, t.model_number, t.category, t.tier, t.target_price,
  b.listing_id as best_listing_id, b.dealer_id as best_dealer_id, b.dealer_name as best_dealer,
  b.product_url as best_url, b.price_cad as best_price,
  b.regular_price_cad, b.on_sale, b.in_stock, b.scraped_at as best_scraped_at,
  b.avg_90d, b.all_time_low, b.snapshot_count,
  case when b.avg_90d is not null and b.avg_90d > 0
       then round(((b.price_cad - b.avg_90d) / b.avg_90d) * 100, 1) end as pct_vs_avg_90d,
  case when b.all_time_low is not null and b.price_cad is not null
            and b.price_cad <= b.all_time_low then true else false end   as at_all_time_low,
  case when t.target_price is not null and b.price_cad is not null
            and b.price_cad <= t.target_price then true else false end   as at_or_below_target,
  t.notes, t.owned, t.quantity, t.pn
from tools t
left join best b on b.tool_id = t.id;

grant select on tool_market_status to anon, authenticated;
