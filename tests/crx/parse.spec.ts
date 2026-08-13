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

import { test as base, expect } from './crxTest';
import type { Action, ActionInContext } from '../../../playwright/packages/recorder/src/actions';
import type { TestOptions } from '../../src/server/recorder/parser';

const test = base.extend<{ testParse: (code: string, skipAssertCode?: boolean) => Promise<{ actions: (Action & { pageAlias: string })[], options: TestOptions }> }>({
  testParse: async ({ runCrxTest }, use) => {
    await use(async (code, skipAssertCode) => {
      const { actions: actionsInContext, options, code: resultCode } = await runCrxTest(async ({ crxApp }, code) => {
        const crxAppImpl = await (crxApp as any)._toImpl();
        return crxAppImpl.parseForTest(code) as { code: string, actions: ActionInContext[], options: TestOptions };
      }, code);
      if (!skipAssertCode)
        expect.soft(code).toEqual(resultCode);
      // 1.62 removed `frame` from ActionInContext — an action now carries only the page
      // key. For parsed code that key IS the alias the author wrote (`page`, `page1`, …),
      // so the values asserted below are unchanged; only where they are read moved.
      const actions = actionsInContext.map(a => ({ ...a.action, pageAlias: a.pageGuid }));
      return { actions, options };
    });
  },
});

test('should parse code', async ({ testParse }) => {
  const code = `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://demo.playwright.dev/todomvc/#/');
  await page.getByPlaceholder('What needs to be done?').click();
  await page.getByPlaceholder('What needs to be done?').fill('Hello, World!');
  await page.getByPlaceholder('What needs to be done?').press('Enter');
  await expect(page.getByTestId('todo-title')).toContainText('Hello, World!');
  await expect(page.locator('body')).toMatchAriaSnapshot(\`
    - strong: 1
    - text: item left
    - list:
      - listitem:
        - link "All"
      - listitem:
        - link "Active"
      - listitem:
        - link "Completed"
    \`);
  await expect(page.getByLabel('Toggle Todo')).not.toBeChecked();
  await page.getByLabel('Toggle Todo').check();
  await expect(page.getByLabel('Toggle Todo')).toBeChecked();
  await page.getByRole('button', { name: 'Clear completed' }).click();
});`;
  const { actions } = await testParse(code);
  expect(actions).toMatchObject([
    { name: 'openPage' },
    { name: 'navigate' },
    { name: 'click', selector: 'internal:attr=[placeholder="What needs to be done?"i]' },
    { name: 'fill', selector: 'internal:attr=[placeholder="What needs to be done?"i]' },
    { name: 'press', selector: 'internal:attr=[placeholder="What needs to be done?"i]' },
    { name: 'assertText', selector: 'internal:testid=[data-testid="todo-title"s]' },
    { name: 'assertSnapshot', selector: 'body' },
    { name: 'assertChecked', selector: 'internal:label="Toggle Todo"i', checked: false },
    { name: 'check', selector: 'internal:label="Toggle Todo"i' },
    { name: 'assertChecked', selector: 'internal:label="Toggle Todo"i', checked: true },
    { name: 'click', selector: 'internal:role=button[name="Clear completed"i]' },
  ]);
});

test('should parse selectOption', async ({ testParse }) => {
  const code = `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.locator('select1').selectOption('a');
  await page.locator('select2').selectOption(['a', 'b']);
});`;
  const { actions } = await testParse(code);
  expect(actions).toMatchObject([
    { name: 'openPage' },
    { name: 'select', selector: 'select1', options: ['a'] },
    { name: 'select', selector: 'select2', options: ['a', 'b'] },
  ]);
});

test('should not parse incorrect code', async ({ testParse }) => {
  const code = `import { test, expect } from '@playwright/test';

  await page.goto('https://demo.playwright.dev/todomvc/#/');`;
  await expect(() => testParse(code)).rejects.toThrow();
});

