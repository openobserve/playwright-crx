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

/**
 * Does each extension's service worker survive its own bundle?
 *
 * This exists because of how the 1.59 upgrade failed. `expect` v30 ships an ESM wrapper
 * that resolves to `undefined` under Rollup's CJS interop but works under Node's, so
 * `expectLibrary.setState(...)` threw at module scope — while the worker was still
 * evaluating. The worker went straight from 'parsed' to 'redundant', and every one of the
 * 229 tests failed in fixture setup with a 30-second timeout that named nothing. The
 * build was clean. So were lint and the typecheck.
 *
 * Nothing in the suite asked the only question that mattered: did the worker start?
 *
 * Note what this file does NOT use: `crxTest`. Its `extensionServiceWorker` fixture is
 * exactly what hangs when a worker dies, and several of its fixtures are auto-use, so a
 * test built on it inherits the same anonymous 30-second timeout it is meant to replace.
 * The first draft of this file did, and reported the failure as
 * "timeout while setting up extensionServiceWorker" — true, useless, and indistinguishable
 * from the symptom. So the browser is launched here directly, and the worker's state and
 * its own error events are read straight off it.
 */

import { test, expect, chromium } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Every extension we ship. A bundling break rarely respects extension boundaries — but it
// does not always cross them either: the 1.59 one came in through `src/test.ts`, which
// only the test extension bundles, so recorder-crx and synthetics-recorder stayed healthy
// while every test failed. Checking all three is what tells those two cases apart.
const extensions = [
  { name: 'test-extension', dir: path.join(__dirname, '..', 'test-extension', 'dist') },
  { name: 'recorder-crx', dir: path.join(__dirname, '..', '..', 'examples', 'recorder-crx', 'dist') },
  { name: 'synthetics-recorder', dir: path.join(__dirname, '..', '..', 'examples', 'synthetics-recorder', 'dist') },
];

for (const extension of extensions) {
  test(`${extension.name}: service worker activates without a top-level error`, async () => {
    expect(fs.existsSync(path.join(extension.dir, 'manifest.json')),
        `${extension.dir} is not a built extension — run npm run build first`).toBe(true);

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crx-health-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${extension.dir}`,
        `--load-extension=${extension.dir}`,
        // Chrome 137+ put --load-extension behind a flag; without this the browser starts
        // and silently loads nothing, which would read here as "no worker ever appeared".
        '--disable-features=DisableLoadExtensionCommandLineSwitch',
      ],
    });

    try {
      const worker = context.serviceWorkers()[0]
          ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });

      // Capture what the worker throws while it is still evaluating. A module-scope throw
      // is invisible from outside — the worker just never activates — so without this the
      // assertion below would be another timeout that names nothing.
      await worker.evaluate(() => {
        (globalThis as any).__healthErrors = [];
        self.addEventListener('error', (e: any) => (globalThis as any).__healthErrors.push(e.message ?? String(e)));
        self.addEventListener('unhandledrejection', (e: any) =>
          (globalThis as any).__healthErrors.push(`unhandled rejection: ${e.reason?.message ?? e.reason}`));
      }).catch(() => {});

      const read = async () => worker.evaluate(() => ({
        state: (globalThis as any).serviceWorker?.state as string | undefined,
        errors: ((globalThis as any).__healthErrors ?? []) as string[],
      })).catch(e => ({ state: `unreachable (${String(e.message).split('\n')[0]})`, errors: [] as string[] }));

      let last = await read();
      const deadline = Date.now() + 20_000;
      // 'redundant' is terminal and means the worker died — stop rather than wait it out.
      while (Date.now() < deadline && last.state !== 'activated' && last.state !== 'redundant') {
        await new Promise(r => setTimeout(r, 250));
        last = await read();
      }

      expect(last.state,
          `${extension.name}'s service worker never activated (state: ${last.state}). ` +
          `Errors it reported: ${last.errors.length ? last.errors.join(' | ') : '<none captured>'}`)
          .toBe('activated');
    } finally {
      await context.close().catch(() => {});
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
}
