/**
 * The recording overlay must not become part of the journey it is recording.
 *
 * The overlay lives in the recorded page's DOM, so a click on its Stop button is a
 * click in the page like any other, and the recorder captured it — journeys ended
 * with a spurious step targeting the recorder's own button.
 *
 * Playwright has exactly one exclusion for this: `Recorder._ignoreOverlayEvent`
 * walks `event.composedPath()` and drops the event if any node is named
 * `x-pw-glass`. That check guards all of its event handlers, so rendering the
 * overlay as an `<x-pw-glass>` element covers click, pointer, mouse, dblclick,
 * contextmenu and dragstart at once.
 *
 * The cost of that is a dependency on an internal tag name, and the failure mode is
 * silent: rename it upstream and spurious steps quietly come back. These two tests
 * exist to make that failure loud instead.
 */
import fs from 'fs';
import path from 'path';
import { test, expect } from './crxTest';

const EXTENSION_PATH = path.join(
    __dirname, '..', '..', 'examples', 'synthetics-recorder', 'dist');

const RECORDER_SOURCE = path.join(
    __dirname, '..', '..', 'playwright', 'packages', 'injected', 'src', 'recorder', 'recorder.ts');

test.use({
  extensionPath: EXTENSION_PATH,
  ...(process.env.CRX_CHANNEL ? { channel: process.env.CRX_CHANNEL } : {}),
  enabledInIncognito: true,
});

test.slow();

/**
 * Half of the contract, checked at its source. If upstream renames the tag or
 * reworks the exclusion, the overlay silently starts polluting recordings again —
 * so assert on the vendored recorder rather than trusting it to stay put.
 */
test('the recorder still excludes overlay events by the x-pw-glass tag name', async () => {
  const source = fs.readFileSync(RECORDER_SOURCE, 'utf8');

  const fn = source.match(/_ignoreOverlayEvent\s*\(event: Event\)\s*\{[\s\S]*?\n  \}/);
  expect(fn, '_ignoreOverlayEvent no longer exists in the vendored recorder — the overlay '
      + 'exclusion this extension relies on has been reworked upstream').toBeTruthy();

  expect(fn![0], '_ignoreOverlayEvent no longer keys on "x-pw-glass"; the synthetics overlay '
      + 'renders itself with that tag to opt out of recording (see showOverlay in content.ts)')
      .toContain('x-pw-glass');
});

/**
 * The other half: that the overlay actually satisfies the predicate in a real
 * recording session. Asserted against a rebuilt composedPath rather than a real
 * click, because the recorder only acts on trusted events and a scripted click is
 * not trusted — so a click-driven test would pass whether or not the fix works.
 */
test('a click on the overlay Stop button is excluded from the recording', async ({
  page, baseURL, extensionServiceWorker,
}) => {
  await page.goto(`${baseURL}/index.html`);

  await page.evaluate(async ({ target }) => {
    window.postMessage({ ch: 'oo-bridge-probe' }, '*');
    await new Promise(r => setTimeout(r, 800));
    window.postMessage({
      ch: 'oo-bridge', dir: 'to-ext', nonce: 'overlay-spec',
      msg: { type: 'synthetics-command', command: { action: 'startRecording', mode: 'recording', targetUrl: target } },
    }, '*');
  }, { target: `${baseURL}/index.html` });

  // Poll rather than sleep: the overlay lands once the recording tab settles.
  let result: any = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.waitForTimeout(1_000);
    result = await extensionServiceWorker.evaluate(async () => {
      const tab = (await chrome.tabs.query({})).filter(t => t.incognito)[0];
      if (!tab?.id) return null;
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const stop = document.querySelector('#__synth_stop_btn');
          if (!stop) return null;
          // Rebuild what composedPath() would yield for a click on Stop.
          const nodes: string[] = [];
          let n: any = stop;
          while (n) {
            nodes.push(String(n.nodeName).toLowerCase());
            n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
          }
          return { nodes, ignored: nodes.some(name => name === 'x-pw-glass') };
        },
      });
      return r?.result ?? null;
    }).catch(() => null);
    if (result) break;
  }

  expect(result, 'overlay Stop button never appeared in the recording tab').toBeTruthy();
  expect(result.ignored,
      `a click on Stop would be recorded as a journey step — composedPath was ${JSON.stringify(result.nodes)}`)
      .toBe(true);

  await page.evaluate(() => {
    window.postMessage({
      ch: 'oo-bridge', dir: 'to-ext', nonce: 'overlay-spec-stop',
      msg: { type: 'synthetics-command', command: { action: 'stopRecording' } },
    }, '*');
  });
});
