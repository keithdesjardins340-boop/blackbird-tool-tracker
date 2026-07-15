// Adapter registry. Keys MUST match the `dealers.name` column exactly.
import princessAuto from './princess-auto.js';
import kmsTools from './kms-tools.js';
import homeDepot from './home-depot.js';
import canadianTire from './canadian-tire.js';
import amazon from './amazon.js';

export const adapters = {
  [princessAuto.dealer]: princessAuto,
  [kmsTools.dealer]: kmsTools,
  [homeDepot.dealer]: homeDepot,
  [canadianTire.dealer]: canadianTire,
  [amazon.dealer]: amazon,
};

export function getAdapter(dealerName) {
  return adapters[dealerName] || null;
}
