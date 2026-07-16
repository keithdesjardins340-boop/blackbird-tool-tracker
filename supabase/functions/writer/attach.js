// The decision half of attachListing(), split out from index.ts so it can be
// tested. Plain .js with no imports on purpose: Deno imports it from index.ts,
// and Node's test runner imports the same file by relative path — one copy, so
// the rule under test is the rule that ships.
//
// The rule: the unique key is (dealer_id, product_url), so a link lives in
// exactly ONE place. Given the row that already holds this (dealer, url) — or
// nothing — decide what to do, without touching the database:
//
//   added    no such link yet                      → insert it
//   already  this tool's link, still active        → no-op
//   revived  this tool's link, previously removed  → set active = true
//   conflict the link belongs to a DIFFERENT tool  → refuse, report it
//
// "conflict" is the load-bearing case: silently moving a link to another tool
// would take its price history with it. And `revived` exists because an
// upsert(…ignoreDuplicates) once made removed links un-re-addable — the row was
// still there with active=false, so the insert quietly did nothing.
//
// @param existing  the (dealer_id, product_url) row, or null/undefined
// @param toolId    the tool we're attaching to
// @returns {{state: 'added'|'already'|'revived'|'conflict', id: number|null}}
export function decideAttach(existing, toolId) {
  if (!existing) return { state: 'added', id: null };
  // Loose compare: ids arrive as bigint-strings from PostgREST, numbers elsewhere.
  if (String(existing.tool_id) !== String(toolId)) return { state: 'conflict', id: existing.id };
  if (existing.active) return { state: 'already', id: existing.id };
  return { state: 'revived', id: existing.id };
}
