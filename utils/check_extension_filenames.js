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

// Chrome reserves a leading underscore in extension paths for itself (`_metadata`,
// `_locales`). An extension containing any other such entry does not fail gracefully —
// Chrome refuses to load it at all:
//
//   Cannot load extension with file or directory name __vite-optional-peer-dep_...js.map.
//   Filenames starting with "_" are reserved for use by the system.
//
// A bundler has no reason to know this. Vite named a generated stub for a missing optional
// peer dependency `__vite-optional-peer-dep_kerberos_proxy-agent-negotiate`, emitted it
// from the root build, and every extension copied it — so `npm run build` exited 0 and
// produced four extensions that could not be installed. Nothing else in the build looks at
// output filenames, so this checks them.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

const bundles = [
  'lib',
  'examples/recorder-crx/dist',
  'examples/synthetics-recorder/dist',
  'examples/todomvc-crx/dist',
  'tests/test-extension/dist',
];

// The two prefixes Chrome itself defines. Everything else starting with `_` is a defect.
const allowed = new Set(['_metadata', '_locales']);

const offenders = [];

function walk(dir, bundle) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_') && !allowed.has(entry.name))
      offenders.push(path.relative(root, path.join(dir, entry.name)));
    else if (entry.isDirectory())
      walk(path.join(dir, entry.name), bundle);
  }
}

for (const bundle of bundles) {
  const dir = path.join(root, bundle);
  if (fs.existsSync(dir))
    walk(dir, bundle);
}

if (offenders.length) {
  console.error('\nChrome will refuse to load these extensions.');
  console.error('Filenames starting with "_" are reserved, and these were emitted anyway:\n');
  for (const offender of offenders)
    console.error(`  ${offender}`);
  console.error('\nUsually a bundler-generated stub for a dependency that did not resolve.');
  console.error('Resolve the specifier yourself (see src/shims/kerberos.ts) so no stub is');
  console.error('generated, rather than renaming the output after the fact.\n');
  process.exit(1);
}

console.log(`Extension filenames are loadable (${bundles.length} bundles checked).`);
