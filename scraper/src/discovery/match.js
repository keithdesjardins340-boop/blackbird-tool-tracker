// The noise gate for deal discovery.
//
// The last discovery build-out died of matching noise: it found plenty and
// bought nothing, so he rolled it back. The only thing that makes a second
// attempt worth having is that it stays quiet. So this is deliberately
// conservative, and every gate FAILS CLOSED — when unsure, drop the candidate.
// A missed lead costs nothing; a junk lead costs his attention, and a review
// inbox full of junk is one he stops opening.
//
// Pure and dependency-free on purpose: no DB, no network, so tests import it
// freely (FABLE.md §6 — supabase.js exits the process on import without env).

/**
 * Words that mean "this row is not the tool". Mostly the myflukestore trap in
 * word form: the $135 thing next to the $725 meter.
 *
 * 'kit'/'bundle'/'set' are handled separately — they're only junk when the tool
 * ITSELF isn't a kit, and Keith's list is full of legitimate 122-piece sets.
 */
const REJECT_TERMS = [
  'warranty', 'protection plan', 'service plan', 'add-on', 'add on',
  'accessory', 'accessories', 'holster', 'lead set', 'test lead',
  'replacement', 'for parts', 'manual', 'sticker', 'decal',
];
const USED_TERMS = ['refurbished', 'refurb', 'open box', 'open-box', 'renewed', 'pre-owned', 'used'];
const KIT_TERMS = ['kit', 'bundle', 'set'];

/** Generic words that carry no identity — dropping them keeps the gate strict
 *  on the parts that matter (model numbers, variants) and lax on marketing. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'true', 'rms', 'digital', 'professional', 'pro',
  'new', 'genuine', 'oem', 'industrial', 'heavy', 'duty', 'piece', 'inch', 'metric',
]);

/** Tokens that LOOK generic but distinguish variants — 87V vs 87V Max. */
const VARIANT_WORDS = new Set(['max', 'plus', 'xl', 'xr', 'hd', 'ii', 'iii', 'mk2', 'mkii']);

const norm = (s) => ` ${String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** Does the tool itself sound like a kit/set? Then "set" isn't a reject word. */
export function toolIsKit(tool) {
  const hay = norm(`${tool?.name || ''} ${tool?.discovery_query || ''}`);
  return KIT_TERMS.some((t) => hay.includes(` ${t} `));
}

/**
 * The tokens a candidate title MUST contain. Keeps anything with a digit (model
 * numbers), known variant words, and other distinctive words; drops marketing.
 */
export function tokenizeQuery(query) {
  const raw = norm(query).trim().split(/\s+/).filter(Boolean);
  return raw.filter((t) => /\d/.test(t) || VARIANT_WORDS.has(t) || (!STOPWORDS.has(t) && t.length >= 3));
}

/** Whole-token containment, so "87v" never matches "87vmax" or "187v". */
function titleHasAllTokens(title, tokens) {
  const hay = norm(title);
  return tokens.every((tok) => hay.includes(` ${tok} `));
}

/**
 * Judge one shopping result against one tool.
 *
 * @param {object} tool {name, discovery_query, best_price_cad}  best may be null
 * @param {object} cand {title, extracted_price, second_hand_condition, ...}
 * @param {object} opts {minRatio, maxRatio, allowUsed}  ratios = the SHARED band
 * @returns {{ok: boolean, reason?: string}}
 */
export function matchCandidate(tool, cand, opts) {
  const { minRatio, maxRatio, allowUsed = false } = opts || {};
  if (!(minRatio > 0) || !(maxRatio > 0)) return { ok: false, reason: 'no-band' }; // fail closed

  const title = cand?.title || '';
  if (!title) return { ok: false, reason: 'no-title' };

  const hay = norm(title);
  if (!allowUsed && (cand.second_hand_condition || USED_TERMS.some((t) => hay.includes(` ${t} `)))) {
    return { ok: false, reason: 'used' };
  }
  if (REJECT_TERMS.some((t) => hay.includes(` ${t} `))) return { ok: false, reason: 'addon' };
  // Only treat kit words as junk when he isn't shopping for a kit.
  if (!toolIsKit(tool) && KIT_TERMS.some((t) => hay.includes(` ${t} `))) {
    return { ok: false, reason: 'kit-mismatch' };
  }

  const tokens = tokenizeQuery(tool?.discovery_query || tool?.name || '');
  if (!tokens.length) return { ok: false, reason: 'no-tokens' };
  if (!titleHasAllTokens(title, tokens)) return { ok: false, reason: 'token-miss' };

  const price = typeof cand.extracted_price === 'number' ? cand.extracted_price : null;
  if (price == null || !(price > 0)) return { ok: false, reason: 'no-price' };

  // The strongest gate, and free: a price wildly off what his other dealers
  // charge is a bad read, not a bargain. Same band run.js uses on snapshots.
  // With no reference price we CANNOT sanity-check, so we don't guess — a lead
  // we can't sanity-check is exactly the kind that wastes his time.
  if (tool.best_price_cad == null || !(Number(tool.best_price_cad) > 0)) {
    return { ok: false, reason: 'no-reference' };
  }
  const ratio = price / Number(tool.best_price_cad);
  if (ratio > maxRatio || ratio < minRatio) return { ok: false, reason: 'price-band' };

  // Only surface it if it's actually CHEAPER — the inbox is for buying
  // decisions, not a catalogue of everyone who sells this.
  if (price >= Number(tool.best_price_cad)) return { ok: false, reason: 'not-cheaper' };

  return { ok: true };
}
