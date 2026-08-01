/**
 * Browser verification for replaying a STORED version-2 journey.
 *
 * Runs the REAL extension and drives it through the same postMessage bridge the
 * O2 web app uses, so this exercises the shipping path rather than a harness
 * approximation. The companion unit-level proofs live in
 * synthetics-v2-capture.spec.ts.
 *
 * What is being proved:
 *
 *   1. A journey that has been SAVED and RELOADED replays at all. A stored v2
 *      step identifies its element with a `locator` bundle and carries no bare
 *      `selector` — the saved schema has no such field. buildActionFromStep read
 *      `step.selector` alone, so every element action was built with an empty
 *      selector and Playwright failed parsing it before the step ran:
 *        Unexpected token "" while parsing css selector "".
 *      Every saved journey was therefore unreplayable from the editor.
 *
 *   2. A stored `fill` actually types. The v2 vocabulary (X-9.1) renamed the
 *      `type` alias to `fill`; the mapper only knew `type`, so a reloaded fill
 *      fell through to the `noop` default — skipped silently and reported as a
 *      pass. The fixture only renders its greeting when both inputs contain
 *      text, so a no-op fill fails the closing assertion.
 *
 *   3. A pinned locator is used exclusively (P2.4.3): pinning a selector that
 *      does not match fails the step rather than falling back to a candidate
 *      that does.
 *
 * See docs/synthetics/reliability/synthetics-recorded-test-reliability-spec.md
 * (P2.4.3, P2.S, X-9.1).
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

/**
 * The journey as it comes back out of storage: locator bundles, no bare
 * `selector`, v2 action names. Mirrors docs/.../steps01.json, which is a
 * navigate/fill/click journey in exactly this shape.
 */
function storedJourney(target: string) {
  return [
    { id: 's1', action: 'navigate', name: 'Open page', url: target },
    {
      id: 's2', action: 'fill', name: 'Fill [data-test="login-user-id-field"]',
      value: 'omkar@openobserve.ai',
      locator: { candidates: [{ kind: 'test_attribute', value: '[data-test="login-user-id-field"]' }] },
    },
    {
      id: 's3', action: 'fill', name: 'Fill [data-test="login-password-field"]',
      value: 'SecTest@500',
      locator: { candidates: [{ kind: 'test_attribute', value: '[data-test="login-password-field"]' }] },
    },
    {
      id: 's4', action: 'click', name: 'Click on [data-test="login-sign-in"]',
      locator: {
        candidates: [
          { kind: 'test_attribute', value: '[data-test="login-sign-in"]' },
          { kind: 'role', value: 'internal:role=button[name="Sign In"i]' },
        ],
      },
      settle: {
        responses: [{ url_pattern: '**/config', method: 'GET', required: false }],
        observed_duration_ms: 54,
      },
    },
    {
      id: 's5', action: 'assert', name: 'Assert signed in',
      assertion: { kind: 'element_visible' },
      locator: { candidates: [{ kind: 'test_attribute', value: '[data-test="header-my-account-profile-icon"]' }] },
    },
  ];
}

test('a saved journey replays green from its locator bundles, and its fills really type', async ({ page, baseURL, extensionServiceWorker }) => {
  await page.goto(`${baseURL}/v2-journey.html`);

  const target = `${baseURL}/v2-journey.html?delay=500`;
  const res = await sendCommand<ReplayResponse>(page, {
    action: 'replay', steps: storedJourney(target), targetUrl: target,
  });

  expect(res, 'no replay response').not.toBeNull();
  expect(
      res!.error ?? '',
      'the mapper still built an empty selector from a bundle-only step',
  ).not.toContain('while parsing css selector');
  // The fixture renders its greeting only when both inputs hold text, so the
  // closing assertion passing is also what distinguishes a real `fill` from the
  // silent no-op a reloaded journey used to get.
  expect(
      res!.passed,
      `replay failed — an empty selector, or a fill that never typed: ${res!.error ?? '(no error)'}`,
  ).toBe(true);
});

test('the player replays the author\'s first choice and does not fall back', async ({ page, baseURL, extensionServiceWorker }) => {
  await page.goto(`${baseURL}/v2-journey.html`);

  const target = `${baseURL}/v2-journey.html?delay=500`;
  const steps = storedJourney(target);
  // This used to set `user_override`, an exclusive pin. The author now says the
  // same thing by ordering: put a locator that matches nothing at position 0,
  // with a working candidate right behind it. The player resolves a single
  // selector and reports `primary locator only` (P2.S), so falling through to
  // the working one would be the bug — and would also hide from the preview
  // exactly what the probe is about to do differently.
  (steps[3] as any).locator.candidates.unshift({
    kind: 'css', value: '#no-such-button', origin: 'authored',
  });
  (steps[3] as any).locator.author_ordered = true;

  const res = await sendCommand<ReplayResponse>(page, { action: 'replay', steps, targetUrl: target });

  expect(res, 'no replay response').not.toBeNull();
  expect(res!.passed, 'position 0 was ignored and a later candidate was used instead').toBe(false);
});
