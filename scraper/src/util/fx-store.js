// The fx_rates table, behind the tiny {get, put} interface fx.js expects.
//
// Split from fx.js so that module stays free of the Supabase client (which exits
// the process when its env vars are missing) and can be unit-tested against a
// stubbed fetch with no database at all.

import { supabase } from '../supabase.js';

export const fxStore = {
  /** Last rate we successfully read for `cur`, or null. */
  async get(cur) {
    const { data, error } = await supabase
      .from('fx_rates').select('currency,rate,as_of').eq('currency', cur).maybeSingle();
    if (error) throw error;
    return data || null;
  },

  /**
   * Remember a rate. `asOf` is Valet's own observation date when it gave us one
   * — the rate's real age, not when we happened to ask. Using fetch time would
   * make a Friday rate look fresh all weekend, which is precisely the staleness
   * the age check is meant to catch.
   */
  async put(cur, rate, asOf) {
    const as_of = asOf ? new Date(asOf).toISOString() : new Date().toISOString();
    const { error } = await supabase.from('fx_rates').upsert(
      { currency: cur, rate, as_of, updated_at: new Date().toISOString() },
      { onConflict: 'currency' },
    );
    if (error) throw error;
  },
};
