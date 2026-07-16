// The service worker served stale code once, and deploys looked like they never
// landed (FABLE.md §6). The cache name changing every deploy is what prevents
// it — and that now depends on deploy-web.yml being able to find and rewrite one
// exact line in sw.js. These tests guard the seam between those two files, which
// nothing else would notice breaking until a deploy silently went stale.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const sw = () => read('../../web/sw.js');
const deployYml = () => read('../../.github/workflows/deploy-web.yml');

// The single line the deploy rewrites. Kept here in the exact shape the
// workflow's sed expects, so a reword of either side fails a test instead of a
// deploy.
const STAMP_LINE = /^const CACHE = '[^']*'; \/\/ DEPLOY_STAMP$/m;

test('sw.js still has the line the deploy stamps', () => {
  assert.match(sw(), STAMP_LINE);
});

test('the deploy workflow still targets that line, and checks its own work', () => {
  const yml = deployYml();
  assert.ok(yml.includes('DEPLOY_STAMP'), 'deploy-web.yml no longer references DEPLOY_STAMP');
  assert.ok(/GITHUB_SHA/.test(yml), 'the cache name should come from the commit SHA');
  assert.ok(/::error::/.test(yml), 'the stamp step must fail loudly if it matches nothing');
});

test('the repo copy stays a dev placeholder, not a real version number', () => {
  // If a human bumps this by hand again, that's the old ritual coming back —
  // and a hand-set name can collide across deploys.
  assert.match(sw(), /const CACHE = 'bbt-shell-dev'; \/\/ DEPLOY_STAMP/);
});

test('every file app.js needs at runtime is precached', () => {
  // Offline is the checklist's job. A shell file missing from this list is only
  // discovered in a basement with no signal.
  const shell = sw();
  for (const asset of ['index.html', 'css/styles.css', 'js/config.js', 'js/constants.js',
    'js/supabase.js', 'js/charts.js', 'js/app.js', 'manifest.webmanifest', 'icon.svg']) {
    assert.ok(shell.includes(`'${asset}'`), `sw.js SHELL is missing ${asset}`);
  }
});

test('the Supabase API is never cached', () => {
  // Prices must never be served from a cache pretending to be current — the
  // whole app is a claim about what something costs right now.
  assert.match(sw(), /\/rest\/v1\//);
});
