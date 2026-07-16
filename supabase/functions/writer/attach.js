// The decision half of attachListing(), split out from index.ts so it can be
// tested. Plain .js with no imports on purpose: Deno imports it from index.ts,
// and Node's test runner imports the same file by relative path — one copy, so
// the rule under test is the rule that ships.
//
// The rule: the unique key is (dealer_id, product_url), so a link lives in
// exactly ONE place. Given the row that already holds this (dealer, url) — or
// nothing — decide what to do, without touching the database:
//
//   added    no such link yet                         → insert it
//   already  this tool's link, still active           → no-op
//   revived  this tool's link, previously removed     → set active = true
//   adopt    another tool's REMOVED link              → move it here, reactivate
//   conflict another tool's LIVE link                 → refuse, report it
//
// The line between `adopt` and `conflict` is the whole point, and it took a real
// mis-paste to find it:
//
//   Keith pasted a link onto the wrong tool, removed it, and tried to put it on
//   the right one — and the app told him it was "already tracked under a
//   different tool". A mistake he had already undone was unfixable through the
//   UI, with no way out except the SQL editor.
//
// The original rule refused ANY cross-tool attach, to stop a link being silently
// yanked from one tool to another and dragging its price history with it. That's
// still right while the link is LIVE somewhere — taking it would be stealing.
// But a REMOVED link is unclaimed: he has already said it doesn't belong there,
// so re-filing it is a correction, not a theft. And the history should follow —
// those snapshots are prices of that URL, and the URL is the product, so they
// belong to whichever tool the product really is.
//
// `revived` exists because an upsert(…ignoreDuplicates) once made removed links
// un-re-addable — the row was still there with active=false, so the insert
// quietly did nothing.
//
// @param existing  the (dealer_id, product_url) row, or null/undefined
// @param toolId    the tool we're attaching to
// @returns {{state: 'added'|'already'|'revived'|'adopt'|'conflict', id: number|null}}
export function decideAttach(existing, toolId) {
  if (!existing) return { state: 'added', id: null };
  // Loose compare: ids arrive as bigint-strings from PostgREST, numbers elsewhere.
  const sameTool = String(existing.tool_id) === String(toolId);
  if (!sameTool) {
    // Live on another tool → refuse, and let the caller name it so he knows
    // where to go and remove it. Removed → it's his to re-file.
    return existing.active
      ? { state: 'conflict', id: existing.id, tool_id: existing.tool_id }
      : { state: 'adopt', id: existing.id, from_tool_id: existing.tool_id };
  }
  if (existing.active) return { state: 'already', id: existing.id };
  return { state: 'revived', id: existing.id };
}
