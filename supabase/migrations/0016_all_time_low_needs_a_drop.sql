-- A newly added tool is not a deal.
--
-- at_all_time_low was `price <= all_time_low`. With one snapshot the price IS its
-- own all-time low, so every tool landed in Deals the moment it was added — and a
-- Deals tab that flags everything says nothing. Same for a price that has never
-- moved (725, 725, 725): it's the low, but nothing dropped.
--
-- An all-time low only means something if the price has actually been HIGHER at
-- some point, so it now requires all_time_high > all_time_low — i.e. a real drop
-- that the scraper observed. Fixing it in the view fixes every reader at once
-- (dashboard Deals tab, the deals count, and the run report).
--
-- all_time_high is appended LAST so CREATE OR REPLACE keeps the existing column
-- order; security_invoker is restated because replacing a view resets options.

create or replace view listing_price_stats with (security_invoker = true) as
  select listing_id,
         avg(price_cad) filter (where scraped_at >= (now() - '90 days'::interval)) as avg_90d,
         min(price_cad) filter (where scraped_at >= (now() - '90 days'::interval)) as low_90d,
         min(price_cad) as all_time_low,
         count(*) as snapshot_count,
         max(price_cad) as all_time_high
    from price_snapshots
   where is_anomaly = false
   group by listing_id;

create or replace view tool_market_status with (security_invoker = true) as
  with active_listings as (
    select tl.id as listing_id, tl.tool_id, tl.dealer_id, tl.product_url, tl.source,
           d.name as dealer_name,
           llp.price_cad, llp.regular_price_cad, llp.on_sale, llp.in_stock, llp.scraped_at,
           lps.avg_90d, lps.low_90d, lps.all_time_low, lps.all_time_high, lps.snapshot_count
      from tool_listings tl
      join dealers d on d.id = tl.dealer_id
      left join listing_latest_price llp on llp.listing_id = tl.id
      left join listing_price_stats lps on lps.listing_id = tl.id
     where tl.active = true
  ), best as (
    select distinct on (al.tool_id)
           al.listing_id, al.tool_id, al.dealer_id, al.product_url, al.source, al.dealer_name,
           al.price_cad, al.regular_price_cad, al.on_sale, al.in_stock, al.scraped_at,
           al.avg_90d, al.low_90d, al.all_time_low, al.all_time_high, al.snapshot_count
      from active_listings al
     where al.price_cad is not null
     order by al.tool_id, (coalesce(al.in_stock, true)) desc, al.price_cad
  )
  select t.id as tool_id, t.name, t.brand, t.model_number, t.category, t.tier, t.target_price,
         b.listing_id as best_listing_id, b.dealer_id as best_dealer_id, b.dealer_name as best_dealer,
         b.product_url as best_url, b.price_cad as best_price, b.regular_price_cad, b.on_sale,
         b.in_stock, b.scraped_at as best_scraped_at, b.avg_90d, b.all_time_low, b.snapshot_count,
         case when b.avg_90d is not null and b.avg_90d > 0::numeric
              then round((b.price_cad - b.avg_90d) / b.avg_90d * 100::numeric, 1)
         end as pct_vs_avg_90d,
         -- Only a low if it's lower than this listing has actually been before.
         case when b.all_time_low is not null and b.price_cad is not null
                   and b.price_cad <= b.all_time_low
                   and b.all_time_high > b.all_time_low
              then true else false
         end as at_all_time_low,
         case when t.target_price is not null and b.price_cad is not null
                   and b.price_cad <= t.target_price
              then true else false
         end as at_or_below_target,
         t.notes, t.owned, t.quantity, t.pn, b.source as best_source
    from tools t
    left join best b on b.tool_id = t.id;
