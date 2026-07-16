-- Deal discovery: a review inbox of candidate cheaper listings.
--
-- These rows are LEADS, not listings. Nothing here touches tool_listings, BEST,
-- the checklist or the money line until he accepts one — and accepting routes
-- through the ordinary add-a-link path, so the price is established by the
-- generic adapter and fail-closed FX exactly like a link he pasted himself.
--
-- `price_seen` is what Google Shopping showed. It is UNVERIFIED and deliberately
-- never enters price_snapshots: gl=ca usually quotes CAD but does not guarantee
-- it, and an unverified number that looks authoritative is this project's oldest
-- bug (FABLE.md §6). The dashboard shows it as "~$X, unverified" for that reason.
--
-- This is NOT the parked auto-map. It never attaches anything on its own, and it
-- lives behind its own repo variable (ENABLE_DISCOVERY), so a noisy run is one
-- toggle away from off.

create table if not exists public.discovery_suggestions (
  id             bigint generated always as identity primary key,
  tool_id        bigint not null references public.tools(id) on delete cascade,
  source         text   not null default 'serpapi_shopping',
  merchant       text   not null,   -- the shopping result's merchant/source name
  title          text,              -- candidate title; the matcher's audit trail
  candidate_url  text   not null,
  price_seen     numeric,           -- UNVERIFIED. Never trusted, never a snapshot.
  currency_seen  text,              -- what we THINK it was; audit only
  second_hand    boolean not null default false,
  status         text   not null default 'pending'
                   check (status in ('pending','accepted','dismissed')),
  seen_at        timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  -- Idempotent re-runs: the same lead re-seen next week refreshes rather than
  -- duplicating. This is also what lets a dismissal STICK (see the job).
  unique (tool_id, candidate_url)
);

create index if not exists discovery_suggestions_pending_idx
  on public.discovery_suggestions (tool_id, seen_at desc)
  where status = 'pending';

-- Let him pin an exact search string per tool. Null = use the tool name.
-- A precise query is the cheapest possible noise filter.
alter table public.tools add column if not exists discovery_query text;

-- Rotation. The free SerpApi tier buys ~200 searches/month, so a run can only
-- cover a slice of a 295-tool list. Without this the job would re-search the
-- same arbitrary 40 tools forever and never look at the rest — searching in
-- least-recently-searched order is what makes the budget cover everything,
-- just slowly.
alter table public.tools add column if not exists discovery_searched_at timestamptz;
create index if not exists tools_discovery_rotation_idx
  on public.tools (discovery_searched_at nulls first);

-- RLS: anon reads pending leads (the dashboard inbox); every write goes through
-- the writer function or the service-role job, like every other write here.
alter table public.discovery_suggestions enable row level security;

create policy "anon read discovery_suggestions"
  on public.discovery_suggestions for select to anon, authenticated using (true);

create or replace view public.discovery_inbox
with (security_invoker = true) as
select s.id, s.tool_id, t.name as tool_name, s.merchant, s.title, s.candidate_url,
       s.price_seen, s.currency_seen, s.second_hand, s.seen_at
  from public.discovery_suggestions s
  join public.tools t on t.id = s.tool_id
 where s.status = 'pending'
 order by s.seen_at desc;

grant select on public.discovery_inbox to anon, authenticated;
