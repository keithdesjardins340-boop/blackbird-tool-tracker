// Adapter registry. Keys MUST match the `dealers.name` column exactly.
import princessAuto from './princess-auto.js';
import kmsTools from './kms-tools.js';
import homeDepot from './home-depot.js';
import canadianTire from './canadian-tire.js';
import amazon from './amazon.js';
import genericManual from './generic-manual.js';

export const adapters = {
  [princessAuto.dealer]: princessAuto,
  [kmsTools.dealer]: kmsTools,
  [homeDepot.dealer]: homeDepot,
  [canadianTire.dealer]: canadianTire,
  [amazon.dealer]: amazon,
  [genericManual.dealer]: genericManual, // 'Other' — manually pasted links
};

export function getAdapter(dealerName) {
  return adapters[dealerName] || null;
}

// Fallback used by the runner for any dealer that has no dedicated adapter, so a
// user can paste a product link from ANY site and still get it priced.
export function getScrapeAdapter(dealerName) {
  return adapters[dealerName] || genericManual;
}
