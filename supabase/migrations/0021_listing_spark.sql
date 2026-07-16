-- Sparklines that keep working as the list grows.
--
-- The dashboard built its sparklines by downloading 90 days of raw snapshots for
-- every priced tool and grouping them in JS. Two problems, both getting worse:
--
-- 1. **The Data API caps every response at 1000 rows** (Supabase's "Max rows"
--    setting) and does it SILENTLY — no error, just fewer rows. At two scrapes a
--    day a listing accrues ~180 snapshots in 90 days, so the query blew the cap at
--    about SIX priced tools. Worse, it ordered `scraped_at.asc`, so the rows lost
--    were the NEWEST: sparklines would have quietly stopped short of today, on a
--    list heading for ~295 tools. Exactly the shape this project keeps getting
--    bitten by — a confident picture that isn't current.
-- 2. It shipped ~53,000 rows to a phone to draw a few 96px charts, most of them
--    off-screen (the cards draw lazily now, the data didn't).
--
-- One row per listing with a small array fixes both: 295 rows instead of 53,000,
-- comfortably under the cap, and a payload measured in kilobytes.
--
-- 30 points is more than a 96px sparkline can resolve; is_anomaly stays excluded
-- because a flagged $135 add-on is a parser mistake, not price history.

create or replace view listing_spark with (security_invoker = true) as
select listing_id,
       -- Chronological for drawing, even though the window picks the newest.
       array_agg(price_cad order by scraped_at) as prices
  from (
    select listing_id, price_cad, scraped_at,
           row_number() over (partition by listing_id order by scraped_at desc) as rn
      from price_snapshots
     where is_anomaly = false
       and scraped_at >= now() - interval '90 days'
  ) recent
 where rn <= 30
 group by listing_id;

grant select on listing_spark to anon, authenticated;
