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

import { dumpLogHeaders, expect, test } from './crxRecorderTest';
// The test below drives the crx API directly through runCrxTest, which needs the
// harness extension's `_runTest` global. recorder-crx (what `test` above loads)
// does not have it, so that test uses the base fixtures instead.
import { test as crxTest } from './crxTest';
import { editCode } from './utils';

test('should play in incognito', async ({ configureRecorder, attachRecorder, page, baseURL, extensionServiceWorker }) => {
  await configureRecorder({ playInIncognito: true });

  const recorderPage = await attachRecorder(page);
  await recorderPage.getByTitle('Record').click();

  editCode(recorderPage, `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('${baseURL}/input/textarea.html');
  await page.locator('textarea').fill('some test');
});`);

  const incognitoPagePromise = extensionServiceWorker.evaluate(url => new Promise<void>(resolve => {
    chrome.tabs.onUpdated.addListener((_, changes, tab) => {
      if (!tab.incognito || changes.url !== url)
        return;
      resolve();
    });
  }), `${baseURL}/input/textarea.html`);

  await recorderPage.getByTitle('Resume (F8)').click();
  await incognitoPagePromise;

  await expect.poll(dumpLogHeaders(recorderPage)).toEqual([
    `► Navigate to "/input/textarea.html"( ${baseURL}/input/textarea.html ) ✅ — XXms`,
    `► Fill \"some test\"( page.locator('textarea') ) ✅ — XXms`,
  ]);
});

test('should close and reopen incognito window on replay', async ({ configureRecorder, attachRecorder, page, baseURL, extensionServiceWorker }) => {
  await configureRecorder({ playInIncognito: true });

  const recorderPage = await attachRecorder(page);
  await recorderPage.getByTitle('Record').click();

  editCode(recorderPage, `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('${baseURL}/input/textarea.html');
  await page.locator('textarea').fill('some test');
});`);

  await recorderPage.getByTitle('Resume (F8)').click();
  await expect(recorderPage.getByTitle('Resume (F8)')).not.toBeDisabled();

  const getIncognitoTabIds = async () => await extensionServiceWorker.evaluate(() => chrome.tabs.query({}).then(ts => ts.filter(t => t.incognito).map(t => t.id!)));
  const tabIds = await getIncognitoTabIds();
  expect(tabIds).toHaveLength(1);

  await recorderPage.getByTitle('Resume (F8)').click();
  await expect(recorderPage.getByTitle('Resume (F8)')).not.toBeDisabled();

  const newTabIds = await getIncognitoTabIds();
  expect(newTabIds).toHaveLength(1);
  expect(newTabIds[0]).not.toEqual(tabIds[0]);
});

crxTest('should replay against the started tab, not whatever attached first', async ({ runCrxTest }) => {
  await runCrxTest(async ({ crx, server, expect }) => {
    const ownWindow = await chrome.windows.create({
      incognito: true, url: `${server.PREFIX}/v2-login.html` });
    const ownTabId = ownWindow.tabs![0].id!;
    const incognitoApp = await crx.start({ incognito: true, tabId: ownTabId });

    // A second incognito tab attached AFTER start. It must not become the
    // replay target just because it is in the same context.
    const otherWindow = await chrome.windows.create({
      incognito: true, url: `${server.PREFIX}/index.html` });
    await incognitoApp.attach(otherWindow.tabs![0].id!);

    await incognitoApp.recorder.runActions([
      {
        frame: { pageAlias: 'page', framePath: [] },
        action: { name: 'click', selector: 'internal:testid=[data-test="login-user-id-field"s]', signals: [] },
      },
    ]);

    // The click can only have succeeded against the started tab, because the
    // other tab has no such element.
    const startedTab = await chrome.tabs.get(ownTabId);
    expect(startedTab.url).toContain('v2-login.html');

    await incognitoApp.close();
    await chrome.windows.remove(otherWindow.id!).catch(() => {});
  });
});
