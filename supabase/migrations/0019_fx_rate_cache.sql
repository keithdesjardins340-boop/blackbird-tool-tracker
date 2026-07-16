-- Remember the last good exchange rate, so a Valet hiccup costs less.
--
-- Today every non-CAD price in a run is rejected if the Bank of Canada's API is
-- unreachable for those few seconds. That's the right instinct (a wrong price is
-- worse than no price) but a blunt version of it: yesterday's official rate is a
-- far better answer than nothing, and nothing like a guess.
--
-- So fail-closed STAYS. This only narrows what "closed" costs: from "we lost
-- this run's USD prices" to "we used a rate from yesterday, and the snapshot
-- says so". The stored fx_rate keeps the audit contract intact either way —
-- price_original + fx_rate always describe how that number was reached.
--
-- Beyond FX_MAX_AGE_DAYS (7) we still reject. A week-old rate on a $900 meter is
-- a few dollars of drift; a month-old one during a currency move is the ~40%
-- error this whole subsystem exists to prevent, wearing a different hat.
--
-- No RLS policy on purpose: nothing in the browser reads this. The scraper and
-- the writer use the service role (which bypasses RLS), and a table with RLS on
-- and no policy is unreadable to the anon key — the same shape as app_secrets.

create table if not exists fx_rates (
  currency   text primary key,
  rate       numeric(12,6) not null check (rate > 0),
  as_of      timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table fx_rates enable row level security;
