/**
 * Browser verification for restore-then-record (P2 / P3).
 *
 * The unit tests on the O2 side prove the wiring: which command goes out, where the
 * returned steps get spliced, what gets invalidated. None of them can prove the claim
 * the feature actually rests on — that the extension REPLAYS the earlier steps in a
 * real browser, leaves that browser in the state they produced, and then records into
 * it, handing back only what the author did.
 *
 * That is what this file tests, driving the extension exactly as the O2 web app does:
 * over the content-script bridge, with no reach into internals the web app could not
 * reach itself.
 *
 * See docs/synthetics/record-from-step-design.md §4 and §7.6.
 */
import path from 'path';
import { test, expect } from './crxTest';

const EXTENSION_PATH = path.join(
    __dirname, '..', '..', 'examples', 'synthetics-recorder', 'dist');

test.use({
  extensionPath: EXTENSION_PATH,
  ...(process.env.CRX_CHANNEL ? { channel: process.env.CRX_CHANNEL } : {}),
  enabledInIncognito: true,
});

test.slow();

type RecordedStep = {
  id: string;
  action: string;
  selector?: string;
  url?: string;
  value?: string;
  locator?: { candidates: Array<{ kind: string; value: string }> };
};

/**
 * How a recorded step names its element.
 *
 * The locator bundle, not `selector`: a version-2 step's identity IS the bundle, and
 * the recorder does not populate a top-level `selector` on the wire. Reading the wrong
 * field made this look like the author's action had not been recorded at all.
 */
const targets = (step: RecordedStep): string =>
  [step.selector, ...(step.locator?.candidates ?? []).map(c => c.value)].filter(Boolean).join(' ');

