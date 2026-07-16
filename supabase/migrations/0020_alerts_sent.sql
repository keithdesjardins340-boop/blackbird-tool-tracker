-- Remember which alerts already went out, so the phone stays worth listening to.
--
-- Without this, every run re-announces the same deal twice a day until the price
-- moves. An alert you learn to swipe away is worse than no alert — it trains him
-- to ignore the one that matters, which is the whole point of the feature.
--
-- Re-alerting for a tool only happens when the news is actually new: the price
-- dropped a further ≥2%, or 14 days have passed (see ALERT_* in alerts.js).
--
-- `kind` separates the two reasons a tool can be worth shouting about — hitting
-- his target price is a different event from a big drop, and one shouldn't
-- suppress the other.
--
-- No RLS policy on purpose: nothing in the browser reads this. Same shape as
-- app_secrets and fx_rates — the scraper writes it with the service role.

create table if not exists alerts_sent (
  id        bigint generated always as identity primary key,
  tool_id   bigint not null references tools(id) on delete cascade,
  kind      text   not null check (kind in ('target', 'deal')),
  price_cad numeric(10,2) not null,
  sent_at   timestamptz not null default now()
);

-- The hot query: "what did we last say about this tool, for this reason?"
create index if not exists alerts_sent_tool_kind_idx on alerts_sent (tool_id, kind, sent_at desc);

alter table alerts_sent enable row level security;
