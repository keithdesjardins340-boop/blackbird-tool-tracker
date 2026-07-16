-- Record the buy, not just the tick.
--
-- He's outfitting a service truck for a business: what he paid and where is a
-- capex record he currently has to keep somewhere else, and the moment he knows
-- it is the moment he ticks the tool off. `owned` alone throws that away.
--
-- It also makes the checklist's progress honest. "12 / 87 have" says nothing
-- about money; "spent $4,210 · remaining ≈ $18,900 at today's best" is the
-- number he actually plans around.
--
-- All three columns are NULLABLE and stay null when he taps Skip — the two-field
-- confirm is optional by design. A checkmark must never become a form he has to
-- fill in to tick a tool off in a parts aisle.
--
-- purchase_listing_id is ON DELETE SET NULL, not CASCADE: deleting a dealer link
-- must not erase the fact that he bought the tool. The price and date survive;
-- only the pointer to where goes.

alter table tools add column if not exists purchase_price_cad numeric(10,2);
alter table tools add column if not exists purchased_at       timestamptz;
alter table tools add column if not exists purchase_listing_id bigint
  references tool_listings(id) on delete set null;

-- The checklist's money view sums purchases per tier; it reads owned+priced rows.
create index if not exists tools_purchased_idx on tools (purchased_at) where purchased_at is not null;

-- Surface the purchase on the dashboard's main read. Appended LAST so
-- CREATE OR REPLACE keeps the existing column order; security_invoker restated
-- because replacing a view resets it.
create or replace view tool_market_status with (security_invoker = true) as
  with active_listings as (
    select tl.id as listing_id, tl.tool_id, tl.dealer_id, tl.product_url, tl.source,
           d.name as dealer_name,
           llp.price_cad, llp.regular_price_cad, llp.on_sale, llp.in_stock, llp.scraped_at,
           llp.parse_via,
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
         case when b.all_time_low is not null and b.price_cad is not null
                   and b.price_cad <= b.all_time_low
                   and b.all_time_high > b.all_time_low
              then true else false
         end as at_all_time_low,
         case when t.target_price is not null and b.price_cad is not null
                   and b.price_cad <= t.target_price
              then true else false
         end as at_or_below_target,
         t.notes, t.owned, t.quantity, t.pn, b.source as best_source,
         -- What he actually paid, and where (null until he records it).
         t.purchase_price_cad, t.purchased_at, t.purchase_listing_id,
         pd.name as purchase_dealer
    from tools t
    left join best b on b.tool_id = t.id
    left join tool_listings pl on pl.id = t.purchase_listing_id
    left join dealers pd on pd.id = pl.dealer_id;
