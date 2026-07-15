-- Auto-mapping support: track per-tool mapping state + record search candidates.
alter table tools add column if not exists auto_map_state text; -- null=unprocessed, 'no_sku', 'mapped', 'review'

create table if not exists map_candidates (
  id         bigint generated always as identity primary key,
  tool_id    bigint not null references tools(id) on delete cascade,
  dealer_id  bigint not null references dealers(id) on delete cascade,
  sku        text,
  url        text not null,
  title      text,
  confident  boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tool_id, dealer_id, url)
);
create index if not exists map_candidates_tool_idx on map_candidates(tool_id);

alter table map_candidates enable row level security;
create policy "anon read map_candidates" on map_candidates for select to anon, authenticated using (true);
