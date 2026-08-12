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

// 1.61 deleted client/api.ts — it was a barrel that existed only for doc tooling
// (playwright#40777), so these now come from the modules that define them.
import { Browser } from 'playwright-core/lib/client/browser';
import { BrowserContext } from 'playwright-core/lib/client/browserContext';
import { BrowserType } from 'playwright-core/lib/client/browserType';
import { Clock } from 'playwright-core/lib/client/clock';
import { ConsoleMessage } from 'playwright-core/lib/client/consoleMessage';
import { Coverage } from 'playwright-core/lib/client/coverage';
import { Dialog } from 'playwright-core/lib/client/dialog';
import { Download } from 'playwright-core/lib/client/download';
import { FrameLocator, Locator } from 'playwright-core/lib/client/locator';
import { ElementHandle } from 'playwright-core/lib/client/elementHandle';
import { FileChooser } from 'playwright-core/lib/client/fileChooser';
import { TimeoutError } from 'playwright-core/lib/client/errors';
import { Frame } from 'playwright-core/lib/client/frame';
import { Keyboard, Mouse, Touchscreen } from 'playwright-core/lib/client/input';
import { JSHandle } from 'playwright-core/lib/client/jsHandle';
import { Route, WebSocket, WebSocketRoute } from 'playwright-core/lib/client/network';
import { Page } from 'playwright-core/lib/client/page';
import { Selectors } from 'playwright-core/lib/client/selectors';
import { Tracing } from 'playwright-core/lib/client/tracing';
import { Video } from 'playwright-core/lib/client/video';
import { Worker } from 'playwright-core/lib/client/worker';
import { CDPSession } from 'playwright-core/lib/client/cdpSession';
import { Playwright } from 'playwright-core/lib/client/playwright';
import { WebError } from 'playwright-core/lib/client/webError';

import {
  Crx,
  CrxApplication,
  CrxRecorder,
} from './crx';
import { currentZone } from '@utils/zones';

type ApiTypeMap = {
  // 'accessibility' left with page.accessibility, removed upstream in 1.57.
  // 'android': Android,
  // 'androidDevice': AndroidDevice,
  // 'androidWebView': AndroidWebView,
  // 'androidInput': AndroidInput,
  // 'androidSocket': AndroidSocket,
  'browser': Browser,
  'browserContext': BrowserContext,
  'browserType': BrowserType,
  'clock': Clock,
  'consoleMessage': ConsoleMessage,
  'coverage': Coverage,
  'dialog': Dialog,
  'download': Download,
  // 'electron': Electron,
  // 'electronApplication': ElectronApplication,
  'locator': Locator,
  'frameLocator': FrameLocator,
  'elementHandle': ElementHandle,
  'fileChooser': FileChooser,
  'timeoutError': TimeoutError,
  'frame': Frame,
  'keyboard': Keyboard,
  'mouse': Mouse,
  'touchscreen': Touchscreen,
  'jSHandle': JSHandle,
  'route': Route,
  'webSocket': WebSocket,
  'webSocketRoute': WebSocketRoute,
  // 'request': APIRequest,
  // 'requestContext': APIRequestContext,
  // 'response': APIResponse,
  'page': Page,
  'selectors': Selectors,
  'tracing': Tracing,
  'video': Video,
  'worker': Worker,
  'session': CDPSession,
  'playwright': Playwright,
  'webError': WebError,

  // from crx
  'crx': Crx,
  'crxApplication': CrxApplication,
  'crxRecorder': CrxRecorder
};

type KeysOfAsyncMethods<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => Promise<any> ? (K extends `_${string}` | 'removeAllListeners' ? never : K) : never;
}[Extract<keyof T, string>];

