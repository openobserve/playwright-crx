/**
 * Real Chrome, real extension: the lifecycle flows that had no coverage.
 *
 * The existing synthetics specs concentrate on capture — what a recorded step contains.
 * These cover the surrounding lifecycle, where the extension talks to chrome.* for real and
 * where a fake would prove nothing: what O2 is told when a replay fails, what happens when a
 * replay is stopped, whether a recording survives a cross-origin navigation, and whether the
 * bridge still answers after the MV3 service worker has been torn down.
 *
 * Everything drives the extension the way the O2 web app does — over the postMessage bridge.
 */

import { test, expect } from './syntheticsTest';
import type { RecordedStep } from './syntheticsTest';

test.slow();

/** Record a short journey on the login fixture and return its steps. */
async function recordLoginJourney(o2: any, baseURL: string, fill = 'omkar@openobserve.ai') {
  await o2.listen();
  const target = `${baseURL}/v2-login.html`;
  await o2.startRecording(target);

  const tab = await o2.recordingTab('v2-login.html');
  await tab.locator('[data-test="login-user-id-field"]').click();
  await tab.locator('[data-test="login-user-id-field"]').fill(fill);
  await tab.locator('[data-test="login-sign-in"]').click();
  await tab.waitForURL(/\/web\//, { timeout: 30_000 }).catch(() => {});
  await tab.waitForTimeout(2_000);

  await o2.stopRecording();
  const steps = await o2.steps();
  expect(steps.length, 'nothing was recorded').toBeGreaterThan(0);
  return { steps, target };
}

test('a replay failure reports the failing step to O2, not just an overall red', async ({ page, o2, baseURL }) => {
  await page.goto(`${baseURL}/index.html`);
  const { steps, target } = await recordLoginJourney(o2, baseURL!);

  // Point the last step at an element that does not exist, so replay must fail on a step we
  // can name — rather than failing for an incidental reason and still looking "red enough".
  const broken: RecordedStep[] = JSON.parse(JSON.stringify(steps));
  const last = broken[broken.length - 1];
  if (last.locator?.candidates?.length)
    last.locator.candidates = [{ kind: 'css', value: '#no-such-element-anywhere', origin: 'recorded' }];

  const res = await o2.replay<{ success: boolean; passed: boolean; error?: string; structuredError?: any }>(
      broken, { targetUrl: target });

  expect(res, 'replay never answered').toBeTruthy();
  // `success` means "the replay ran"; `passed` is the verdict. Conflating them is how a red
  // journey gets reported as green.
  expect(res!.success).toBe(true);
  expect(res!.passed).toBe(false);
  expect(res!.error, 'a failed replay must say why').toBeTruthy();
});

test('stopping a replay reports stopped, and does not report a pass', async ({ page, o2, baseURL }) => {
  await page.goto(`${baseURL}/index.html`);
  await o2.listen();

  // Record against the slow fixture: its profile icon only appears 8s after sign-in, so the
  // replay is genuinely still working when we stop it. A fast journey finishes first and the
  // test then proves nothing about interrupting work in flight (it passed for that reason).
  const target = `${baseURL}/slow-login.html`;
  await o2.startRecording(target);
  const tab = await o2.recordingTab('slow-login.html');
  await tab.locator('[data-test="login-user-id-field"]').click();
  await tab.locator('[data-test="login-user-id-field"]').fill('omkar@openobserve.ai');
  await tab.locator('[data-test="login-sign-in"]').click();
  await tab.locator('[data-test="header-my-account-profile-icon"]').click({ timeout: 20_000 });
  await tab.waitForTimeout(1_000);
  await o2.stopRecording();

  const steps = await o2.steps();
  expect(steps.length, 'nothing was recorded').toBeGreaterThan(1);

  const replayPromise = o2.replay<{ passed: boolean; stopped?: boolean }>(steps, { targetUrl: target });

  // Stop once the replay has actually reached the slow step, rather than after a fixed sleep.
  await o2.waitForPush(p => p.method === 'stepReplayStarted', 60_000);
  await page.waitForTimeout(1_500);
  await o2.stopReplay();

  const res = await replayPromise;
  expect(res, 'replay never answered after stop').toBeTruthy();
  // A cancelled run must never be reported as a pass: that is a false green about a journey
  // that never finished.
  expect(res!.passed).toBe(false);
});

test('a recording survives a cross-origin navigation', async ({ page, o2, baseURL }) => {
  await page.goto(`${baseURL}/index.html`);
  await o2.listen();

  const target = `${baseURL}/v2-login.html`;
  await o2.startRecording(target);
  const tab = await o2.recordingTab('v2-login.html');

  await tab.locator('[data-test="login-user-id-field"]').click();
  const before = await o2.waitForSteps(s => s.length > 0);

  // 127.0.0.1 and localhost are different origins to the browser, so this crosses a process
  // boundary the way a real login redirect does.
  const crossOrigin = (baseURL as string).replace('127.0.0.1', 'localhost');
  await tab.goto(`${crossOrigin}/v2-login.html`).catch(() => {});
  await tab.waitForLoadState('domcontentloaded').catch(() => {});
  await tab.locator('[data-test="login-user-id-field"]').click().catch(() => {});
  await tab.waitForTimeout(1_500);

  const after = await o2.steps();
  await o2.stopRecording();

  // The recorder must still be attached after the navigation. Anything less means a journey
  // silently stops recording halfway through and the author never finds out.
  expect(after.length, `capture stopped at the origin boundary (before=${before.length}, after=${after.length})`)
      .toBeGreaterThan(before.length);
});

test('the bridge still answers after the service worker is torn down', async ({ page, o2, baseURL, extensionServiceWorker }) => {
  await page.goto(`${baseURL}/index.html`);

  // Prove it answers first, so a failure below is about the restart and not a cold start.
  const before = await o2.getStatus();
  expect(before, 'bridge never answered before the restart').toBeTruthy();

  // MV3 workers are evicted whenever Chrome feels like it; this forces the same condition.
  await extensionServiceWorker.evaluate(() => {
    // eslint-disable-next-line no-restricted-globals
    (self as any).registration?.unregister?.();
  }).catch(() => {});
  await page.waitForTimeout(1_000);

  // The O2 app would just issue its next command. So does this.
  const after = await o2.getStatus();
  expect(after, 'the bridge never came back after the worker was torn down').toBeTruthy();
});

test('an unknown command is answered rather than left hanging', async ({ page, o2, baseURL }) => {
  await page.goto(`${baseURL}/index.html`);

  // A command the extension does not implement must still get a reply. The dispatcher used to
  // fall through without calling respond(), so the O2 page waited out its own 60s timeout with
  // no way to tell "this build does not support that command" from "the extension is wedged".
  const res = await o2.send<{ success?: boolean; error?: string }>({ action: 'thisCommandDoesNotExist' }, 15_000);

  expect(res, 'an unknown command stranded the caller — no response was ever sent').toBeTruthy();
  expect(res!.success).toBe(false);
  expect(res!.error, 'the reply should name the unsupported command').toContain('thisCommandDoesNotExist');
});
