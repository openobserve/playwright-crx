/**
 * P1 — the capability handshake between the OpenObserve web app and the recorder
 * extension.
 *
 * Why this exists: the extension is installed by the user from the Chrome Web Store
 * and updates asynchronously, so the web app ALWAYS runs against a mix of versions.
 * Today nothing in the command contract carries a version or a capability list, and
 * `runO2Command` answers an action it does not recognise by returning false — which
 * sends no response at all. The web app's `sendCommand` then resolves null at its
 * 4 s timeout and reports "Failed to start recording.", naming neither the cause nor
 * the fix.
 *
 * Every command added after this point (startRecordingFrom, …) inherits that failure
 * mode unless the handshake exists first. These tests pin it down.
 *
 * See docs/synthetics/record-from-step-plan.md §2.
 */
import fs from 'fs';
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

/**
 * An action no build will ever implement.
 *
 * Deliberately fictional rather than "the next real command": these tests originally
 * used `startRecordingFrom`, and the moment that shipped they started asserting that a
 * SUPPORTED command was refused. A name that can never be implemented keeps the
 * refusal path under test for good.
 */
const UNIMPLEMENTED_ACTION = 'thisCommandWillNeverExist';

/** The version the built extension actually ships — the value the handshake must report. */
function manifestVersion(): string {
  const manifest = JSON.parse(
      fs.readFileSync(path.join(EXTENSION_PATH, 'manifest.json'), 'utf8'));
  return manifest.version;
}

/**
 * Drive one command through the real bridge, exactly as the web app does:
 * page → content script → service worker → back, correlated by nonce.
 *
 * Resolves `{ __timedOut: true }` when nothing answers, so a test can tell
 * "answered with a refusal" (fine) apart from "answered with silence" (the bug).
 * The budget is deliberately shorter than the web app's own 4 s `COMMAND_TIMEOUT_MS`
 * — a handshake that needs longer than that is already broken for real callers.
 */
