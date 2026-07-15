// Service-role Supabase client — full write access, bypasses RLS.
// Only ever used server-side (GitHub Actions / local CLI). Never ship the
// service_role key to the browser.

import { createClient } from '@supabase/supabase-js';

// Strip stray whitespace/newlines — a common artifact of pasting the key into a
// CI secret. Keys and the URL never contain whitespace, so this is safe and
// prevents "invalid header value" errors from a newline sneaking into the token.
const url = (process.env.SUPABASE_URL || '').trim();
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').replace(/\s+/g, '');

if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. See .env.example.');
  process.exit(1);
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
