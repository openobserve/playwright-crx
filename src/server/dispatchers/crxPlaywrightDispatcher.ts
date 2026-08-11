/**
 * Copyright (c) Rui Figueira.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License");
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
import type * as channels from '@protocol/channels';
import { AndroidDispatcher } from 'playwright-core/lib/server/dispatchers/androidDispatcher';
import { BrowserTypeDispatcher } from 'playwright-core/lib/server/dispatchers/browserTypeDispatcher';
import type { RootDispatcher } from 'playwright-core/lib/server/dispatchers/dispatcher';
import { Dispatcher } from 'playwright-core/lib/server/dispatchers/dispatcher';
import { ElectronDispatcher } from 'playwright-core/lib/server/dispatchers/electronDispatcher';
import { LocalUtilsDispatcher } from 'playwright-core/lib/server/dispatchers/localUtilsDispatcher';
import { APIRequestContextDispatcher } from 'playwright-core/lib/server/dispatchers/networkDispatchers';
import { GlobalAPIRequestContext } from 'playwright-core/lib/server/fetch';
import type { Playwright } from 'playwright-core/lib/server/playwright';
import { CrxDispatcher } from './crxDispatcher';
import type { CrxPlaywright } from '../crxPlaywright';
import { CrxPlaywrightInitializer } from 'src/protocol/channels';

// based on PlaywrightDispatcher
export class CrxPlaywrightDispatcher extends Dispatcher<Playwright, channels.PlaywrightChannel, RootDispatcher> implements channels.PlaywrightChannel {
  _type_Playwright;

  constructor(scope: RootDispatcher, playwright: CrxPlaywright) {
    // 1.54: browser-type dispatchers take a `denyLaunch` flag. crx never launches a
    // browser itself (it attaches over chrome.debugger), but denyLaunch stays false to
    // preserve the previous behaviour of these channels rather than silently tightening
    // it. 1.57 removed the bidi browser types from PlaywrightInitializer entirely.
    const denyLaunch = false;
    super(scope, playwright, 'Playwright', {
      chromium: new BrowserTypeDispatcher(scope, playwright.chromium, denyLaunch),
      firefox: new BrowserTypeDispatcher(scope, playwright.firefox, denyLaunch),
      webkit: new BrowserTypeDispatcher(scope, playwright.webkit, denyLaunch),
      // 1.55 dropped denyLaunch from AndroidDispatcher and 1.60 reinstated it, this time
      // actually reading it. Passing the same flag as every other browser type.
      android: new AndroidDispatcher(scope, playwright.android, denyLaunch),
      electron: new ElectronDispatcher(scope, playwright.electron, denyLaunch),
      utils: new LocalUtilsDispatcher(scope, playwright),
      _crx: new CrxDispatcher(scope, playwright._crx),
    } as CrxPlaywrightInitializer);
    this._type_Playwright = true;
  }

  async newRequest(params: channels.PlaywrightNewRequestParams): Promise<channels.PlaywrightNewRequestResult> {
    const request = new GlobalAPIRequestContext(this._object, params);
    return { request: APIRequestContextDispatcher.from(this.parentScope(), request) };
  }

  async cleanup() {
    // do nothing
  }
}
