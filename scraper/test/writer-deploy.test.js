// The writer deploy has one setting that must never drift: verify_jwt=false.
//
// This function's auth is the writer token in the x-writer-token header, checked
// against app_secrets — NOT a Supabase JWT. Deploy it with JWT verification on
// and every write from the dashboard 401s: checkmarks, quick-add, bookmarklet
// captures, the lot. Nothing in the repo would look wrong, and it would only
// show up in production.
//
// Worth a test precisely because the flag looks like boilerplate you'd tidy away.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const yml = () => readFileSync(
  fileURLToPath(new URL('../../.github/workflows/deploy-writer.yml', import.meta.url)), 'utf8');

test('the writer deploys with JWT verification OFF', () => {
  assert.match(yml(), /--no-verify-jwt/,
    'auth here is the writer token; verifying a JWT would 401 every write');
});

test('it deploys the right function to the right project', () => {
  const y = yml();
  assert.match(y, /supabase functions deploy writer/);
  assert.match(y, /--project-ref ssfhjhbarkpgbelnbcun/);
});

test('it fires when the function changes', () => {
  // A deploy workflow that doesn't run on the file it deploys is decoration.
  assert.match(yml(), /supabase\/functions\/\*\*/);
});

test('a missing token fails loudly instead of silently skipping', () => {
  // The failure mode this replaces was "someone forgot to deploy". A green run
  // that quietly did nothing would be the same bug with a tick next to it.
  const y = yml();
  assert.match(y, /::error::/);
  assert.match(y, /SUPABASE_ACCESS_TOKEN/);
});

test('the summary reports the OUTCOME, not the intention', () => {
  // Shipped broken the first time: the report said "Deployed from the repo"
  // unconditionally and printed it over a 401. The run page is the thing you
  // trust at a glance, so a summary that lies on failure is worse than none.
  const y = yml();
  assert.match(y, /steps\.deploy\.outcome/, 'the report must read the deploy step outcome');
  assert.match(y, /Deploy failed/, 'it must be able to say the deploy failed');
  assert.match(y, /UNCHANGED/, 'and say the live function did not move');
});
