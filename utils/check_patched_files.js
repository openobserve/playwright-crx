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

/** Committer timestamp for a commit, or undefined if the object is not in this clone. */
function commitDate(sha) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ct', `${sha}^{commit}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return Number(out.trim());
  } catch {
    return undefined;
  }
}

/**
 * The upstream commit the vendored tree was last synced to.
 *
 * One body can carry MORE THAN ONE `git-subtree-split:` trailer. A squash merge
 * concatenates every message in the branch, so a PR that bumped the subtree N times
 * leaves N trailers in a single commit — the 1.53 → 1.62.1 upgrade left nine. Reading
 * only the first match picked the OLDEST split, which made every file upstream touched
 * in the intervening year look like one of our patches: 1284 files instead of 22, and a
 * dozen ordinary upstream errors (missing bundle deps, `toWellFormed` wanting es2024, a
 * `?inline` css import) reported as ours. That is the failure this function exists to
 * avoid, so it resolves the newest trailer rather than the first.
 *
 * Newest is decided by commit date, not by position and not by ancestry:
 *   - position is only a convention of how git orders a squashed body, so it is used
 *     solely to break ties;
 *   - ancestry does not hold. The splits sit on divergent upstream lines (release
 *     branches, cherry-picks) — 3da07a704 (1.53) and 26a9e470a (1.62.1) share a merge
 *     base, but neither is an ancestor of the other, so `merge-base --is-ancestor`
 *     answers "no" both ways and cannot order them.
 *
 * A trailer whose object is missing from this clone cannot be dated, so it loses to any
 * that can be.
 */
function latestSubtreeSplit(log) {
  const shas = [...log.matchAll(/git-subtree-split:\s*([0-9a-f]+)/g)].map(m => m[1]);
  if (!shas.length)
    throw new Error('Could not find the last subtree split commit — has the subtree ever been merged?');
  let best;
  for (const sha of shas) {
    const when = commitDate(sha);
    // `>=` so that among equally dated — or equally undatable — candidates the one
    // latest in the body wins, which is the order git writes a squashed message in.
    if (!best || (when ?? -1) >= (best.when ?? -1))
      best = { sha, when };
  }
  return best.sha;
}

function patchedFiles() {
  // Compare the vendored tree against the upstream commit the last subtree merge recorded,
  // so the list is derived rather than maintained by hand.
  const log = execFileSync('git', ['log', '--grep=git-subtree-dir: playwright', '-1', '--format=%b'], { cwd: root, encoding: 'utf8' });
  const split = latestSubtreeSplit(log);
  const out = execFileSync('git', ['diff', '--name-only', `${split}^{tree}`, 'HEAD^{tree}:playwright'], { cwd: root, encoding: 'utf8' });
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
