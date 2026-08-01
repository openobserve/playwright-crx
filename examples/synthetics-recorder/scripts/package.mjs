/**
 * Build a Chrome Web Store upload artifact.
 *
 * Packaging this extension by hand is a sequence in which forgetting one step
 * still produces a plausible-looking zip. In particular `public/manifest.json`
 * carries a `key` field to pin a stable extension id for local unpacked loading,
 * Vite copies `public/` verbatim, and so every single build puts that key back
 * into `dist/manifest.json`. Stripping it was a checklist line a human had to
 * remember every time.
 *
 * So this script owns the whole sequence and refuses to emit an artifact it
 * cannot verify:
 *
 *   build -> stage a copy -> strip `key` -> zip contents at the root -> validate
 *
 * The source `public/manifest.json` is never modified; only the staged copy is.
 *
 * Usage:  npm run package        (from examples/synthetics-recorder)
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const outDir = path.join(root, 'release');

const fail = msg => { console.error(`\n  package: ${msg}\n`); process.exit(1); };

// ---- 1. One source of truth for the version -------------------------------
//
// The version lives in two files that are edited by hand, so they drift. A
// mismatch is not something to paper over during packaging: it means one of them
// is wrong and nobody knows which.

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const srcManifest = JSON.parse(readFileSync(path.join(root, 'public/manifest.json'), 'utf8'));

if (pkg.version !== srcManifest.version) {
  fail(`version mismatch — package.json is ${pkg.version}, public/manifest.json is ${srcManifest.version}.\n` +
       `  Set both to the version you intend to publish, then run again.`);
}
if (!/^\d+(\.\d+){0,3}$/.test(pkg.version))
  fail(`"${pkg.version}" is not a valid Chrome extension version (1-4 dot-separated integers).`);

// ---- 2. Build -------------------------------------------------------------

console.log(`\n  packaging ${srcManifest.name} ${pkg.version}\n`);
console.log('  building...');
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });

if (!existsSync(dist)) fail('build produced no dist/ directory.');

// ---- 3. Stage and strip ---------------------------------------------------

const stage = mkdtempSync(path.join(tmpdir(), 'cws-pkg-'));
cpSync(dist, stage, { recursive: true });

const staged = JSON.parse(readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
const hadKey = delete staged.key;
writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(staged, null, 2) + '\n');
console.log(`  stripped "key" from packaged manifest: ${hadKey}`);

// ---- 4. Zip ---------------------------------------------------------------
//
// Contents at the archive root. A zip containing a `dist/` folder is rejected by
// the Chrome Web Store with an unhelpful error.

mkdirSync(outDir, { recursive: true });
const slug = srcManifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const zipPath = path.join(outDir, `${slug}-${pkg.version}.zip`);
rmSync(zipPath, { force: true });

try {
  execFileSync('zip', ['-qr', zipPath, '.', '-x', '.*', '-x', '__MACOSX/*'], { cwd: stage });
} catch {
  fail('`zip` is not available on this machine. Install it, or zip the staged directory manually:\n  ' + stage);
}

// ---- 5. Validate what actually came out -----------------------------------
//
// Checking the artifact rather than the inputs: this is the thing that gets
// uploaded, and it is the last point at which a mistake is cheap.

const require = createRequire(import.meta.url);
const entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).split('\n').filter(Boolean);
const inZip = new Set(entries);
const zipManifest = JSON.parse(execFileSync('unzip', ['-p', zipPath, 'manifest.json'], { encoding: 'utf8' }));

const problems = [];
if (!inZip.has('manifest.json')) problems.push('manifest.json is not at the archive root');
if ('key' in zipManifest) problems.push('"key" field survived into the artifact');
if (zipManifest.version !== pkg.version) problems.push(`artifact version is ${zipManifest.version}, expected ${pkg.version}`);

const referenced = [
  ...Object.values(zipManifest.icons ?? {}),
  zipManifest.background?.service_worker,
  zipManifest.action?.default_popup,
  ...(zipManifest.content_scripts ?? []).flatMap(cs => [...(cs.js ?? []), ...(cs.css ?? [])]),
].filter(Boolean);

for (const ref of new Set(referenced))
  if (!inZip.has(ref)) problems.push(`manifest references "${ref}", which is not in the artifact`);

if (problems.length) {
  rmSync(zipPath, { force: true });
  fail('artifact failed validation, so it was deleted:\n' + problems.map(p => `    - ${p}`).join('\n'));
}

rmSync(stage, { recursive: true, force: true });

const mb = (statSync(zipPath).size / 1024 / 1024).toFixed(1);
console.log(`  validated: manifest at root, no key, ${new Set(referenced).size} referenced files present`);
console.log(`\n  ${zipPath}  (${mb} MB)\n`);
