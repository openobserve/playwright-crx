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
 * Every other method in that contract is covered somewhere in synthetics-*.spec.ts. This
 * one was not, which is why it is worth having: the code it forwards is produced by the
 * part of Playwright that changed most across this upgrade. Codegen was rewritten at 1.56,
 * moved to `@isomorphic/codegen` at 1.62, and had its page-naming taken over by the
 * generator in the same release. A break anywhere in there would leave the steps intact —
 * so every existing test would still pass — while O2 displayed nothing.
 *
 * **The code arrives on `setActions`, not `setSources`.** The first draft of this test
 * waited for a `setSources` push and timed out having seen only `["setActions",
 * "recordingStarted"]`. `setSources` is gone from playwright-core entirely: the recorder
 * now hands sources to the app alongside the actions, so `SyntheticsRecorderApp.setSources`
 * is never called and the `setSources` branch in the extension's background script can
 * never fire. O2 does not read it today either — `useSyntheticsRecorder.ts` says
 * "setSources / elementPicked: not consumed yet" — so nothing is broken, but a message
 * path that cannot fire is a trap for whoever implements "eject to code" against it.
 *
 * So this asserts what actually holds: the generated code reaches O2, on the push that
 * really carries it.
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

  // The recorder regenerates on every action, so the first push carrying a recorded
  // source is enough — waiting for a click would buy nothing but the capture flake.
  const push = await o2.waitForPush(p =>
    p.method === 'setActions' && ((p as any).sources ?? []).some((s: any) => s.isRecorded && s.text));

  const sources = (push as any).sources as { isRecorded?: boolean, text?: string, language?: string }[];
  const recorded = sources.find(s => s.isRecorded && s.text)!;
  const code = String(recorded.text);

  // What O2 renders is a Playwright test, so the header has to be there — this is the
  // assertion that fails if codegen silently produces an empty document.
  expect(code, `generated code was: ${JSON.stringify(code)}`).toContain('@playwright/test');
  expect(code).toContain('test(');

  // And it has to describe the journey that was actually recorded, not an empty shell.
  expect(code).toContain('v2-login.html');
  expect(code).toMatch(/await page\.goto\(/);

  // The language travels with it; O2 picks a highlighter from this.
  expect(recorded.language ?? 'javascript').toBeTruthy();

  await o2.stopRecording();
});

test('the recorder no longer emits setSources, so nothing should wait for it', async ({ page, o2, baseURL }) => {
  // Pins the finding above rather than the absence itself: if a future upgrade restores
  // the separate setSources push, this fails and the dead branch in background.ts —
  // and O2's unconsumed handler — can be revisited deliberately instead of by accident.
  await page.goto(`${baseURL}/index.html`);
  await o2.listen();

  await o2.startRecording(`${baseURL}/v2-login.html`);
  await o2.waitForPush(p => p.method === 'setActions');
  await o2.stopRecording();

  const methods = (await o2.pushes()).map(p => p.method);
  expect(methods, 'setSources is gone from playwright-core; a push means upstream brought it back')
      .not.toContain('setSources');
});
