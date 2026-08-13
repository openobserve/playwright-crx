/**
 * Browser verification for version-2 capture (Phases 2-4, T3/T1).
 *
 * The unit tests in synthetics-v2-capture.spec.ts pin down what the pure
 * functions decide. This one proves the thing they cannot: that the REAL
 * extension, driving the REAL injected recorder in a REAL browser, actually
 * produces that shape — that `multiple: true` reaches the selector generator,
 * that the ranked list survives Action -> ActionInContext -> actionMapper, and
 * that the navigation signal Playwright already collects becomes a settle block
 * instead of being thrown away.
 *
 * It records by driving the recording tab the way a person would: open the
 * extension's tab, click things in it, stop. Nothing here reaches into internals
 * the O2 web app could not reach.
 */

import { test, expect } from './syntheticsTest';
import { findStep, describeSteps } from './syntheticsTest';
import type { RecordedStep } from './syntheticsTest';

test.slow();

test('a recorded click carries a locator bundle, a settle block, and its duration', async ({ page, o2, baseURL }) => {
  await page.goto(`${baseURL}/index.html`);
  await o2.listen();

  const target = `${baseURL}/v2-login.html`;
  await o2.startRecording(target);

  // The extension opened its own recording tab; drive that, as a person would.
  // The extension opened its own recording tab; drive that, as a person would.
  const recordingPage = await o2.recordingTab('v2-login.html');
  await recordingPage.locator('[data-test="login-user-id-field"]').click();
  await recordingPage.locator('[data-test="login-user-id-field"]').fill('omkar@openobserve.ai');
  await recordingPage.locator('[data-test="login-sign-in"]').click();

  // Let the navigation land so its signal is attached to the click.
  await recordingPage.waitForURL(/\/web\//, { timeout: 30_000 }).catch(() => {});
  await recordingPage.waitForTimeout(3_000);

  await o2.stopRecording();
  await page.waitForTimeout(1_000);

  const steps = await o2.steps();
  expect(steps.length, 'nothing was recorded').toBeGreaterThan(1);

  const signIn = findStep(steps, 'login-sign-in');
  expect(signIn, `no sign-in step in ${describeSteps(steps)}`).toBeTruthy();

  // ── Phase 2 T3: the ranked list reaches the stored step ────────────────────
  expect(signIn!.locator?.candidates?.length,
      'only one candidate — multiple:true is not reaching the generator').toBeGreaterThan(1);
  // The test attribute is what the fixture makes most stable, so it must lead.
  expect(signIn!.locator!.candidates[0].kind).toBe('test_attribute');
  // NB: there is deliberately no bare `selector` to check against. BrowserStep's own doc
  // records that "the bare `selector` and `selector_type` pair ... went with version 1
  // (Phase 2c)" — the locator bundle IS the step's identity now. This assertion outlived
  // the field it was guarding.

  // ── Phase 3 T1/T2: the navigation signal becomes a wait condition ──────────
  expect(signIn!.settle?.navigation?.url_pattern,
      'the navigation signal was discarded again').toBe('**/web/index.html/**');
  expect(typeof signIn!.settle?.observed_duration_ms).toBe('number');

  // ── Phase 4 T1: the same-site API call is captured, always advisory ────────
  const responses = signIn!.settle?.responses ?? [];
  expect(responses.map(r => r.url_pattern)).toContain('**/api/session.json');
  expect(responses.every(r => r.required === false),
      'the recorder must never mark a signal required').toBe(true);
  // X-4: no query strings anywhere in what was stored.
  expect(responses.every(r => !r.url_pattern.includes('?'))).toBe(true);
});

test('a streamed, slow, also-fired-on-load search still becomes a settle signal', async ({ page, o2, baseURL }) => {
  await page.goto(`${baseURL}/index.html`);
  await o2.listen();

  const target = `${baseURL}/v2-search.html`;
  await o2.startRecording(target);

  const recordingPage = await o2.recordingTab('v2-search.html');
  // Let the mount-time search finish first, so the click's own search is the
  // SECOND time each endpoint is seen — the shape that used to be filtered as
  // background traffic.
  await recordingPage.waitForTimeout(3_000);

  await recordingPage.locator('[data-test="logs-search-bar-refresh-btn"]').click();
  // Long enough for /api/slow.json (2.5s), which the retired one-second window
  // could never have reached.
  await recordingPage.waitForTimeout(4_000);

  await o2.stopRecording();
  await page.waitForTimeout(1_000);

  const steps = await o2.steps();
  const runQuery = findStep(steps, 'logs-search-bar-refresh-btn');
  expect(runQuery, `no Run Query step in ${describeSteps(steps)}`).toBeTruthy();

  const patterns = (runQuery!.settle?.responses ?? []).map(r => r.url_pattern);

  // The SSE search — dropped outright while the allow-list was JSON-only.
  expect(patterns, 'the streamed search was not captured').toContain('**/api/search_stream');
  // The slow JSON call — dropped by the one-second window.
  expect(patterns, 'the slow response was not captured').toContain('**/api/slow.json');
  // Still advisory: escalating a signal is an author act, never a recording.
  expect(runQuery!.settle!.responses!.every(r => r.required === false)).toBe(true);
});

test('a recorded journey contains no hard sleep and no stamped timeout', async ({ page, o2, baseURL }) => {
  await page.goto(`${baseURL}/index.html`);
  await o2.listen();

  const target = `${baseURL}/v2-login.html`;
  await o2.startRecording(target);

  const recordingPage = await o2.recordingTab('v2-login.html');
  await recordingPage.locator('[data-test="login-sign-in"]').click();
  await recordingPage.waitForTimeout(3_000);

  await o2.stopRecording();
  await page.waitForTimeout(1_000);

  const steps = await o2.steps();
  expect(steps.length).toBeGreaterThan(0);
  // The two Phase 1 guarantees, still holding now that capture does more.
  expect(steps.some(s => s.action === 'wait' || s.action === 'waitFor')).toBe(false);
  expect(steps.every(s => (s as any).timeout_ms === undefined),
      'the recorder stamped a timeout again').toBe(true);
});
