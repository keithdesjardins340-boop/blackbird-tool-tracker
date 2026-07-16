// Apply every migration, in order, to a bare Postgres.
//
// This is half the value of the DB test layer on its own: the migrations only
// ever ran against the live Supabase project, so a syntax error or a bad
// dependency between two of them was something you found in production. Here
// they run from empty on every push.
//
// Supabase provides the `anon` / `authenticated` / `service_role` roles that the
// RLS policies and grants reference; a stock postgres:16 does not, so we create
// them first. That's the ONLY thing this fakes — the migrations themselves run
// exactly as written, unedited.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

const BOOTSTRAP_ROLES = `
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;
`;

/** Migration filenames in applied order (0001, 0002, …). */
export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // zero-padded numeric prefixes, so lexical order IS applied order
}

/** Create the Supabase roles, then run every migration in order. */
export async function applyMigrations(client) {
  await client.query(BOOTSTRAP_ROLES);
  const files = migrationFiles();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    try {
      await client.query(sql);
    } catch (e) {
      // Name the file — "syntax error at or near" with no filename is a bad hour.
      throw new Error(`migration ${f} failed to apply: ${e.message}`);
    }
  }
  return files;
}
