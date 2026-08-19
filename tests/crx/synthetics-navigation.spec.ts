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

test('a navigation during a recording becomes evidence, not a second step', async ({ page, o2, baseURL }) => {
  await page.goto(`${baseURL}/index.html`);
  await o2.listen();

  const target = `${baseURL}/v2-login.html`;
  await o2.startRecording(target);

  const recordingPage = await o2.recordingTab('v2-login.html');
  // A navigation reaching the recorder as a signal rather than through the opening seed.
  //
  // This used to assert it produced a SECOND navigate step. It no longer does, and that is
  // the decided behaviour rather than a regression: the journey's first navigation is a
  // step and every navigation after it is evidence on what came before it.
  //
  // The reason it is right for the case that actually matters — a redirect — is that the
  // redirect replays itself. `goto /login` is the durable instruction; landing on `/home`
  // is a result, and baking a result into the instruction would replay a stale URL (often
  // carrying session state) and skip the redirect the monitor is there to check. Recorded
  // as `settle` instead, it becomes the step's wait condition.
  //
  // The cost, accepted knowingly: a navigation the author performs out-of-band — a typed
  // URL, or this explicit goto — is indistinguishable from a redirect and is absorbed the
  // same way. Replay will not reproduce it, so the author adds a navigate step from the
  // editor when a journey needs one. See docs/synthetics/navigation-steps-research.md.
  await recordingPage.goto(`${baseURL}/root.html`);
  await recordingPage.waitForTimeout(1_500);

  await o2.stopRecording();
  await page.waitForTimeout(1_000);

  const steps = await o2.steps();
  const navs = steps.filter(s => s.action === 'navigate');
  expect(navs.map(s => s.url), `the opening navigate was lost: ${describeSteps(steps)}`)
      .toEqual([target]);
  // Not discarded — carried on the opening step as the condition it should settle on.
  expect(
      navs[0]?.settle?.navigation?.url_pattern,
      `the navigation was dropped instead of recorded as evidence: ${JSON.stringify(navs[0]?.settle)}`,
  ).toBe('**/root.html/**');
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

test('a click that causes three SPA route changes records one step', async ({ page, o2, baseURL }) => {
  await page.goto(`${baseURL}/index.html`);
  await o2.listen();

  const target = `${baseURL}/spa-nav.html`;
  await o2.startRecording(target);

  const rec = await o2.recordingTab('spa-nav.html', 20_000);
  await rec.waitForLoadState('domcontentloaded');
  // The injected recorder must attach before a click is captured at all.
  await rec.waitForTimeout(6_000);

  await rec.locator('[data-test="go"]').click({ timeout: 10_000 });
  // Past the last pushState (7.2s) plus settle.
  await rec.waitForTimeout(10_000);

  await o2.stopRecording();
  await page.waitForTimeout(2_000);

  const steps = await o2.steps();
  const navs = steps.filter(s => s.action === 'navigate');
  expect(navs.length, `route changes became their own steps: ${describeSteps(steps)}`).toBe(1);

  const click = steps.find(s => s.action === 'click');
  expect(click, `the click was not recorded: ${describeSteps(steps)}`).toBeTruthy();
  // Three hops were absorbed onto this click. The one worth waiting for is where the page
  // came to rest; /stage-1 is somewhere it passed through and did not stay.
  expect(
      click!.settle?.navigation?.url_pattern,
      `settle names an intermediate hop, not the resting URL: ${JSON.stringify(click!.settle)}`,
  ).toBe('**/stage-3/**');
});

test('opening a recording on a self-navigating page records one navigate', async ({ page, o2, baseURL }) => {
  await page.goto(`${baseURL}/index.html`);
  await o2.listen();

  const target = `${baseURL}/self-nav.html`;
  await o2.startRecording(target);

  const rec = await o2.recordingTab('self-nav.html', 20_000);
  await rec.waitForLoadState('domcontentloaded');
  // No interaction at all. Everything recorded here was recorded by nobody.
  await rec.waitForTimeout(8_000);

  await o2.stopRecording();
  await page.waitForTimeout(2_000);

  const steps = await o2.steps();
  expect(steps.length, `steps appeared with no author action: ${describeSteps(steps)}`).toBe(1);
  expect(steps[0].action).toBe('navigate');
});

test('replaying a stored journey runs every navigate step it contains', async ({ page, o2, baseURL }) => {
  await page.goto(`${baseURL}/index.html`);
  await o2.listen();

  // A journey as it exists in storage today: three consecutive navigates, exactly the
  // shape the recorder no longer PRODUCES. Nothing may collapse or drop them on the way
  // to replay — a step an author has seen and saved is their data, however it got there.
  const stored = [
    { id: 's1', action: 'navigate', name: 'one', url: `${baseURL}/v2-login.html` },
    { id: 's2', action: 'navigate', name: 'two', url: `${baseURL}/root.html` },
    { id: 's3', action: 'navigate', name: 'three', url: `${baseURL}/v2-search.html` },
  ];

  const res = await o2.replay<{ success: boolean; passed: boolean }>(stored, {
    targetUrl: `${baseURL}/v2-login.html`,
    testIdAttr: 'data-test',
  });
  expect(res?.passed, 'a stored three-navigate journey no longer replays').toBe(true);

  // Two results for three steps, and that is correct rather than a step going missing:
  // mapBrowserStepsToActions turns step 0's navigate back into the `openPage` the player
  // needs to create the page before anything can act on it, and an openPage executes as
  // page creation rather than as a step. `replayActionOffset` (background.ts:769) exists
  // for exactly this. The first URL is still visited — it is where the page opens.
  const results = (await o2.pushes()).filter(p => p.method === 'stepReplayResult');
  expect(
      results.map(r => r.stepId),
      `the stored navigates after the opening one did not run: ${JSON.stringify(results)}`,
  ).toEqual(['s2', 's3']);
  expect(
      results.every(r => r.passed),
      `a stored navigate step failed on replay: ${JSON.stringify(results)}`,
  ).toBe(true);
});
