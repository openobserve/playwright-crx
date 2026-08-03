/**
 * Browser verification for STOPPING a replay.
 *
 * Runs the REAL extension in real Chrome and drives it through the same
 * postMessage bridge the O2 web app uses, so this exercises the shipping path.
 *
 * What is being proved:
 *
 *   1. Stop lands on the step that is running, not one step later. CrxPlayer.stop()
 *      used to set a flag that was only read by _checkStopped() at the START of an
 *      action, so the in-flight click/fill/expect ran to completion first — up to
 *      kActionTimeout, 60s. stop() now aborts the pending call via the context's
 *      own stopPendingOperations().
 *
 *   2. A cancelled replay reports `stopped`, not a failure. Before, a step blocked
 *      on a slow element ran out its timeout and threw; run()'s outer catch rethrew
 *      it (the error is not the Stopped marker), so `_stopping` was never resolved
 *      and the promise stop() awaits never settled at all.
 *
 *   3. No step is announced after a stop. The loop used to advance past the
 *      interrupted step and emit `stepStarted` for the next one before throwing
 *      Stopped — a step that could never report a result, which the O2 journey
 *      rendered as a status dot spinning forever.
 *
 * The companion unit-level proofs live in the O2 web app:
 * web/src/composables/useSyntheticsRecorder.spec.ts and
 * web/src/components/synthetics/journey/BrowserJourney.spec.ts.
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

// A replay attaches a CRX app to an incognito window; two running at once race
// each other for it ("Tab is not in the expected browser context").
test.describe.configure({ mode: 'serial' });

type ReplayResponse = {
  success: boolean;
  passed: boolean;
  stopped?: boolean;
  error?: string;
};

/**
 * How long the interrupted step would block for if the stop did NOT abort it.
 * Comfortably longer than any bound this test waits on, so a stop that merely
 * lands at the next step boundary cannot pass by being fast enough.
 */
const BLOCKING_STEP_MS = 40_000;

/** Ceiling for the stop round-trip. Well under BLOCKING_STEP_MS. */
const STOP_MUST_LAND_WITHIN_MS = 15_000;

/**
 * Install a collector for the extension's streamed replay events and open the
 * bridge, then fire `replay` WITHOUT awaiting it — the point of this test is
 * what happens while it is still in flight.
 */
