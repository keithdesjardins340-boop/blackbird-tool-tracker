// Public config. The anon (publishable) key is safe to ship — RLS makes it
// read-only. To enable CSV import writes from this device only, paste your
// service_role key in the Import tab (stored in localStorage, never committed).
window.BBT_CONFIG = {
  SUPABASE_URL: 'https://ssfhjhbarkpgbelnbcun.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_oXihjGZ6k86Af2pDF5ooqw_si-iILGM',
  // Thresholds
  DEAL_PCT: -10,       // % vs 90-day avg that counts as a deal
};