/** One command over the same bridge the O2 web app uses. */
async function sendCommand<T>(page: any, command: unknown, timeoutMs = 90_000): Promise<T | null> {
  return page.evaluate(
      async ({ command, timeoutMs }: any) => {
        window.postMessage({ ch: 'oo-bridge-probe' }, '*');
        await new Promise(r => setTimeout(r, 500));

        const nonce = `t${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
        return await new Promise(resolve => {
          const timer = setTimeout(() => {
            window.removeEventListener('message', onMessage);
            resolve(null);
          }, timeoutMs);
          function onMessage(event: MessageEvent) {
            if (event.source !== window) return;
            if (event.data?.ch !== 'oo-bridge' || event.data?.dir !== 'to-page') return;
            const { nonce: got, msg } = event.data;
            if (got !== nonce && msg?.nonce !== nonce) return;
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            resolve(msg?.response ?? msg);
          }
          window.addEventListener('message', onMessage);
          window.postMessage(
              { ch: 'oo-bridge', dir: 'to-ext', nonce, msg: { type: 'synthetics-command', command } },
              '*');
        });
      },
      { command, timeoutMs });
}

/**
 * Collect the pushes the extension streams, the way the web app's composable does.
 *
 * Collected on the page rather than polled: a push that lands between polls is a step
 * — or a failure — silently missing from the assertion.
 */
async function collectPushes(page: any): Promise<void> {
  await page.evaluate(() => {
    (window as any).__recordedSteps = [];
    (window as any).__started = null;
    (window as any).__prefixFailed = null;
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window) return;
      if (event.data?.ch !== 'oo-bridge' || event.data?.dir !== 'to-page') return;
      const payload = event.data?.msg?.payload;
      if (!payload) return;
      if (payload.method === 'setActions' && Array.isArray(payload.browserSteps))
        (window as any).__recordedSteps = payload.browserSteps;
      if (payload.method === 'recordingStarted') (window as any).__started = payload;
      if (payload.method === 'prefixFailed') (window as any).__prefixFailed = payload;
    });
    window.postMessage({ ch: 'oo-bridge-probe' }, '*');
  });
}

const pushes = (page: any) => page.evaluate(() => ({
  steps: (window as any).__recordedSteps ?? [],
  started: (window as any).__started,
  prefixFailed: (window as any).__prefixFailed,
}));

/** A locator bundle, which is how a step names its element — never a bare selector. */
const at = (css: string) => ({ candidates: [{ kind: 'css', value: css }] });

/**
 * Start a restore-then-record session, retrying a cold service worker.
 *
 * The worker spins up on demand and under parallel load the first command can land
 * before the bridge port is open. That is a harness race, not a product one — a person
 * clicking Record retries by clicking again.
 */
async function startRecordingFrom(page: any, prefixSteps: unknown[], targetUrl: string) {
  let last: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    last = await sendCommand<any>(page, {
      action: 'startRecordingFrom', prefixSteps, targetUrl, testIdAttr: 'data-test',
    });
    if (last && (last.success || last.failedStepId)) return last;
    await page.waitForTimeout(1_000);
  }
  return last;
}

/**
 * The whole point of P2, end to end.
 *
 * The prefix fills the username field. If the restore really happened, the recording
 * window is sitting on the login page with that field ALREADY filled — so the click
 * recorded afterwards is captured against the post-prefix state, which is the thing
 * appending has never been able to do.
 */
test('the prefix is replayed and the browser is left in the state it produced', async ({
  page, context, baseURL, extensionServiceWorker,
}) => {
  await page.goto(`${baseURL}/index.html`);
  await collectPushes(page);

  const target = `${baseURL}/v2-login.html`;
  const res = await startRecordingFrom(page, [
    { id: 'p1', action: 'navigate', url: target },
    { id: 'p2', action: 'type', locator: at('[data-test="login-user-id-field"]'), value: 'user@example.test' },
  ], target);

  expect(res?.success, `startRecordingFrom failed: ${res?.error ?? '(no response — is dist/ built?)'}`).toBe(true);

  const recordingPage = await context.waitForEvent('page', {
    predicate: p => p.url().includes('v2-login.html'),
    timeout: 30_000,
  }).catch(() => context.pages().find((p: any) => p.url().includes('v2-login.html')));
  expect(recordingPage, 'the recording tab never opened').toBeTruthy();
  await recordingPage!.waitForLoadState('domcontentloaded');

  // The evidence that the restore ran: the prefix's typing is on the page.
  await expect(recordingPage!.locator('[data-test="login-user-id-field"]'))
      .toHaveValue('user@example.test', { timeout: 15_000 });
});

/**
 * The artifact test. `RecorderCollection` logs openPage/closePage past its own enabled
 * guard, so without the reset at the mode flip the first "recorded" step of every
 * session is a navigate the author never performed.
 */
test('only the steps the author performed are recorded, not the restore', async ({
  page, context, baseURL, extensionServiceWorker,
}) => {
  await page.goto(`${baseURL}/index.html`);
  await collectPushes(page);

  const target = `${baseURL}/v2-login.html`;
  const res = await startRecordingFrom(page, [
    { id: 'p1', action: 'navigate', url: target },
    { id: 'p2', action: 'type', locator: at('[data-test="login-user-id-field"]'), value: 'user@example.test' },
  ], target);
  expect(res?.success, `startRecordingFrom failed: ${res?.error}`).toBe(true);

  const recordingPage = await context.waitForEvent('page', {
    predicate: p => p.url().includes('v2-login.html'),
    timeout: 30_000,
  }).catch(() => context.pages().find((p: any) => p.url().includes('v2-login.html')));
  await recordingPage!.waitForLoadState('domcontentloaded');

  // The author's one and only action this session.
  await recordingPage!.locator('[data-test="login-password-field"]').click();
  await recordingPage!.locator('[data-test="login-password-field"]').fill('hunter2');
  await recordingPage!.waitForTimeout(2_000);

  await sendCommand(page, { action: 'stopRecording' });
  await page.waitForTimeout(1_000);

  const { steps, started } = await pushes(page);

  expect(started?.mode, 'the session did not announce itself as an insert').toBe('insert');
  expect(started?.baselineStepCount,
      'the collection was not reset at the mode flip, so restore artifacts are being handed back as recorded steps')
      .toBe(0);

  const captured = (steps as RecordedStep[]).map(s => s.action);
  expect(captured,
      `the restore leaked into the capture: ${JSON.stringify(steps, null, 2)}`)
      .not.toContain('navigate');
  expect((steps as RecordedStep[]).some(s => targets(s).includes('login-password-field')),
      `the author's own action was not recorded: ${JSON.stringify(steps, null, 2)}`)
      .toBe(true);

  // The prefix filled the USERNAME field. Seeing it here would mean the replay was
  // captured as if the author had done it — the leak the reset exists to prevent.
  expect((steps as RecordedStep[]).some(s => targets(s).includes('login-user-id-field')),
      `a step from the replayed prefix was captured as the author's own: ${JSON.stringify(steps, null, 2)}`)
      .toBe(false);
});

/**
 * The recovery path (design §7.6).
 *
 * A prefix step that cannot resolve must stop the restore, name the step it stopped
 * on, and — critically — leave the session alive, because the browser is then sitting
 * where that step stopped, which is exactly where an author fixing it wants to be.
 */
test('a prefix that cannot be replayed reports the step it stopped on', async ({
  page, context, baseURL, extensionServiceWorker,
}) => {
  await page.goto(`${baseURL}/index.html`);
  await collectPushes(page);

  const target = `${baseURL}/v2-login.html`;
  const res = await startRecordingFrom(page, [
    { id: 'p1', action: 'navigate', url: target },
    { id: 'p2', action: 'click', locator: at('[data-test="this-element-does-not-exist"]') },
  ], target);

  expect(res?.success, 'a restore that could not reach its target reported success').toBe(false);
  expect(res?.failedStepId, 'the failure did not say which step stopped it').toBe('p2');

  const { prefixFailed } = await pushes(page);
  expect(prefixFailed?.stepId,
      'no prefixFailed was streamed, so the web app cannot offer the re-anchor recovery').toBe('p2');

  // The window is still there — the recovery is a mode flip, not another replay.
  const stillOpen = context.pages().some((p: any) => p.url().includes('v2-login.html'));
  expect(stillOpen,
      'the session was torn down on failure, so recovering means replaying the whole prefix again').toBe(true);
});

/**
 * Start a restore WITHOUT waiting for it to finish.
 *
 * Every test below acts while the prefix is still replaying — closing the window,
 * cancelling — so the command promise has to be held rather than awaited. The
 * service worker is woken first, because the retry the awaiting helper uses to
 * absorb a cold start is not available here.
 */
async function startRestoreInFlight(page: any, prefixSteps: unknown[], targetUrl: string) {
  await sendCommand(page, { action: 'getStatus' }, 10_000);
  return sendCommand<any>(page, {
    action: 'startRecordingFrom', prefixSteps, targetUrl, testIdAttr: 'data-test',
  });
}

/** A prefix whose second step waits on an element that never appears. */
const stalls = (target: string) => [
  { id: 'p1', action: 'navigate', url: target },
  { id: 'p2', action: 'click', locator: at('[data-test="this-element-does-not-exist"]') },
];

/** The recording window, once the restore has opened it. */
async function waitForRecordingPage(context: any, url = 'v2-login.html') {
  const found = await context.waitForEvent('page', {
    predicate: (p: any) => p.url().includes(url), timeout: 30_000,
  }).catch(() => context.pages().find((p: any) => p.url().includes(url)));
  expect(found, 'the recording window never opened').toBeTruthy();
  await found!.waitForLoadState('domcontentloaded').catch(() => {});
  return found!;
}

/**
 * The screenshot this work started from.
 *
 * Closing the recorder window is how an author walks away from a restore — for a
 * long time it was the ONLY way out. The player can only report that as the action
 * it was running rejecting, and reported as such the web app blames a step that
 * never ran and offers a recovery for a session that no longer exists.
 *
 * Only the service worker can tell the two apart: it watched the tab go away.
 */
test('closing the recorder window is reported as a cancel, not a failed step', async ({
  page, context, baseURL, extensionServiceWorker,
}) => {
  await page.goto(`${baseURL}/index.html`);
  await collectPushes(page);

  const target = `${baseURL}/v2-login.html`;
  const pending = startRestoreInFlight(page, stalls(target), target);

  const recordingPage = await waitForRecordingPage(context);
  // The stalling step is now waiting on an element that will never appear.
  await page.waitForTimeout(2_000);
  await recordingPage.close();

  await pending;
  await page.waitForTimeout(1_000);

  const { prefixFailed } = await pushes(page);
  expect(prefixFailed, 'the close was never reported at all').toBeTruthy();
  expect(prefixFailed?.reason,
      'a window the author closed is reported as a step that failed, so the web app blames the journey for something the author did')
      .toBe('window-closed');
});

/**
 * The same ending by the other route — and the one the player does NOT throw for.
 *
 * `CrxPlayer.run` swallows its own Stopped error and returns normally, so a cancel
 * comes back through the SUCCESS path. Left unhandled, the extension flips into
 * recording on a session the author just abandoned, and reports it started.
 */
test('cancelling a restore is reported as a cancel, and does not start recording', async ({
  page, context, baseURL, extensionServiceWorker,
}) => {
  await page.goto(`${baseURL}/index.html`);
  await collectPushes(page);

  const target = `${baseURL}/v2-login.html`;
  const pending = startRestoreInFlight(page, stalls(target), target);

  await waitForRecordingPage(context);
  await page.waitForTimeout(2_000);
  await sendCommand(page, { action: 'stopReplay' }, 10_000);

  const res = await pending;
  await page.waitForTimeout(1_000);

  const { prefixFailed, started } = await pushes(page);
  expect(res?.success, 'an abandoned restore reported success').toBe(false);
  expect(prefixFailed?.reason, 'the cancel was not reported as one').toBe('cancelled');
  expect(started,
      'the extension flipped into recording on a session the author had just cancelled')
      .toBeFalsy();
});

/**
 * The recovery of design §7.6, which the failing-prefix test above only sets up.
 *
 * The browser is still sitting where the failing step stopped — a legitimate restored
 * state, simply an earlier one than was asked for. Recording from there is a mode flip
 * on the live session: no teardown, no second replay, no wasted minute. What it hands
 * back must be as clean as a normal restore's capture — the author's actions and
 * nothing the restore left behind.
 */
test('recording resumes on the session a failed prefix left open', async ({
  page, context, baseURL, extensionServiceWorker,
}) => {
  await page.goto(`${baseURL}/index.html`);
  await collectPushes(page);

  const target = `${baseURL}/v2-login.html`;
  // Wake the worker before starting, as the in-flight helper above does.
  //
  // Not incidental: against a COLD worker the first command can be lost, and the
  // retrying helper then fires a second `startRecordingFrom` while the first is still
  // opening its window — the second's `prepareRecordingWindow` closes the first's
  // CrxApplication, and the session this test needs to record into is gone. Measured:
  // 0 of 3 without this line, and the worker was never restarting.
  await sendCommand(page, { action: 'getStatus' }, 10_000);

  const res = await startRecordingFrom(page, stalls(target), target);
  expect(res?.failedStepId, 'the prefix did not fail where this test needs it to').toBe('p2');

  // A timeout is a step that failed, never a window that went away — the session has
  // to still be there for the recovery to have anything to record into.
  expect((await pushes(page)).prefixFailed?.reason,
      'a step that timed out was reported as something that ends the session').toBe('step-failed');

  const resumed = await sendCommand<any>(page, { action: 'recordFromHere' }, 30_000);
  expect(resumed?.success,
      `recording could not resume on the open session: ${resumed?.error ?? '(no response)'}`)
      .toBe(true);

  const recordingPage = context.pages().filter(
      (p: any) => !p.isClosed() && p.url().includes('v2-login.html')).pop();
  expect(recordingPage, 'the failed restore left no window to record in').toBeTruthy();
  await recordingPage!.locator('[data-test="login-password-field"]').click();
  await recordingPage!.locator('[data-test="login-password-field"]').fill('hunter2');
  await recordingPage!.waitForTimeout(2_000);

  await sendCommand(page, { action: 'stopRecording' });
  await page.waitForTimeout(1_000);

  const { steps, started } = await pushes(page);
  expect(started?.mode, 'the resumed session did not announce itself as an insert').toBe('insert');
  expect((steps as RecordedStep[]).some(s => targets(s).includes('login-password-field')),
      `the author's action was not recorded: ${JSON.stringify(steps, null, 2)}`)
      .toBe(true);
  // Same rule as a normal restore: the collection is reset at the flip, so nothing
  // the restore logged while disabled heads the author's block.
  expect((steps as RecordedStep[]).map(s => s.action),
      `the failed restore leaked into the capture: ${JSON.stringify(steps, null, 2)}`)
      .not.toContain('navigate');
});

/**
 * Two restore-then-record sessions back to back, in one browser session.
 *
 * "Record more steps" twice in a row is ordinary, and the O2 UI flow reproduces a
 * failure there that a single session does not show: the second session announces
 * itself as recording and then captures nothing at all. This is the same sequence
 * without the web app, so a failure here is squarely in the extension.
 */
test('a second restore-then-record session still captures the author actions', async ({
  page, context, baseURL, extensionServiceWorker,
}) => {
  await page.goto(`${baseURL}/index.html`);
  await collectPushes(page);

  const target = `${baseURL}/v2-login.html`;
  const prefix = [
    { id: 'p1', action: 'navigate', url: target },
    { id: 'p2', action: 'type', locator: at('[data-test="login-user-id-field"]'), value: 'user@example.test' },
  ];

  // ── Session one ───────────────────────────────────────────────────────────
  let res = await startRecordingFrom(page, prefix, target);
  expect(res?.success, `first startRecordingFrom failed: ${res?.error}`).toBe(true);
  let rec = await context.waitForEvent('page', {
    predicate: (p: any) => p.url().includes('v2-login.html'), timeout: 30_000,
  }).catch(() => context.pages().find((p: any) => p.url().includes('v2-login.html')));
  await rec!.waitForLoadState('domcontentloaded');
  await rec!.locator('[data-test="login-password-field"]').fill('first');
  await rec!.waitForTimeout(2_000);
  await sendCommand(page, { action: 'stopRecording' });
  await page.waitForTimeout(1_500);

  const firstSteps = (await pushes(page)).steps as RecordedStep[];
  expect(firstSteps.length, 'the FIRST session captured nothing').toBeGreaterThan(0);

  // ── Session two, same browser session ─────────────────────────────────────
  await page.evaluate(() => { (window as any).__recordedSteps = []; });
  res = await startRecordingFrom(page, prefix, target);
  expect(res?.success, `second startRecordingFrom failed: ${res?.error}`).toBe(true);

  const rec2 = context.pages().filter((p: any) => !p.isClosed() && p.url().includes('v2-login.html')).pop();
  expect(rec2, 'the second session opened no recording window').toBeTruthy();
  await rec2!.waitForLoadState('domcontentloaded');
  await rec2!.locator('[data-test="login-password-field"]').click();
  await rec2!.locator('[data-test="login-password-field"]').fill('second');
  await rec2!.waitForTimeout(2_500);

  await sendCommand(page, { action: 'stopRecording' });
  await page.waitForTimeout(1_500);

  const secondSteps = (await pushes(page)).steps as RecordedStep[];
  expect(secondSteps.length,
      `the second session recorded nothing — the recorder flipped to recording but captured no actions: ${JSON.stringify(secondSteps)}`)
      .toBeGreaterThan(0);
});

/**
 * Plain recording first, THEN a restore session — the exact sequence the O2 UI
 * produces and the only structural difference from the test above, which passes.
 *
 * In the web app the first capture of a new check is a plain `startRecording`; only
 * the second is a restore. If a leftover from the plain session is what stops the
 * restore session capturing, it shows up here and nowhere else.
 */
test('a restore session after a plain recording still captures', async ({
  page, context, baseURL, extensionServiceWorker,
}) => {
  await page.goto(`${baseURL}/index.html`);
  await collectPushes(page);

  const target = `${baseURL}/v2-login.html`;

  // ── Session one: PLAIN recording, as the web app does for a new check ──────
  let started: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    started = await sendCommand<any>(page, {
      action: 'startRecording', mode: 'recording', testIdAttr: 'data-testid', targetUrl: target,
    });
    if (started?.success) break;
    await page.waitForTimeout(1_000);
  }
  expect(started?.success, `plain startRecording failed: ${started?.error}`).toBe(true);

  let rec = await context.waitForEvent('page', {
    predicate: (p: any) => p.url().includes('v2-login.html'), timeout: 30_000,
  }).catch(() => context.pages().find((p: any) => p.url().includes('v2-login.html')));
  await rec!.waitForLoadState('domcontentloaded');
  await rec!.locator('[data-test="login-user-id-field"]').click();
  await rec!.locator('[data-test="login-user-id-field"]').fill('user@example.test');
  await rec!.waitForTimeout(2_000);
  await sendCommand(page, { action: 'stopRecording' });
  await page.waitForTimeout(1_500);

  const firstSteps = (await pushes(page)).steps as RecordedStep[];
  expect(firstSteps.length, 'the plain recording captured nothing').toBeGreaterThan(0);

  // ── Session two: restore-then-record over what session one produced ────────
  await page.evaluate(() => { (window as any).__recordedSteps = []; });
  const res = await startRecordingFrom(page, [
    { id: 'p1', action: 'navigate', url: target },
    { id: 'p2', action: 'type', locator: at('[data-test="login-user-id-field"]'), value: 'user@example.test' },
  ], target);
  expect(res?.success, `startRecordingFrom after a plain recording failed: ${res?.error}`).toBe(true);

  const rec2 = context.pages().filter((p: any) => !p.isClosed() && p.url().includes('v2-login.html')).pop();
  expect(rec2, 'the restore session opened no recording window').toBeTruthy();
  await rec2!.waitForLoadState('domcontentloaded');
  await rec2!.locator('[data-test="login-password-field"]').click();
  await rec2!.locator('[data-test="login-password-field"]').fill('secret');
  await rec2!.waitForTimeout(2_500);

  await sendCommand(page, { action: 'stopRecording' });
  await page.waitForTimeout(1_500);

  const secondSteps = (await pushes(page)).steps as RecordedStep[];
  expect(secondSteps.length,
      `the restore session after a plain recording captured nothing: ${JSON.stringify(secondSteps)}`)
      .toBeGreaterThan(0);
});
