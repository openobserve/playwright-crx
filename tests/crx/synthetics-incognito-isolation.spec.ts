/**
 * Copyright (c) Rui Figueira.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * A user who already has an incognito window open on a website must not have
 * that window attached, recorded, or replayed into. See
 * docs/synthetics/issues/006-recorder-attaches-to-user-incognito-tabs.md
 * in the OpenObserve repo for the full analysis.
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
test.describe.configure({ mode: 'serial' });

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

// Opens an incognito window on a real site, the way a user would, and waits for
// it to finish loading — an empty new-tab page does not trigger the bug.
async function openUserIncognitoWindow(extensionServiceWorker: any, url: string): Promise<number> {
  return extensionServiceWorker.evaluate(async (u: string) => {
    const win = await chrome.windows.create({ incognito: true, url: u });
    const tabId = win.tabs![0].id!;
    await new Promise<void>(resolve => {
      const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
        if (id !== tabId || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    return tabId;
  }, url);
}

/**
 * Incognito tabs this EXTENSION has a debugger attached to.
 *
 * `chrome.debugger.getTargets()` cannot answer this: Playwright drives the
 * browser over its own CDP connection, so it reports `attached: true` for every
 * tab in the run — including tabs the extension has never touched. Chrome does
 * however refuse a second `chrome.debugger.attach` from the same extension with
 * 'Another debugger is already attached', and that refusal is specific to *our*
 * attachment. So probe each incognito tab: a refusal means we own it, a
 * successful attach (immediately undone) means we do not.
 */
async function attachedIncognitoTabIds(extensionServiceWorker: any): Promise<number[]> {
  return extensionServiceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const owned: number[] = [];
    for (const tab of tabs) {
      if (!tab.incognito || tab.id === undefined)
        continue;
      try {
        await chrome.debugger.attach({ tabId: tab.id }, '1.3');
        await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
      } catch (e: any) {
        // Any other refusal (chrome:// pages, devtools targets) is not ours.
        if (String(e?.message ?? e).includes('Another debugger is already attached'))
          owned.push(tab.id);
      }
    }
    return owned;
  });
}

test('does not attach the user\'s own incognito tab when recording', async ({ page, context, baseURL, extensionServiceWorker }) => {
  await page.goto(`${baseURL}/index.html`);

  const userTabId = await openUserIncognitoWindow(extensionServiceWorker, `${baseURL}/index.html`);

  const res = await sendCommand<{ success: boolean; error?: string }>(page, {
    action: 'startRecording', mode: 'recording', testIdAttr: 'data-test',
    targetUrl: `${baseURL}/v2-login.html`,
  });
  expect(res?.success, `startRecording failed: ${res?.error ?? '(no response — is dist/ built?)'}`).toBe(true);

  const status = await sendCommand<{ tabId: number }>(page, { action: 'getStatus' });
  const attached = await attachedIncognitoTabIds(extensionServiceWorker);

  expect(attached).toContain(status!.tabId);
  expect(attached).not.toContain(userTabId);
  expect(attached).toHaveLength(1);

  await sendCommand(page, { action: 'stopRecording' });
});

test('replay passes with a pre-existing incognito window open', async ({ page, baseURL, extensionServiceWorker }) => {
  await page.goto(`${baseURL}/index.html`);

  const userTabId = await openUserIncognitoWindow(extensionServiceWorker, `${baseURL}/index.html`);

  const steps = [
    { id: 's1', action: 'navigate', name: 'Open page', url: `${baseURL}/v2-login.html`, pageAlias: 'page', framePath: [] },
    { id: 's2', action: 'click', name: 'Click user id field', pageAlias: 'page', framePath: [],
      locator: { candidates: [{ kind: 'test_attribute', value: 'internal:testid=[data-test="login-user-id-field"s]', origin: 'recorded' }] } },
  ];

  const res = await sendCommand<{ passed: boolean; error?: string }>(page, {
    action: 'replay', steps, targetUrl: `${baseURL}/v2-login.html`, testIdAttr: 'data-test',
  }, 120_000);

  expect(res?.passed, `replay failed: ${res?.error}`).toBe(true);

  // The user's own tab must be exactly where they left it.
  const userTabUrl = await extensionServiceWorker.evaluate(
      async (id: number) => (await chrome.tabs.get(id)).url, userTabId);
  expect(userTabUrl).toContain('/index.html');
});
