-- Write-proxy support: a service-role-only secrets table holding the dashboard's
-- writer token. The `writer` Edge Function reads this with the service role to
-- authorize write requests, so the browser never holds the service_role key.
-- RLS is enabled with NO policies → anon/authenticated cannot read it; only the
-- service role (which bypasses RLS) can. The token VALUE is inserted out-of-band
-- (never committed to the repo).
create table if not exists app_secrets (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table app_secrets enable row level security;
