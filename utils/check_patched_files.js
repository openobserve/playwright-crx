/**
 * Copyright (c) Rui Figueira.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// @ts-check

/**
 * Type-checks the vendored Playwright files that carry downstream patches.
 *
 * The vendored tree as a whole does not type-check under our tsconfig and never has —
 * a few hundred pre-existing errors from Node type mismatches — so the root typecheck is
 * filtered to `src/`. That leaves a gap exactly where our own edits live: a patch can
 * reference a method that no longer exists, or call one whose signature moved, and
 * nothing says so. `vite build` does not type-check; the service-worker guard only sees
 * module-scope throws; and the behavioural suite finds it half an hour later, if at all.
 *
 * Every upgrade so far has produced at least one of these:
 *   1.54  a patch referenced `_recorderSources`, a field the rewrite had deleted
 *   1.60  a merge renamed three call sites to `_updateUserSources` but left the method
 *         `_updateSources`, so every onBeforeCall threw
 *   1.60  `_uninstallInjectedRecorder` kept calling `evaluateExpression(expr)` after it
 *         grew a leading Progress, so detaching stopped removing the overlay
 *
 * So this checks the patched files and nothing else, and compares against a recorded
 * baseline of errors that are upstream's rather than ours.
 *
 * Usage:
 *   node utils/check_patched_files.js            # fail on any error outside the baseline
 *   node utils/check_patched_files.js --update   # re-record the baseline after a merge
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const baselinePath = path.join(__dirname, 'patched-files-baseline.json');

function patchedFiles() {
  // Compare the vendored tree against the upstream commit the last subtree merge recorded,
  // so the list is derived rather than maintained by hand.
  const log = execFileSync('git', ['log', '--grep=git-subtree-dir: playwright', '-1', '--format=%b'], { cwd: root, encoding: 'utf8' });
  const split = /git-subtree-split:\s*([0-9a-f]+)/.exec(log);
  if (!split)
    throw new Error('Could not find the last subtree split commit — has the subtree ever been merged?');
  const out = execFileSync('git', ['diff', '--name-only', `${split[1]}^{tree}`, 'HEAD^{tree}:playwright'], { cwd: root, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map(f => `playwright/${f}`).filter(f => /\.tsx?$/.test(f));
}

function typeErrors() {
  let out = '';
  try {
    out = execFileSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  return out.split('\n').filter(Boolean);
}

const files = new Set(patchedFiles());
const errors = typeErrors().filter(line => {
  const file = line.split('(')[0];
  // `src/` is ours outright, so it is held to zero rather than to a baseline. It was
  // never checked by anything before Phase 4 — the root typecheck was run by hand — and
  // three real defects had been sitting in it. Including it here is also what gives
  // src/types/conformance.ts somewhere to run: without this the declaration-vs-
  // implementation assertions would compile in an editor and nowhere else.
  return files.has(file) || file.startsWith('src/');
});

if (process.argv.includes('--update')) {
  fs.writeFileSync(baselinePath, JSON.stringify(errors.sort(), null, 2) + '\n');
  console.log(`Recorded ${errors.length} baseline error(s) for ${files.size} patched file(s).`);
  process.exit(0);
}

const baseline = fs.existsSync(baselinePath) ? new Set(JSON.parse(fs.readFileSync(baselinePath, 'utf8'))) : new Set();
const unexpected = errors.filter(e => !baseline.has(e));

if (unexpected.length) {
  console.error(`\n${unexpected.length} type error(s) in our own code:\n`);
  for (const e of unexpected)
    console.error('  ' + e);
  console.error('\nThese are files we wrote or patched, so an error here is almost always ours —');
  console.error('a patch calling something upstream renamed, moved or resignatured, or a');
  console.error('published declaration that no longer matches what it describes.');
  console.error('If it is genuinely upstream\'s, re-record with: node utils/check_patched_files.js --update\n');
  process.exit(1);
}

console.log(`Our code type-checks clean (${files.size} patched file(s) plus src/, ${baseline.size} baselined error(s)).`);