async function sendBridgeCommand(
  page: any, command: Record<string, unknown>, timeoutMs = 3000,
): Promise<any> {
  return await page.evaluate(async ({ command, timeoutMs }: any) => {
    // Wake the content script's port the way the web app's detectExtension does.
    window.postMessage({ ch: 'oo-bridge-probe' }, '*');
    await new Promise(r => setTimeout(r, 500));

    return await new Promise(resolve => {
      const nonce = `t_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve({ __timedOut: true });
      }, timeoutMs);

      function onMessage(event: MessageEvent) {
        if (event.source !== window) return;
        const data = event.data;
        if (data?.ch !== 'oo-bridge' || data?.dir !== 'to-page') return;
        if (data.nonce !== nonce) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(data.msg);
      }

      window.addEventListener('message', onMessage);
      window.postMessage(
          { ch: 'oo-bridge', dir: 'to-ext', nonce,
            msg: { type: 'synthetics-command', command } },
          '*');
    });
  }, { command, timeoutMs });
}

/**
 * Fails if `extVersion` is not populated from the manifest.
 *
 * The web app cannot say "update the extension" without knowing which version is
 * installed, and it must never infer capability FROM the version — the list below
 * is the contract; this is for the message and for support.
 */
test('getStatus reports the installed extension version', async ({ page, baseURL, extensionServiceWorker }) => {
  await page.goto(`${baseURL}/index.html`);

  const status = await sendBridgeCommand(page, { action: 'getStatus' });

  expect(status?.__timedOut, 'getStatus went unanswered').toBeUndefined();
  expect(status.extVersion,
      'getStatus does not report the extension version, so the web app cannot tell the user which build they are on')
      .toBe(manifestVersion());
});

/**
 * Fails if CAPABILITIES is absent or does not include what this build can do.
 *
 * The list — not the version — is what every O2 affordance gates on, so that a
 * capability can be added or withdrawn without the web app parsing version numbers.
 */
test('getStatus reports the capabilities this build supports', async ({ page, baseURL, extensionServiceWorker }) => {
  await page.goto(`${baseURL}/index.html`);

  const status = await sendBridgeCommand(page, { action: 'getStatus' });

  expect(status?.__timedOut, 'getStatus went unanswered').toBeUndefined();
  expect(status.capabilities,
      'getStatus reports no capability list, so the web app has nothing to gate new affordances on')
      .toEqual(expect.arrayContaining(['record', 'replay']));
});

/**
 * The regression this whole phase exists for.
 *
 * Fails while `runO2Command` returns false for an unrecognised action: nothing is
 * ever posted back, the caller waits out its full timeout, and the user is told the
 * recorder failed rather than that it is out of date. Asserting on "answered at
 * all" rather than on the payload is deliberate — silence is the defect.
 */
test('an unsupported command is answered rather than met with silence', async ({ page, baseURL, extensionServiceWorker }) => {
  await page.goto(`${baseURL}/index.html`);

  const response = await sendBridgeCommand(page, { action: UNIMPLEMENTED_ACTION });

  expect(response?.__timedOut,
      'an unknown command produced no response at all — every caller must wait out its own timeout and can only report a generic failure')
      .toBeUndefined();
});

/**
 * Fails if the refusal does not name its cause.
 *
 * "Answered" is not enough on its own: the web app has to distinguish "your
 * extension is too old for this" from "recording genuinely failed", because only
 * the first has "update the extension" as its fix.
 */
test('an unsupported command names the reason it was refused', async ({ page, baseURL, extensionServiceWorker }) => {
  await page.goto(`${baseURL}/index.html`);

  const response = await sendBridgeCommand(page, { action: UNIMPLEMENTED_ACTION });

  expect(response?.__timedOut, 'the command went unanswered').toBeUndefined();
  expect(response.success, 'an unsupported command must not report success').toBe(false);
  expect(response.error,
      'the refusal does not identify itself as an unsupported command, so the web app cannot offer "update the extension"')
      .toBe('unsupported-command');
});

/**
 * Fails if the refusal does not say WHICH command was refused.
 *
 * A single bridge carries every command; without the action name a refusal cannot
 * be attributed, and a stale extension looks identical whichever new feature the
 * author touched.
 */
test('an unsupported command reports which action was refused', async ({ page, baseURL, extensionServiceWorker }) => {
  await page.goto(`${baseURL}/index.html`);

  const response = await sendBridgeCommand(page, { action: UNIMPLEMENTED_ACTION });

  expect(response?.__timedOut, 'the command went unanswered').toBeUndefined();
  expect(response.action,
      'the refusal does not name the action, so a stale extension cannot be attributed to the feature the author was using')
      .toBe(UNIMPLEMENTED_ACTION);
});

/**
 * The restore-then-record capability, advertised only because the command exists.
 *
 * This is the pair to the `startRecordingFrom` command test: O2 gates its Record
 * button on this string, so a build that implements the command without advertising
 * it leaves the feature switched off for everyone.
 */
test('getStatus advertises recordFrom now that the command is implemented', async ({ page, baseURL, extensionServiceWorker }) => {
  await page.goto(`${baseURL}/index.html`);

  const status = await sendBridgeCommand(page, { action: 'getStatus' });

  expect(status?.__timedOut, 'getStatus went unanswered').toBeUndefined();
  // Asserted first: `.toContain` cannot express anything useful about an absent list,
  // it errors on undefined instead of failing.
  expect(Array.isArray(status.capabilities),
      'getStatus reports no capability list at all').toBe(true);
  expect(status.capabilities,
      'the extension implements startRecordingFrom but does not advertise it, so O2 keeps the affordance disabled')
      .toContain('recordFrom');
});

/**
 * Guards the handshake against a lie by omission.
 *
 * A list that advertises something the build cannot do is worse than no list: O2 would
 * enable the affordance and the command would be refused. Every string here must have a
 * command behind it, which is what this checks — an unrecognised capability fails.
 */
test('getStatus advertises only capabilities that exist', async ({ page, baseURL, extensionServiceWorker }) => {
  await page.goto(`${baseURL}/index.html`);

  const status = await sendBridgeCommand(page, { action: 'getStatus' });

  expect(status?.__timedOut, 'getStatus went unanswered').toBeUndefined();
  const implemented = ['record', 'replay', 'recordFrom'];
  const unknown = (status.capabilities ?? []).filter((c: string) => !implemented.includes(c));
  expect(unknown,
      'a capability is advertised that this test does not know a command for — either it was added ahead of its implementation, or this list needs updating in the same change')
      .toEqual([]);
});