test('should not parse action without await', async ({ testParse }) => {
  const code = `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  page.goto('https://demo.playwright.dev/todomvc/#/');
});`;
  await expect(() => testParse(code)).rejects.toThrow();
});

test('should not parse wrong action', async ({ testParse }) => {
  const code = `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.navigate('https://demo.playwright.dev/todomvc/#/');
});`;
  await expect(() => testParse(code)).rejects.toThrow();
});

test('should not parse non-locator assertion', async ({ testParse }) => {
  const code = `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await expect('hello').toContainText('hello');
});`;
  await expect(() => testParse(code)).rejects.toThrow();
});

test('should parse options', async ({ testParse }) => {
  const code = `import { test, expect, devices } from '@playwright/test';

test.use({
  ...devices['iPhone 11'],
  colorScheme: 'dark',
  geolocation: {
    latitude: 37.819722,
    longitude: -122.478611
  },
  locale: 'pt_PT',
  permissions: ['geolocation'],
  serviceWorkers: 'block',
  storageState: 'state.json',
  timezoneId: 'Europe/Rome',
  viewport: {
    height: 728,
    width: 1024
  }
});

test('test', async ({ page }) => {
});`;
  const { options } = await testParse(code);
  expect(options).toMatchObject({
    deviceName: 'iPhone 11',
    contextOptions: {
      colorScheme: 'dark',
      geolocation: {
        latitude: 37.819722,
        longitude: -122.478611
      },
      locale: 'pt_PT',
      permissions: ['geolocation'],
      serviceWorkers: 'block',
      timezoneId: 'Europe/Rome',
      viewport: {
        height: 728,
        width: 1024
      },
      storageState: 'state.json',
    },
  });
});

test('should not parse wrong options', async ({ testParse }) => {
  const testParseWithOptions = async (options: string) => {
    return await testParse(`import { test, expect } from '@playwright/test';

test.use(${options});

test('test', async ({ page }) => {});`, true);
  };

  await expect.soft(testParseWithOptions('{ ...devices }')).rejects.toThrow('Invalid device property (3:11)');
  await expect.soft(testParseWithOptions('{ ...devices[1] }')).rejects.toThrow('Invalid device property (3:11)');
  await expect.soft(testParseWithOptions(`{ colorScheme: '42' }`)).rejects.toThrow('Invalid enum value, expected one of dark, light, no-preference (3:11)');
  await expect.soft(testParseWithOptions(`{ colorScheme: 42 }`)).rejects.toThrow('Invalid enum value, expected one of dark, light, no-preference (3:11)');
  await expect.soft(testParseWithOptions(`{ timezoneId: 42 }`)).rejects.toThrow('Invalid string (3:11)');
  await expect.soft(testParseWithOptions(`{ locale: 42 }`)).rejects.toThrow('Invalid string (3:11)');
  await expect.soft(testParseWithOptions(`{ serviceWorkers: '42' }`)).rejects.toThrow('Invalid enum value, expected one of allow, block (3:11)');
  await expect.soft(testParseWithOptions(`{ serviceWorkers: 42 }`)).rejects.toThrow('Invalid enum value, expected one of allow, block (3:11)');
  await expect.soft(testParseWithOptions(`{ geolocation: '1,2' }`)).rejects.toThrow('Invalid object with required number properties, expected latitude, longitude (3:11)');
  await expect.soft(testParseWithOptions(`{ viewport: '1,2' }`)).rejects.toThrow('Invalid object with required number properties, expected width, height (3:11)');
  await expect.soft(testParseWithOptions(`{ viewport: { width: 42 } }`)).rejects.toThrow('Invalid object with required number properties, expected width, height (3:11)');
  await expect.soft(testParseWithOptions(`{ geolocation: { latitude: 42 } }`)).rejects.toThrow('Invalid object with required number properties, expected latitude, longitude (3:11)');
});

