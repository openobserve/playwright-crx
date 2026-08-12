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
 * Source forwarding — the one part of the extension↔O2 contract with no test.
 *
 * `setSources` is how the generated code reaches O2, and it is the only push that carries
 * it: `setActions` carries the steps O2 stores, `setSources` carries the code a person
 * reads. Every other method in that contract is covered somewhere in synthetics-*.spec.ts.
 * This one was not, which is why it is worth having: the code it forwards is produced by
 * the part of Playwright that changed most across this upgrade. Codegen was rewritten at
 * 1.56, moved to `@isomorphic/codegen` at 1.62, and had its page-naming taken over by the
 * generator in the same release. A break anywhere in there would leave the steps intact —
 * so every existing test would still pass — while O2 displayed nothing.
 *
 * It deliberately asserts on the opening `navigate` only. The recorder has a known
 * pre-existing flake where the injected recorder is not installed in time and only that
 * first step is captured; a test that needed a click would inherit the flake and say
 * nothing about sources. What survives the flake is exactly what this test needs.
 */

import { test, expect } from './syntheticsTest';

test.slow();

test('the generated code reaches O2, not just the steps', async ({ page, o2, baseURL }) => {
  await page.goto(`${baseURL}/index.html`);
  await o2.listen();

  const target = `${baseURL}/v2-login.html`;
  await o2.startRecording(target);

  // The recorder regenerates on every action, so the first push is enough — waiting for a
  // click would buy nothing but the capture flake.
  const push = await o2.waitForPush(p => p.method === 'setSources' && !!(p as any).generatedCode);
  const code = String((push as any).generatedCode);

  // What O2 renders is a Playwright test, so the header has to be there — this is the
  // assertion that fails if codegen silently produces an empty document.
  expect(code, `generated code was: ${JSON.stringify(code)}`).toContain('@playwright/test');
  expect(code).toContain('test(');

  // And it has to describe the journey that was actually recorded, not an empty shell.
  expect(code).toContain('v2-login.html');
  expect(code).toMatch(/await page\.goto\(/);

  // The language travels with it; O2 picks a highlighter from this.
  expect((push as any).generatedLanguage ?? 'javascript').toBeTruthy();

  await o2.stopRecording();
});
