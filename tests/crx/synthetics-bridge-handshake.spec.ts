/**
 * Regression tests for extension detection — the handshake the OpenObserve web app
 * uses to decide whether the recorder is installed.
 *
 * Both tests pin down failures that shipped: an extension that was installed,
 * enabled and working still reported as missing in the web app's UI.
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
 * The bug this pins down: `oo-bridge-probe` used to produce no observable response
 * whatsoever. Detection therefore rested entirely on the unsolicited
 * `oo-bridge-ready` the content script posts once at document_idle — which a Vue
 * SPA misses, because it mounts its own message listener later. The web app then
 * had nothing to wait for and rendered "extension not detected", and clicking the
 * toolbar icon did not help: it re-fired the same one-shot announcement.
 *
 * Listening only AFTER navigation is the point of the test — it reproduces the
 * ordering the web app actually has, rather than the one the other bridge specs
 * work around with a sleep(500) and a 3x retry.
 */
test('a probe is answered even when the page starts listening after the content script loaded', async ({
  page, baseURL, extensionServiceWorker,
}) => {
  await page.goto(`${baseURL}/index.html`);

  const answered = await page.evaluate(async () => {
    return await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve(false);
      }, 20_000);

      function onMessage(event: MessageEvent) {
        if (event.source !== window) return;
        if (event.data?.ch !== 'oo-bridge-ready') return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(true);
      }

      window.addEventListener('message', onMessage);
      window.postMessage({ ch: 'oo-bridge-probe' }, '*');
    });
  });

  expect(answered,
      'probe went unanswered — the web app has no way to tell the extension is installed')
      .toBe(true);
});

/**
 * Every probe used to open another runtime Port. `openPort()` overwrote its own
 * `port` variable without disconnecting the previous one, so the worker accumulated
 * a live Port — and an onMessage listener registered for it — per probe. A page
 * that re-probes (to reconnect, or in reaction to `oo-bridge-ready`) piles these up
 * until the worker is starved and the whole browser drags.
 *
 * Measured directly in the worker rather than inferred from timing: ten probes used
 * to produce ten live ports.
 */
test('repeated probes reuse one port instead of opening a new one each time', async ({
  page, baseURL, extensionServiceWorker,
}) => {
  await extensionServiceWorker.evaluate(() => {
    (globalThis as any).__live = 0;
    chrome.runtime.onConnect.addListener(p => {
      if (p.name !== 'synthetics-recorder') return;
      (globalThis as any).__live++;
      p.onDisconnect.addListener(() => { (globalThis as any).__live--; });
    });
  });

  await page.goto(`${baseURL}/index.html`);

  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.postMessage({ ch: 'oo-bridge-probe' }, '*'));
    await page.waitForTimeout(150);
  }

  const live = await extensionServiceWorker.evaluate(() => (globalThis as any).__live);
  expect(live, 'each probe opened another live port — the worker leaks one per probe').toBe(1);
});

/**
 * Re-injection has to repair a tab, not merely be skipped.
 *
 * Turning on "Allow in incognito" — mandatory before the first recording, since
 * recording only runs in an incognito window — reloads the extension and leaves
 * every open tab with a content script whose DOM listeners still fire but whose
 * chrome.* APIs are dead. The popup repairs that by re-injecting. An "already
 * installed" flag would make that a no-op; the takeover handshake makes the new
 * instance replace the old one, without the two of them then racing for the
 * worker's single o2Port.
 */
test('re-injecting the content script leaves one working bridge, not two', async ({
  page, baseURL, extensionServiceWorker,
}) => {
  await extensionServiceWorker.evaluate(() => {
    (globalThis as any).__live = 0;
    chrome.runtime.onConnect.addListener(p => {
      if (p.name !== 'synthetics-recorder') return;
      (globalThis as any).__live++;
      p.onDisconnect.addListener(() => { (globalThis as any).__live--; });
    });
  });

  await page.goto(`${baseURL}/index.html`);
  await page.evaluate(() => window.postMessage({ ch: 'oo-bridge-probe' }, '*'));
  await page.waitForTimeout(500);

  await extensionServiceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content.js'] });
  });
  await page.waitForTimeout(500);

  // The re-injected instance must answer a probe on its own.
  const answered = await page.evaluate(async () => {
    return await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 15_000);
      window.addEventListener('message', function onMessage(event) {
        if (event.source !== window || event.data?.ch !== 'oo-bridge-ready') return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(true);
      });
      window.postMessage({ ch: 'oo-bridge-probe' }, '*');
    });
  });
  expect(answered, 're-injected content script never answered a probe').toBe(true);

  const live = await extensionServiceWorker.evaluate(() => (globalThis as any).__live);
  expect(live, 're-injection left two bridges competing for the worker port').toBe(1);
});

/**
 * A content script declared in `content_scripts` is loaded as a classic script and
 * cannot be an ES module. Sharing any runtime value (not just a type) between the
 * content script and another entry makes Rollup hoist it into a shared chunk and
 * emit `import ... from "./messaging.js"` at the top of content.js, which Chrome
 * silently refuses to load — the bridge never installs, and every symptom looks
 * like the detection bug above. vite.content.config.ts exists to prevent this;
 * this test is what stops it regressing the next time a constant is shared.
 */
test('the content script is emitted as a classic script, not an ES module', async () => {
  const contentJs = path.join(EXTENSION_PATH, 'content.js');
  expect(fs.existsSync(contentJs), `${contentJs} is missing — run npm run build`).toBe(true);

  const source = fs.readFileSync(contentJs, 'utf8');
  const moduleSyntax = source.match(/^(import|export)[\s{]/m);
  expect(moduleSyntax?.[0],
      'content.js contains top-level ES module syntax; Chrome will not load it as a content script')
      .toBeUndefined();
});