async function startReplayAndCollect(page: any, steps: unknown[], targetUrl: string) {
  await page.evaluate(
      async ({ steps, targetUrl }: any) => {
        const w = window as any;
        w.__ooEvents = [];
        w.addEventListener('message', (event: MessageEvent) => {
          if (event.source !== window) return;
          if ((event.data as any)?.ch !== 'oo-bridge') return;
          if ((event.data as any)?.dir !== 'to-page') return;
          const msg = (event.data as any).msg;
          if (msg?.type === 'synthetics-recorder') w.__ooEvents.push(msg.payload);
        });

        window.postMessage({ ch: 'oo-bridge-probe' }, '*');
        await new Promise(r => setTimeout(r, 500));

        const nonce = `replay${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
        w.__ooReplay = new Promise(resolve => {
          function onMessage(event: MessageEvent) {
            if (event.source !== window) return;
            if ((event.data as any)?.ch !== 'oo-bridge') return;
            if ((event.data as any)?.dir !== 'to-page') return;
            const { nonce: got, msg } = event.data as any;
            if (got !== nonce && msg?.nonce !== nonce) return;
            window.removeEventListener('message', onMessage);
            resolve(msg?.response ?? msg);
          }
          window.addEventListener('message', onMessage);
        });

        window.postMessage(
            {
              ch: 'oo-bridge', dir: 'to-ext', nonce,
              msg: { type: 'synthetics-command', command: { action: 'replay', steps, targetUrl } },
            },
            '*');
      },
      { steps, targetUrl });
}

/** Send `stopReplay` and wait for the extension's acknowledgement. */
async function sendStopReplay(page: any, timeoutMs: number): Promise<unknown> {
  return page.evaluate(
      async ({ timeoutMs }: any) => {
        const nonce = `stop${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
        return await new Promise(resolve => {
          const timer = setTimeout(() => {
            window.removeEventListener('message', onMessage);
            resolve(null);
          }, timeoutMs);

          function onMessage(event: MessageEvent) {
            if (event.source !== window) return;
            if ((event.data as any)?.ch !== 'oo-bridge') return;
            if ((event.data as any)?.dir !== 'to-page') return;
            const { nonce: got, msg } = event.data as any;
            if (got !== nonce && msg?.nonce !== nonce) return;
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            resolve(msg?.response ?? msg);
          }

          window.addEventListener('message', onMessage);
          window.postMessage(
              {
                ch: 'oo-bridge', dir: 'to-ext', nonce,
                msg: { type: 'synthetics-command', command: { action: 'stopReplay' } },
              },
              '*');
        });
      },
      { timeoutMs });
}

const collectedEvents = (page: any) => page.evaluate(() => (window as any).__ooEvents ?? []);

/**
 * A journey whose third step blocks: the profile icon only appears
 * BLOCKING_STEP_MS after the sign-in click, so the assert sits waiting on it —
 * which is exactly the state a user presses Stop in.
 */
function blockingJourney(target: string) {
  return [
    { id: 's1', action: 'navigate', name: 'Open fixture', url: target, pageAlias: 'page', framePath: [] },
    {
      id: 's2', action: 'click', name: 'Sign In',
      locator: { candidates: [{ kind: 'test_attribute', value: '[data-test="login-sign-in"]' }] },
      pageAlias: 'page', framePath: [],
    },
    {
      id: 's3', action: 'click', name: 'Profile icon (blocks)',
      locator: { candidates: [{ kind: 'test_attribute', value: '[data-test="header-my-account-profile-icon"]' }] },
      pageAlias: 'page', framePath: [],
    },
    {
      // Must never start. Reaching this step is the orphan `stepStarted` bug.
      id: 's4', action: 'click', name: 'Never reached',
      locator: { candidates: [{ kind: 'test_attribute', value: '[data-test="login-sign-in"]' }] },
      pageAlias: 'page', framePath: [],
    },
  ];
}

test('stopping a replay interrupts the step in flight and reports stopped', async ({ page, baseURL, extensionServiceWorker }) => {
  await page.goto(`${baseURL}/slow-login.html`);

  const target = `${baseURL}/slow-login.html?delay=${BLOCKING_STEP_MS}`;
  await startReplayAndCollect(page, blockingJourney(target), target);

  // Wait until the blocking step has actually been announced, so Stop is pressed
  // mid-action rather than between steps.
  await expect.poll(
      async () => (await collectedEvents(page))
          .some((e: any) => e.method === 'stepReplayStarted' && e.stepId === 's3'),
      { message: 'the blocking step never started', timeout: 60_000 },
  ).toBe(true);

  const startedAt = Date.now();
  const ack = await sendStopReplay(page, STOP_MUST_LAND_WITHIN_MS);
  const stopTookMs = Date.now() - startedAt;

  // 1. The stop was acknowledged, and long before the blocked step would have
  //    given up on its own.
  expect(ack, 'the extension never acknowledged stopReplay').not.toBeNull();
  expect(
      stopTookMs,
      `stop took ${stopTookMs}ms — it waited out the in-flight action instead of aborting it`,
  ).toBeLessThan(STOP_MUST_LAND_WITHIN_MS);

  // 2. The replay reports a cancellation, not a timeout failure.
  const res = await page.evaluate(() => (window as any).__ooReplay) as ReplayResponse | null;
  expect(res, 'no replay response').not.toBeNull();
  expect(
      res!.stopped,
      `replay did not report stopped: ${JSON.stringify(res)}`,
  ).toBe(true);

  // 3. Nothing was announced after the interrupted step.
  const events = await collectedEvents(page);
  const startedIds = events.filter((e: any) => e.method === 'stepReplayStarted').map((e: any) => e.stepId);
  expect(
      startedIds,
      'a step was announced after the stop — it can never report a result, and the journey renders it as permanently in progress',
  ).not.toContain('s4');

  // The steps that completed before the stop still reported honestly.
  const resultIds = events.filter((e: any) => e.method === 'stepReplayResult').map((e: any) => e.stepId);
  expect(resultIds, 'the steps that ran before the stop lost their results').toContain('s2');
});
