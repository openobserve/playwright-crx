/**
 * Phase 1 browser verification for the synthetics recorder extension.
 *
 * Runs the REAL extension in REAL Google Chrome (channel: 'chrome', not the
 * bundled Chromium) and drives it through the same postMessage bridge the O2 web
 * app uses (content.ts <-> background.ts), so these exercise the shipping path
 * rather than a harness approximation.
 *
 * What is being proved, in behaviour rather than constants:
 *
 *   1. A step whose element appears after ~8s replays GREEN. Under the previous
 *      5s cap (crxPlayer kActionTimeout, inherited verbatim from upstream
 *      Playwright's Inspector) the identical journey fails. This is the shape of
 *      the production failure: `locator.waitFor: Timeout 10000ms exceeded` on
 *      [data-test="header-my-account-profile-icon"] during SPA boot.
 *
 *   2. A journey containing a legacy `wait` step replays to completion. Before
 *      this phase, buildActionFromStep threw during MAPPING — before step 1 — so
 *      the whole replay died and nothing ran. Every one of the five production
 *      monitors carries a `wait | Delay 30000`, which is why none of them could
 *      be test-replayed at all.
 *
 * See docs/synthetics/issues/phase-1-slow-page.md (T1, T7, T8) in the
 * openobserve repo.
 */
import path from 'path';
import { test, expect } from './crxTest';

const EXTENSION_PATH = path.join(
    __dirname, '..', '..', 'examples', 'synthetics-recorder', 'dist');

// Real Chrome, per the verification requirement — not Playwright's Chromium.
// enabledInIncognito is required: replay opens an incognito window
// (background.ts prepareRecordingWindow), and without the toggle
// chrome.windows.create({incognito:true}) fails and replay throws.
// CRX_CHANNEL=chrome runs the installed Google Chrome; unset uses Playwright's
// bundled Chromium. Newer Chrome builds restrict --load-extension, so the
// bundled Chromium is the fallback when the installed one refuses to load an
// unpacked extension.
test.use({
  extensionPath: EXTENSION_PATH,
  ...(process.env.CRX_CHANNEL ? { channel: process.env.CRX_CHANNEL } : {}),
  enabledInIncognito: true,
});

test.slow();

type ReplayResponse = {
  success: boolean;
  passed: boolean;
  stopped?: boolean;
  error?: string;
};

/**
 * Drive the extension exactly as the O2 web app does: wake the content-script
 * bridge with `oo-bridge-probe`, then exchange nonce-tagged messages on the
 * `oo-bridge` channel. Mirrors useSyntheticsRecorder.sendCommand.
 */
async function sendCommand<T>(page: any, command: unknown, timeoutMs = 120_000): Promise<T | null> {
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

test('the extension is reachable over the content-script bridge', async ({ page, baseURL, extensionServiceWorker }) => {
  await page.goto(`${baseURL}/slow-login.html`);
  const status = await sendCommand<{ isRecording: boolean }>(page, { action: 'getStatus' }, 20_000);
  expect(status, 'extension did not answer getStatus — is dist/ built?').not.toBeNull();
});

test('a step whose element appears after 8s replays green (was impossible at the 5s cap)', async ({ page, baseURL, extensionServiceWorker }) => {
  await page.goto(`${baseURL}/slow-login.html`);

  const target = `${baseURL}/slow-login.html?delay=8000`;
  const steps = [
    { id: 's1', action: 'navigate', name: 'Open fixture', url: target, pageAlias: 'page', framePath: [] },
    {
      id: 's2', action: 'click', name: 'Sign In',
      locator: { candidates: [{ kind: 'test_attribute', value: '[data-test="login-sign-in"]' }] },
      pageAlias: 'page', framePath: [],
    },
    {
      // The element does not exist until ~8s after the click above. At the old
      // 5s cap this step could not pass, no matter how healthy the app was.
      id: 's3', action: 'click', name: 'Profile icon',
      locator: { candidates: [{ kind: 'test_attribute', value: '[data-test="header-my-account-profile-icon"]' }] },
      pageAlias: 'page', framePath: [],
    },
  ];

  const res = await sendCommand<ReplayResponse>(page, { action: 'replay', steps, targetUrl: target });

  expect(res, 'no replay response').not.toBeNull();
  expect(res!.passed, `replay failed: ${res!.error ?? '(no error)'}`).toBe(true);
});

test('a legacy wait step no longer aborts the whole replay', async ({ page, baseURL, extensionServiceWorker }) => {
  await page.goto(`${baseURL}/slow-login.html`);

  const target = `${baseURL}/slow-login.html?delay=500`;
  const steps = [
    { id: 's1', action: 'navigate', name: 'Open fixture', url: target, pageAlias: 'page', framePath: [] },
    {
      // Retired action. Previously buildActionFromStep threw here during
      // mapping, killing the replay before step 1 ran.
      id: 's2', action: 'wait', name: 'Delay', timeout_ms: 1000,
      pageAlias: 'page', framePath: [],
    },
    {
      id: 's3', action: 'click', name: 'Sign In',
      locator: { candidates: [{ kind: 'test_attribute', value: '[data-test="login-sign-in"]' }] },
      pageAlias: 'page', framePath: [],
    },
  ];

  const res = await sendCommand<ReplayResponse>(page, { action: 'replay', steps, targetUrl: target });

  expect(res, 'no replay response').not.toBeNull();
  expect(
      res!.error ?? '',
      'the mapper still throws on a retired action, so the replay never started',
  ).not.toContain('Cannot replay step with action');
  expect(res!.passed, `replay failed: ${res!.error ?? '(no error)'}`).toBe(true);
});
