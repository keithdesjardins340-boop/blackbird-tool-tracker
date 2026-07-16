// Read every row, not the first 1000 of them.
//
// The Supabase Data API caps each response at 1000 rows and does it SILENTLY —
// no error, no flag, just fewer rows than exist. Any query whose result grows
// with the tool list will cross that line one day and start returning a
// confident, partial answer. That's the bug shape this project keeps meeting.
//
// Use this for reads that scale. For reads where only the newest rows matter,
// prefer `.order(..., {ascending: false}).limit(n)` instead — then a truncation
// drops the OLDEST rows, which is the harmless end to lose.

/** PostgREST's page size. Matches the project's "Max rows" setting. */
export const PAGE = 1000;

/**
 * Run a query repeatedly, walking `.range()` until a short page says it's done.
 *
 * `makeQuery()` must build a FRESH query each call (a Supabase builder can only
 * be executed once) and MUST impose a stable `.order(...)` — without one,
 * Postgres may return rows in a different order per page, so ranges could skip
 * or duplicate rows and the "bug" would look like flaky data.
 *
 *   const rows = await fetchAll(() => supabase.from('tool_listings')
 *     .select('id, dealer:dealers(name)').eq('active', true).order('id'));
 */
export async function fetchAll(makeQuery, { page = PAGE } = {}) {
  const out = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await makeQuery().range(from, from + page - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < page) return out; // short page = last page
  }
}
