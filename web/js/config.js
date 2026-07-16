// Public config. The anon (publishable) key is safe to ship — RLS makes it
// read-only. Writes go through the `writer` Edge Function, authorized by a
// per-device access token you paste in the Settings tab. No admin key ships here.
window.BBT_CONFIG = {
  SUPABASE_URL: 'https://ssfhjhbarkpgbelnbcun.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_oXihjGZ6k86Af2pDF5ooqw_si-iILGM',
};
// Thresholds (DEAL_PCT, …) are NOT here: they live in js/constants.js, which the
// scraper imports too, so the Deals tab and the run report can't drift apart.