test('should parse mouse options', async ({ testParse }) => {
  const testParseWithMouseOptions = async (actionName: 'click' | 'dblclick', options: string = '') => {
    const { actions } = await testParse(`import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.getByRole('button').${actionName}(${options});
});`, true);
      // first action is openPage, so we need to get the second action
    const { button, modifiers, clickCount, position } = (actions[1] ?? {}) as any;
    return { button, modifiers, clickCount, position };
  };
  const clickDefaults = { button: 'left', modifiers: 0, clickCount: 1, position: undefined };
  const dblclickDefaults = { ...clickDefaults, clickCount: 2 };

  await expect.soft(testParseWithMouseOptions('click')).resolves.toEqual(clickDefaults);
  await expect.soft(testParseWithMouseOptions('click', `{ button: 'left' }`)).resolves.toEqual(clickDefaults);
  await expect.soft(testParseWithMouseOptions('click', `{ button: 'middle' }`)).resolves.toEqual({ ...clickDefaults, button: 'middle' });
  await expect.soft(testParseWithMouseOptions('click', `{ modifiers: [] }`)).resolves.toEqual(clickDefaults);
  await expect.soft(testParseWithMouseOptions('click', `{ modifiers: ['Alt', 'ControlOrMeta'] }`)).resolves.toEqual({ ...clickDefaults, modifiers: 3 });
  await expect.soft(testParseWithMouseOptions('click', `{ clickCount: 1 }`)).resolves.toEqual(clickDefaults);
  await expect.soft(testParseWithMouseOptions('click', `{ clickCount: 3 }`)).resolves.toEqual({ ...clickDefaults, clickCount: 3 });
  await expect.soft(testParseWithMouseOptions('click', `{ position: { x: 5, y: 20 } }`)).resolves.toEqual({ ...clickDefaults, position: { x: 5, y: 20 } });
  await expect.soft(testParseWithMouseOptions('dblclick')).resolves.toEqual({ ...dblclickDefaults });
  await expect.soft(testParseWithMouseOptions('dblclick', `{ button: 'left' }`)).resolves.toEqual({ ...dblclickDefaults });
  await expect.soft(testParseWithMouseOptions('dblclick', `{ button: 'middle' }`)).resolves.toEqual({ ...dblclickDefaults, button: 'middle' });
});

// A page the author named themselves does not survive a round trip any more: 1.62 has the
// generator assign page names itself, in first-seen order, from the page key alone
// (playwright#41594 moved codegen and rebuilt aliasing around pageGuid). So `newPage` is
// parsed faithfully — the assertions below still read the author's name — and regenerated
// as `page1`. Preserving it would mean patching an alias back into a generator that
// deliberately stopped carrying one. The parsed shape is what replay uses, and that is
// unchanged; only the rendered variable name is canonicalised.
test('should parse new page', async ({ testParse }) => {
  const { actions } = await testParse(`import { test, expect } from '@playwright/test';

test('test', async ({ page, context }) => {
  const page1 = await context.newPage();
  await page1.goto('https://example.com');
  await expect(page1.getByRole('heading')).toContainText('Example Domain');
  await page1.close();
});`);

  expect.soft(actions).toMatchObject([
    { pageAlias: 'page', name: 'openPage' },
    { pageAlias: 'page1', name: 'openPage' },
    { pageAlias: 'page1', name: 'navigate', url: 'https://example.com' },
    { pageAlias: 'page1', name: 'assertText',  selector: 'internal:role=heading', text: 'Example Domain' },
    { pageAlias: 'page1', name: 'closePage' },
  ]);
});

test('should parse routefromHAR', async ({ testParse }) => {
  const { options } = await testParse(`import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.routeFromHAR('har.har');
});`);

  expect(options.contextOptions?.recordHar).toEqual({
    path: 'har.har',
    urlGlob: undefined,
  });
});

test('should parse routefromHAR with glob', async ({ testParse }) => {
  const { options } = await testParse(`import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.routeFromHAR('har.har', { url: '**/*.js' });
});`, true);

  expect(options.contextOptions?.recordHar).toEqual({
    path: 'har.har',
    urlGlob: '**/*.js',
  });
});
