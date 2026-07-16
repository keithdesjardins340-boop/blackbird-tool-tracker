-- A stale captured price must not hold the BEST tag.
--
-- Scraped prices refresh twice a day. Bookmarklet captures (Canadian Tire,
-- Amazon — the dealers CI can't reach) only refresh when he sweeps them by hand.
-- So a three-week-old capture of $499 can sit there beating today's real $520,
-- and the app confidently points him at a price that may not exist any more.
--
-- That's the currency bug's shape again: a number that LOOKS authoritative but
-- isn't current. Same answer, too — don't guess, and don't quietly drop it:
-- the listing stays visible (with its age, and a nudge to recapture), it just
-- stops being allowed to win BEST.
--
-- Only MANUAL captures are aged out, deliberately. A scraped price that's 21 days
-- old means the scraper is failing, which is a different problem with its own
-- signal (the run report's "unpriced links"); silently hiding it here would just
-- mask that.
--
-- The 21 days must match STALE_MANUAL_DAYS in web/js/constants.js. SQL can't
-- import a JS constant, so a DB test asserts the two agree rather than trusting
-- this comment (two copies of a threshold is exactly how they drift).

-- parse_via is appended LAST so CREATE OR REPLACE keeps the existing column
-- order; security_invoker is restated because replacing a view resets options.
create or replace view listing_latest_price with (security_invoker = true) as
select distinct on (ps.listing_id)
  ps.listing_id, ps.price_cad, ps.regular_price_cad, ps.on_sale, ps.in_stock, ps.scraped_at,
  ps.parse_via
from price_snapshots ps
where ps.is_anomaly = false
order by ps.listing_id, ps.scraped_at desc;

create or replace view tool_market_status with (security_invoker = true) as
  with active_listings as (
    select tl.id as listing_id, tl.tool_id, tl.dealer_id, tl.product_url, tl.source,
           d.name as dealer_name,
           llp.price_cad, llp.regular_price_cad, llp.on_sale, llp.in_stock, llp.scraped_at,
           llp.parse_via,
           -- Captured by hand AND old enough that we can't stand behind it.
           (llp.parse_via = 'manual-capture'
            and llp.scraped_at < now() - interval '21 days') as stale_manual,
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
       -- The guard. `is not true` (not `= false`) because stale_manual is NULL
       -- for a listing with no price yet, and NULL would drop the row silently.
       and al.stale_manual is not true
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
