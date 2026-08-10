/**
 * Navigation coverage for the synthetics recorder.
 *
 * These exist because navigation broke and nothing caught it. Every recorded journey has
 * to begin somewhere: the web app replays a journey by starting at its first step, so a
 * journey whose opening `navigate` is missing has nowhere to start. The v2 specs asserted
 * richly about clicks — locator bundles, settle blocks, durations — and never once about
 * the step that gets you to the page, so the regression was invisible.
 *
 * The failure mode is subtle enough to be worth stating, since it will recur: the recorder
 * emits `openPage` for already-open pages while *installing*, but that emission is gated on
 * an `_enabled` flag which is only set by `setMode()` — which runs after install. crx must
 * construct the recorder at 'none' and switch it to 'recording' afterwards (seeding
 * 'recording' up front leaves `_enabled` false forever, because `setMode()` early-returns
 * when the mode already matches). So the opening action is dropped, and because the
 * extension opens the recording tab *already at* the target URL there is no later
 * navigation signal to recover it.
 *
 * Anything that changes recorder construction, mode handling, or install order can break
 * this again, and only these tests will say so.
 */

import { test, expect } from './syntheticsTest';
import { describeSteps } from './syntheticsTest';

test.slow();

test('a journey opens with a navigate step carrying the target URL', async ({ page, o2, baseURL }) => {
  await page.goto(`${baseURL}/index.html`);
  await o2.listen();

  const target = `${baseURL}/v2-login.html`;
  await o2.startRecording(target);

  const recordingPage = await o2.recordingTab('v2-login.html');
  await recordingPage.locator('[data-test="login-user-id-field"]').click();
  await recordingPage.waitForTimeout(1_000);

  await o2.stopRecording();
  await page.waitForTimeout(1_000);

  const steps = await o2.steps();
  expect(steps.length, `nothing was recorded: ${describeSteps(steps)}`).toBeGreaterThan(0);

  // The opening step is the whole point: replay starts here.
  const first = steps[0];
  expect(first.action, `journey does not start with a navigation: ${JSON.stringify(steps.map(s => s.action))}`).toBe('navigate');
  expect(first.url, 'the opening navigate carries no URL').toBe(target);
});

test('navigating during a recording is captured as its own step', async ({ page, o2, baseURL }) => {
  await page.goto(`${baseURL}/index.html`);
  await o2.listen();

  const target = `${baseURL}/v2-login.html`;
  await o2.startRecording(target);

  const recordingPage = await o2.recordingTab('v2-login.html');
  // A navigation the author performs *after* recording has started, which reaches the
  // recorder as a navigation signal rather than through the opening seed. Both paths must
  // produce a step; only the first one was ever exercised.
  await recordingPage.goto(`${baseURL}/root.html`);
  await recordingPage.waitForTimeout(1_500);

  await o2.stopRecording();
  await page.waitForTimeout(1_000);

  const steps = await o2.steps();
  const urls = steps.filter(s => s.action === 'navigate').map(s => s.url);
  expect(urls, `expected both navigations, got ${describeSteps(steps)}`).toContain(target);
  expect(urls, `the in-recording navigation was lost: ${describeSteps(steps)}`)
      .toContain(`${baseURL}/root.html`);
});

test('the opening navigate survives a stop/start cycle', async ({ page, o2, baseURL }) => {
  await page.goto(`${baseURL}/index.html`);
  await o2.listen();

  const target = `${baseURL}/v2-login.html`;

  // First recording, discarded. The seeding runs on open(); a second session must seed
  // again rather than rely on state left behind by the first.
  await o2.startRecording(target);
  await o2.recordingTab('v2-login.html');
  await o2.stopRecording();
  await page.waitForTimeout(500);

  await o2.listen();
  await o2.startRecording(target);
  const recordingPage = await o2.recordingTab('v2-login.html');
  await recordingPage.locator('[data-test="login-user-id-field"]').click();
  await recordingPage.waitForTimeout(1_000);
  await o2.stopRecording();
  await page.waitForTimeout(1_000);

  const steps = await o2.steps();
  expect(steps[0]?.action, `second recording lost its opening navigate: ${describeSteps(steps)}`).toBe('navigate');
  expect(steps[0]?.url).toBe(target);
});