const apis: { [ApiK in keyof ApiTypeMap]: [ApiTypeMap[ApiK], { [K in KeysOfAsyncMethods<ApiTypeMap[ApiK]>]: boolean }] } = {
  // android: [Android.prototype],
  // androidDevice: [AndroidDevice.prototype],
  // androidWebView: [AndroidWebView.prototype],
  // androidInput: [AndroidInput.prototype],
  // androidSocket: [AndroidSocket.prototype],
  browser: [Browser.prototype, { newContext: true, newPage: true, newBrowserCDPSession: true, startTracing: true, stopTracing: true, close: true, bind: true, unbind: true }],
  browserContext: [BrowserContext.prototype, {
    newPage: true,
    cookies: true,
    addCookies: true,
    clearCookies: true,
    grantPermissions: true,
    clearPermissions: true,
    setGeolocation: true,
    setExtraHTTPHeaders: true,
    setOffline: true,
    setHTTPCredentials: true,
    addInitScript: true,
    exposeBinding: true,
    exposeFunction: true,
    route: true,
    routeWebSocket: true,
    routeFromHAR: true,
    unrouteAll: true,
    unroute: true,
    waitForEvent: true,
    storageState: true,
    newCDPSession: true,
    setStorageState: true,
    close: true
  }],
  browserType: [BrowserType.prototype, { launch: true, launchServer: true, launchPersistentContext: true, connect: true, connectOverCDP: true }],
  clock: [Clock.prototype, { install: true, fastForward: true, pauseAt: true, resume: true, runFor: true, setFixedTime: true, setSystemTime: true }],
  consoleMessage: [ConsoleMessage.prototype, {}],
  coverage: [Coverage.prototype, { startCSSCoverage: true, stopCSSCoverage: true, startJSCoverage: true, stopJSCoverage: true }],
  dialog: [Dialog.prototype, { accept: true, dismiss: true }],
  download: [Download.prototype, { cancel: true, createReadStream: true, path: true, failure: true, delete: true, saveAs: true }],
  // electron: [Electron.prototype, {}],
  // electronApplication: [ElectronApplication.prototype, {}],
  locator: [Locator.prototype, {
    boundingBox: true,
    check: true,
    click: true,
    dblclick: true,
    dispatchEvent: true,
    dragTo: true,
    evaluate: true,
    evaluateAll: true,
    evaluateHandle: true,
    fill: true,
    clear: true,
    highlight: true,
    elementHandle: true,
    elementHandles: true,
    focus: true,
    blur: true,
    count: true,
    getAttribute: true,
    hover: true,
    innerHTML: true,
    innerText: true,
    inputValue: true,
    isChecked: true,
    isDisabled: true,
    isEditable: true,
    isEnabled: true,
    isHidden: true,
    isVisible: true,
    press: true,
    screenshot: true,
    ariaSnapshot: true,
    scrollIntoViewIfNeeded: true,
    selectOption: true,
    selectText: true,
    setChecked: true,
    setInputFiles: true,
    tap: true,
    textContent: true,
    type: true,
    pressSequentially: true,
    uncheck: true,
    all: true,
    allInnerTexts: true,
    allTextContents: true,
    waitFor: true,
    normalize: true,
    // added to Locator in 1.60
    drop: true,
    hideHighlight: true,
    // added to Locator in 1.62
    waitForFunction: true,
  }],
  frameLocator: [FrameLocator.prototype, {}],
  elementHandle: [ElementHandle.prototype, {
    // from JSHandle
    evaluate: true,
    evaluateHandle: true,
    getProperty: true,
    getProperties: true,
    jsonValue: true,
    dispose: true,
    // from ElementHandle
    ownerFrame: true,
    contentFrame: true,
    getAttribute: true,
    inputValue: true,
    textContent: true,
    innerText: true,
    innerHTML: true,
    isChecked: true,
    isDisabled: true,
    isEditable: true,
    isEnabled: true,
    isHidden: true,
    isVisible: true,
    dispatchEvent: true,
    scrollIntoViewIfNeeded: true,
    hover: true,
    click: true,
    dblclick: true,
    tap: true,
    selectOption: true,
    fill: true,
    selectText: true,
    setInputFiles: true,
    focus: true,
    type: true,
    press: true,
    check: true,
    uncheck: true,
    setChecked: true,
    boundingBox: true,
    screenshot: true,
    $: true,
    $$: true,
    $eval: true,
    $$eval: true,
    waitForElementState: true,
    waitForSelector: true,
  }],
  fileChooser: [FileChooser.prototype, { setFiles: true }],
  // 1.61 gave PlaywrightError a `details?: any` field. KeysOfAsyncMethods sweeps any
  // `any`-typed key in, since `any` is assignable to a promise-returning function —
  // so it has to be listed, but as data it must not be wrapped. `false` says both.
  timeoutError: [TimeoutError.prototype, { details: false }],
  frame: [Frame.prototype, {
    goto: true,
    waitForNavigation: true,
    waitForLoadState: true,
    waitForURL: true,
    frameElement: true,
    evaluateHandle: true,
    evaluate: true,
    $: true,
    $$: true,
    waitForSelector: true,
    dispatchEvent: true,
    $eval: true,
    $$eval: true,
    content: true,
    setContent: true,
    addScriptTag: true,
    addStyleTag: true,
    click: true,
    dblclick: true,
    dragAndDrop: true,
    tap: true,
    fill: true,
    focus: true,
    textContent: true,
    innerText: true,
    innerHTML: true,
    getAttribute: true,
    inputValue: true,
    isChecked: true,
    isDisabled: true,
    isEditable: true,
    isEnabled: true,
    isHidden: true,
    isVisible: true,
    hover: true,
    selectOption: true,
    setInputFiles: true,
    type: true,
    press: true,
    check: true,
    uncheck: true,
    setChecked: true,
    waitForTimeout: true,
    waitForFunction: true,
    title: true
  }],
  keyboard: [Keyboard.prototype, { down: true, up: true, insertText: true, type: true, press: true }],
  mouse: [Mouse.prototype, { click: true, dblclick: true, down: true, up: true, move: true, wheel: true }],
  touchscreen: [Touchscreen.prototype, { tap: true }],
  jSHandle: [JSHandle.prototype, { evaluate: true, evaluateHandle: true, getProperty: true, jsonValue: true, getProperties: true, dispose: true }],
  route: [Route.prototype, { fallback: true, abort: true, fetch: true, fulfill: true, continue: true }],
  webSocket: [WebSocket.prototype, { waitForEvent: true }],
  webSocketRoute: [WebSocketRoute.prototype, { close: true }],
  // request: [APIRequest.prototype, {}],
  // requestContext: [APIRequestContext.prototype, {}],
  // response: [APIResponse.prototype, {}],
  page: [Page.prototype, {
    opener: true,
    waitForSelector: true,
    dispatchEvent: true,
    evaluateHandle: true,
    $: true,
    $$: true,
    $eval: true,
    $$eval: true,
    addScriptTag: true,
    addStyleTag: true,
    exposeFunction: true,
    exposeBinding: true,
    setExtraHTTPHeaders: true,
    content: true,
    setContent: true,
    goto: true,
    reload: true,
    addLocatorHandler: true,
    removeLocatorHandler: true,
    waitForLoadState: true,
    waitForNavigation: true,
    waitForURL: true,
    waitForRequest: true,
    waitForResponse: true,
    waitForEvent: true,
    goBack: true,
    goForward: true,
    requestGC: true,
    emulateMedia: true,
    setViewportSize: true,
    evaluate: true,
    addInitScript: true,
    route: true,
    routeFromHAR: true,
    routeWebSocket: true,
    unrouteAll: true,
    unroute: true,
    screenshot: true,
    title: true,
    bringToFront: true,
    close: true,
    click: true,
    dragAndDrop: true,
    dblclick: true,
    tap: true,
    fill: true,
    focus: true,
    textContent: true,
    innerText: true,
    innerHTML: true,
    getAttribute: true,
    inputValue: true,
    isChecked: true,
    isDisabled: true,
    isEditable: true,
    isEnabled: true,
    isHidden: true,
    isVisible: true,
    hover: true,
    selectOption: true,
    setInputFiles: true,
    type: true,
    press: true,
    check: true,
    uncheck: true,
    setChecked: true,
    waitForTimeout: true,
    waitForFunction: true,
    pause: true,
    pdf: true,
    // Added to Page in 1.56. Wrapped like every other async Page API so their api-name
    // attribution stays inside the crx zone; the type here is exhaustive, so a new method
    // that is not listed fails the build rather than silently escaping it. (1.58's
    // page.agent() was gone again by 1.59 — the same exhaustiveness caught its removal.)
    requests: true,
    consoleMessages: true,
    pageErrors: true,
    // 1.59: aria snapshotting on the page, the pick-locator pair the recorder now
    // drives through the client API, and the console/error clears that go with
    // consoleMessages/pageErrors above.
    ariaSnapshot: true,
    pickLocator: true,
    cancelPickLocator: true,
    clearConsoleMessages: true,
    clearPageErrors: true,
    // added to Page in 1.60
    hideHighlight: true,
  }],
  selectors: [Selectors.prototype, { register: true }],
  // startHar/stopHar added to Tracing in 1.60
  tracing: [Tracing.prototype, { group: true, groupEnd: true, start: true, startChunk: true, stop: true, stopChunk: true, startHar: true, stopHar: true }],
  video: [Video.prototype, { delete: true, path: true, saveAs: true }],
  // waitForEvent added to Worker in 1.57.
  worker: [Worker.prototype, { evaluate: true, evaluateHandle: true, waitForEvent: true }],
  session: [CDPSession.prototype, { send: true, detach: true }],
  playwright: [Playwright.prototype, { devices: false }],
  webError: [WebError.prototype, {}],

  // from crx
  crx: [Crx.prototype, { start: true, get: true }],
  crxApplication: [CrxApplication.prototype, { attach: true, attachAll: true, close: true, detach: true, detachAll: true, newPage: true }],
  crxRecorder: [CrxRecorder.prototype, { hide: true, list: true, load: true, run: true, setMode: true, show: true }],
};

const kCrxZoneWrapped = Symbol('crxZone');

export function wrapClientApis() {
  for (const [typeName, [proto, props]] of Object.entries(apis)) {
    for (const [key, needsWrap] of Object.entries(props)) {
      if (!needsWrap)
        continue;
      const originalFn = (proto as any)[key!];

      if (!originalFn || typeof originalFn !== 'function')
        throw new Error(`Method ${key} not found in ${typeName}`);

      if (originalFn[kCrxZoneWrapped] === true)
        continue;

      const wrapFn = async function(this: any, ...args: any[]) {
        const apiName = currentZone().data<{ apiName: string }>('crxZone');
        if (apiName)
          return await originalFn.apply(this, args);
        return await currentZone().with('crxZone', { apiName: `${typeName}.${key}` }).run(async () => await originalFn.apply(this, args));
      };
      wrapFn[kCrxZoneWrapped] = true;
      (proto as any)[key!] = wrapFn;
    }
  }
}
