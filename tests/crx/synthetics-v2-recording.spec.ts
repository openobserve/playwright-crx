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
  locator?: { candidates: Array<{ kind: string; value: string }> };
  settle?: {
    navigation?: { url_pattern: string };
    responses?: Array<{ url_pattern: string; method?: string; required: boolean }>;
    observed_duration_ms?: number;
  };
};

/** Send one command over the same content-script bridge the O2 web app uses. */
async function sendCommand<T>(page: any, command: unknown, timeoutMs = 60_000): Promise<T | null> {
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
 * Start recording, tolerating a service worker that is still waking up.
 *
 * The extension's worker is spun up on demand, and under parallel load the first
 * command can land before the bridge port is open. That is a harness race, not a
 * product one — a person clicking "Record" retries by clicking again — so the
 * test does the same rather than asserting on a cold start.
 */
async function startRecording(page: any, targetUrl: string): Promise<void> {
  let last: { success: boolean; error?: string } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    last = await sendCommand<{ success: boolean; error?: string }>(page, {
      action: 'startRecording',
      mode: 'recording',
      testIdAttr: 'data-test',
      targetUrl,
    });
    if (last?.success)
      return;
    await page.waitForTimeout(1_000);
  }
  throw new Error(`startRecording never succeeded: ${last?.error ?? '(no response — is dist/ built?)'}`);
}

/**
 * Start collecting the step lists the extension pushes.
 *
 * `setActions` arrives repeatedly as the recording grows, so the last one is the
 * whole journey. Collected on the page rather than polled, because a push that
 * arrives between polls is a step silently missing from the assertion.
 */
async function collectSteps(page: any): Promise<void> {
  await page.evaluate(() => {
    (window as any).__recordedSteps = [];
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window) return;
      if (event.data?.ch !== 'oo-bridge' || event.data?.dir !== 'to-page') return;
      const payload = event.data?.msg?.payload;
      if (payload?.method === 'setActions' && Array.isArray(payload.browserSteps))
        (window as any).__recordedSteps = payload.browserSteps;
    });
    window.postMessage({ ch: 'oo-bridge-probe' }, '*');
  });
}

async function recordedSteps(page: any): Promise<RecordedStep[]> {
  return page.evaluate(() => (window as any).__recordedSteps ?? []);
}

test('a recorded click carries a locator bundle, a settle block, and its duration', async ({
  page, context, baseURL, extensionServiceWorker,
}) => {
  await page.goto(`${baseURL}/index.html`);
  await collectSteps(page);

  const target = `${baseURL}/v2-login.html`;
  await startRecording(page, target);

  // The extension opened its own recording tab; drive that, as a person would.
  const recordingPage = await context.waitForEvent('page', {
    predicate: p => p.url().includes('v2-login.html'),
    timeout: 30_000,
  }).catch(() => context.pages().find(p => p.url().includes('v2-login.html')));
  expect(recordingPage, 'the recording tab never opened').toBeTruthy();

  await recordingPage!.waitForLoadState('domcontentloaded');
  await recordingPage!.locator('[data-test="login-user-id-field"]').click();
  await recordingPage!.locator('[data-test="login-user-id-field"]').fill('omkar@openobserve.ai');
  await recordingPage!.locator('[data-test="login-sign-in"]').click();

  // Let the navigation land so its signal is attached to the click.
  await recordingPage!.waitForURL(/\/web\//, { timeout: 30_000 }).catch(() => {});
  await recordingPage!.waitForTimeout(3_000);

  await sendCommand(page, { action: 'stopRecording' });
  await page.waitForTimeout(1_000);

  const steps = await recordedSteps(page);
  expect(steps.length, 'nothing was recorded').toBeGreaterThan(1);

  const signIn = steps.find(s => s.selector?.includes('login-sign-in'));
  expect(signIn, `no sign-in step in ${JSON.stringify(steps.map(s => s.selector))}`).toBeTruthy();

  // ── Phase 2 T3: the ranked list reaches the stored step ────────────────────
  expect(signIn!.locator?.candidates?.length,
      'only one candidate — multiple:true is not reaching the generator').toBeGreaterThan(1);
  // The test attribute is what the fixture makes most stable, so it must lead.
  expect(signIn!.locator!.candidates[0].kind).toBe('test_attribute');
  // The primary stays where a v1 consumer looks for it.
  expect(signIn!.selector).toBe(signIn!.locator!.candidates[0].value);

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

test('a recorded journey contains no hard sleep and no stamped timeout', async ({
  page, context, baseURL, extensionServiceWorker,
}) => {
  await page.goto(`${baseURL}/index.html`);
  await collectSteps(page);

  const target = `${baseURL}/v2-login.html`;
  await startRecording(page, target);

  const recordingPage = await context.waitForEvent('page', {
    predicate: p => p.url().includes('v2-login.html'),
    timeout: 30_000,
  }).catch(() => context.pages().find(p => p.url().includes('v2-login.html')));
  await recordingPage!.waitForLoadState('domcontentloaded');
  await recordingPage!.locator('[data-test="login-sign-in"]').click();
  await recordingPage!.waitForTimeout(3_000);

  await sendCommand(page, { action: 'stopRecording' });
  await page.waitForTimeout(1_000);

  const steps = await recordedSteps(page);
  expect(steps.length).toBeGreaterThan(0);
  // The two Phase 1 guarantees, still holding now that capture does more.
  expect(steps.some(s => s.action === 'wait' || s.action === 'waitFor')).toBe(false);
  expect(steps.every(s => (s as any).timeout_ms === undefined),
      'the recorder stamped a timeout again').toBe(true);
});
