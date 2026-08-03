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

import EventEmitter from 'events';
import type { BrowserContext } from 'playwright-core/lib/server/browserContext';
import { Page } from 'playwright-core/lib/server/page';
import { createGuid, isUnderTest, ManualPromise, monotonicTime, serializeExpectedTextValues } from 'playwright-core/lib/utils';
import type { Frame } from 'playwright-core/lib/server/frames';
import type { CallMetadata } from '@protocol/callMetadata';
import { serializeError } from 'playwright-core/lib/server/errors';
import { buildFullSelector } from 'playwright-core/lib/server/recorder/recorderUtils';
import { toKeyboardModifiers } from 'playwright-core/lib/server/codegen/language';
import type { ActionInContextWithLocation, Location } from './parser';
import type { ActionInContext, FrameDescription } from '@recorder/actions';
import type { StructuredError } from './syntheticsRecorderApp';
import { toClickOptions } from 'playwright-core/lib/server/recorder/recorderRunner';
import { parseAriaSnapshotUnsafe } from 'playwright-core/lib/utils/isomorphic/ariaSnapshot';
import { serverSideCallMetadata } from 'playwright-core/lib/server';
import type { Crx } from '../crx';
import type { InstrumentationListener } from 'playwright-core/lib/server/instrumentation';
import { traceParamsForAction } from './recorderUtils';
import { yaml } from 'playwright-core/lib/utilsBundle';

class Stopped extends Error {}

function buildStructuredError(
  e: unknown,
  serialized: ReturnType<typeof serializeError>,
  action: PerformAction,
): StructuredError {
  const err = e as Error;
  const errorData = serialized.error;
  let selector: string | undefined;
  if ('selector' in action.action)
    selector = (action.action as any).selector;
  return {
    message: err.message ?? String(e),
    name: errorData?.name ?? err.name,
    stack: errorData?.stack ?? err.stack,
    actionName: action.action.name,
    selector,
  };
}

export type PerformAction = ActionInContextWithLocation | {
  action: {
    name: 'pause';
  };
  frame: FrameDescription;
  location?: Location;
};

export default class CrxPlayer extends EventEmitter {

  private _crx: Crx;
  private _currAction?: PerformAction;
  private _stopping?: ManualPromise;
  private _pageAliases = new Map<Page, string>();
  private _pause?: Promise<void>;
  // Context the current run() is executing against. stop() needs it to abort the
  // in-flight call; _checkStopped() alone only lands at the next step boundary.
  private _runningContext?: BrowserContext;

  constructor(crx: Crx) {
    super();
    this._crx = crx;
  }

  async pause() {
    if (!this._pause) {
      const context = (await this._crx.get({ incognito: false }))!._context;
      const pauseAction = {
        action: { name: 'pause' },
        frame: { pageAlias: 'page', framePath: [] },
      } satisfies PerformAction;
      this._pause = this
          ._performAction(context, pauseAction)
          .finally(() => this._pause = undefined)
          .catch(() => {});
    }
    await this._pause;
  }

  async run(pageOrContext: Page | BrowserContext, actions: PerformAction[]) {
    if (this.isPlaying())
      return;

    let page: Page;
    let context: BrowserContext;

    if (pageOrContext instanceof Page) {
      page = pageOrContext;
      // Server-side Page exposes `browserContext`; `context()` is the client-side
      // API. Nothing ever passed a Page here before, so the mistake stayed hidden.
      context = page.browserContext;
    } else {
      context = pageOrContext;
      page = context.pages()[0] ?? await context.newPage(serverSideCallMetadata());
    }

    const crxApp = await this._crx.get({ incognito: false });
    const recorder = crxApp?._recorder();
    let instrumentationListener: InstrumentationListener | undefined;

    if (recorder && crxApp && crxApp._context !== context) {
      // we intercept incognito call logs and forward them into the recorder
      const instrumentationListener: InstrumentationListener = {
        onBeforeCall: recorder.onBeforeCall.bind(recorder),
        onBeforeInputAction: recorder.onBeforeInputAction.bind(recorder),
        onCallLog: recorder.onCallLog.bind(recorder),
        onAfterCall: recorder.onAfterCall.bind(recorder),
      };
      if (instrumentationListener)
        context.instrumentation.addListener(instrumentationListener, context);
    }

    this._pageAliases.clear();
    this._pageAliases.set(page, 'page');
    this._runningContext = context;
    this.emit('start');

    try {
      let actionIndex = 0;
      for (const action of actions) {
        if (action.action.name === 'openPage' && action.frame.pageAlias === 'page')
          continue;
        // A stop that landed between two actions has no pending call to abort, so check
        // before announcing the step. Announcing it and only then throwing Stopped is what
        // left consumers holding a stepStarted that no stepResult ever answered.
        if (this._consumeStopRequest())
          return;
        this._currAction = action;
        this.emit('stepStarted', { actionIndex });
        const startTime = monotonicTime();
        try {
          await this._performAction(context, action);
          this.emit('stepResult', {
            actionIndex,
            passed: true,
            duration_ms: Math.round((monotonicTime() - startTime) * 1000),
            error: undefined,
          });
        } catch (e) {
          // Cancelled by stop(): stopPendingOperations aborts the pending call, and it
          // rejects with a serialized error object rather than our Stopped marker — so
          // instanceof cannot see it and we key off _stopping instead. Returning here is
          // the point: a step the user cancelled must not be reported as a failure, and
          // the loop must not advance to emit a stepStarted that never gets a result.
          if (this._consumeStopRequest())
            return;
          if (e instanceof Stopped)
            return;
          const serialized = serializeError(e);
          this.emit('stepResult', {
            actionIndex,
            passed: false,
            duration_ms: Math.round((monotonicTime() - startTime) * 1000),
            error: (e as Error).message,
            structuredError: buildStructuredError(e, serialized, action),
          });
          throw e;
        }
        actionIndex++;
      }
    } catch (e) {
      if (e instanceof Stopped)
        return;
      throw e;
    } finally {
      this._currAction = undefined;
      this._runningContext = undefined;
      this.pause().catch(() => {});
      if (instrumentationListener)
        context.instrumentation.removeListener(instrumentationListener);
    }
  }

  isPlaying() {
    return !!this._currAction;
  }

  async stop() {
    if (this._currAction || this._pause) {
      this._currAction = undefined;
      this._stopping = new ManualPromise();
      // Abort whatever call is pending right now. _checkStopped() only runs at the START
      // of an action, so without this the stop waits out the in-flight click/fill/expect
      // — up to kActionTimeout, 60s — and only lands one step later.
      await this._runningContext?.stopPendingOperations('Stopped').catch(() => {});
      await Promise.all([
        this._stopping,
        this._pause,
      ]);
      this._stopping = undefined;
      this._pause = undefined;
      this.emit('stop');
    }
  }

  // "borrowed" from ContextRecorder
  private async _performAction(browserContext: BrowserContext, actionInContext: PerformAction) {
    this._checkStopped();

    const innerPerformAction = async (mainFrame: Frame | null, actionInContext: PerformAction, cb: (callMetadata: CallMetadata) => Promise<any>): Promise<void> => {
      // we must use the default browser context here!
      const context = mainFrame ?? browserContext;

      const traceParams = actionInContext.action.name === 'pause' ?
        { method: 'pause', params: {}, apiName: 'page.pause' } :
        traceParamsForAction(actionInContext as ActionInContext);

      const callMetadata: CallMetadata = {
        id: `call@${createGuid()}`,
        internal: actionInContext.action.name === 'pause',
        objectId: context.guid,
        pageId: mainFrame?._page.guid,
        frameId: mainFrame?.guid,
        startTime: monotonicTime(),
        endTime: 0,
        type: 'Frame',
        log: [],
        location: actionInContext.location,
        playing: true,
        ...traceParams,
      };

      try {
        this._checkStopped();
        await context.instrumentation.onBeforeCall(context, callMetadata);
        this._checkStopped();
        await cb(callMetadata);
      } catch (e) {
        callMetadata.error = serializeError(e);
      } finally {
        callMetadata.endTime = monotonicTime();
        await context.instrumentation.onAfterCall(context, callMetadata);
        if (callMetadata.error)
          throw callMetadata.error.error;
      }
    };

    // similar to playwright/packages/playwright-core/src/server/recorder/recorderRunner.ts
    //
    // 60s, flat — NOT the upstream 5s, and deliberately not mirroring the probe's
    // 60s/30s split. The preview must never be STRICTER than production (spec
    // X-8.1): a Test that fails where the scheduled run passes teaches authors to
    // insert sleeps, which is the exact behaviour this design exists to remove.
    // The largest timeout any step can have in the probe is 60s — the category
    // defaults are 60s (navigate/assert) and 30s (interaction), and an explicit
    // per-step timeout_ms is validated into 100..=60000 — so a flat 60s here is
    // provably never stricter, for any step, and needs no fork of Playwright's
    // Action type to carry a per-step timeout.
    //
    // Cost, accepted: a genuinely broken step now takes 60s to report instead of
    // 5s. Mitigated in the UI (elapsed time per step + a reachable cancel), not
    // by shortening this — a fast wrong answer is what produced the sleeps.
    const kActionTimeout = isUnderTest() ? 2000 : 60_000;

    const { action } = actionInContext;
    const pageAliases = this._pageAliases;
    const context = browserContext;

    // Internal marker emitted by actionMapper for steps the player cannot
    // execute (hover/scroll/wait/screenshot — none exist in Playwright's
    // recorder action model). Return before any instrumentation so the step is
    // genuinely skipped: it must not reach onBeforeCall, or the recorder reacts
    // to it. The consumer reports these as "not simulated"; they must never be
    // presented to an author as a pass.
    if ((action as any).name === 'noop')
      return;

    if (action.name === 'pause')
      return await innerPerformAction(null, actionInContext, () => Promise.resolve());

    if (action.name === 'openPage') {
      return await innerPerformAction(null, actionInContext, async callMetadata => {
        const pageAlias = actionInContext.frame.pageAlias;
        if ([...pageAliases.values()].includes(pageAlias))
          throw new Error(`Page with alias ${pageAlias} already exists`);
        const newPage = await context.newPage(callMetadata);
        if (action.url && action.url !== 'about:blank' && action.url !== 'chrome://newtab/') {
          const navigateCallMetadata = {
            ...callMetadata,
            ...traceParamsForAction({ ...actionInContext, action: { name: 'navigate', url: action.url } } as ActionInContext),
          };
          await newPage.mainFrame().goto(navigateCallMetadata, action.url, { timeout: kActionTimeout });
        }
        pageAliases.set(newPage, pageAlias);
      });
    }

    const pageAlias = actionInContext.frame.pageAlias;
    const page = [...pageAliases.entries()].find(([, alias]) => pageAlias === alias)?.[0];
    if (!page)
      throw new Error('Internal error: page not found');
    const mainFrame = page.mainFrame();

    if (action.name === 'navigate')
      return await innerPerformAction(mainFrame, actionInContext, callMetadata => mainFrame.goto(callMetadata, action.url, { timeout: kActionTimeout }));

    if (action.name === 'closePage') {
      return await innerPerformAction(mainFrame, actionInContext, async callMetadata => {
        pageAliases.delete(page);
        await page.close(callMetadata, { runBeforeUnload: true });
      });
    }

    const selector = buildFullSelector(actionInContext.frame.framePath, action.selector);

    if (action.name === 'click') {
      const options = toClickOptions(action);
      return await innerPerformAction(mainFrame, actionInContext, callMetadata => mainFrame.click(callMetadata, selector, { ...options, timeout: kActionTimeout, strict: true }));
    }
    if (action.name === 'press') {
      const modifiers = toKeyboardModifiers(action.modifiers);
      const shortcut = [...modifiers, action.key].join('+');
      return await innerPerformAction(mainFrame, actionInContext, callMetadata => mainFrame.press(callMetadata, selector, shortcut, { timeout: kActionTimeout, strict: true }));
    }
    if (action.name === 'fill')
      return await innerPerformAction(mainFrame, actionInContext, callMetadata => mainFrame.fill(callMetadata, selector, action.text, { timeout: kActionTimeout, strict: true }));
    if (action.name === 'setInputFiles')
      return await innerPerformAction(mainFrame, actionInContext, () => Promise.reject(new Error(`player does not support setInputFiles yet`)));
    if (action.name === 'check')
      return await innerPerformAction(mainFrame, actionInContext, callMetadata => mainFrame.check(callMetadata, selector, { timeout: kActionTimeout, strict: true }));
    if (action.name === 'uncheck')
      return await innerPerformAction(mainFrame, actionInContext, callMetadata => mainFrame.uncheck(callMetadata, selector, { timeout: kActionTimeout, strict: true }));
    if (action.name === 'select') {
      const values = action.options.map((value: any) => ({ value }));
      return await innerPerformAction(mainFrame, actionInContext, callMetadata => mainFrame.selectOption(callMetadata, selector, [], values, { timeout: kActionTimeout, strict: true }));
    }
    if (action.name === 'assertChecked') {
      return await innerPerformAction(mainFrame, actionInContext, callMetadata => mainFrame.expect(callMetadata, selector, {
        selector,
        expression: 'to.be.checked',
        expectedValue: { checked: true },
        isNot: !action.checked,
        timeout: kActionTimeout,
      }));
    }
    if (action.name === 'assertText') {
      return await innerPerformAction(mainFrame, actionInContext, callMetadata => mainFrame.expect(callMetadata, selector, {
        selector,
        expression: 'to.have.text',
        expectedText: serializeExpectedTextValues([action.text], { matchSubstring: true, normalizeWhiteSpace: true }),
        isNot: false,
        timeout: kActionTimeout,
      }));
    }
    if (action.name === 'assertValue') {
      return await innerPerformAction(mainFrame, actionInContext, callMetadata => mainFrame.expect(callMetadata, selector, {
        selector,
        expression: 'to.have.value',
        expectedText: serializeExpectedTextValues([action.value], { matchSubstring: false, normalizeWhiteSpace: true }),
        isNot: false,
        timeout: kActionTimeout,
      }));
    }
    if (action.name === 'assertVisible') {
      return await innerPerformAction(mainFrame, actionInContext, callMetadata => mainFrame.expect(callMetadata, selector, {
        selector,
        expression: 'to.be.visible',
        isNot: false,
        timeout: kActionTimeout,
      }));
    }
    if (action.name === 'assertSnapshot') {
      return await innerPerformAction(mainFrame, actionInContext, callMetadata => mainFrame.expect(callMetadata, selector, {
        selector,
        expression: 'to.match.aria',
        expectedValue: parseAriaSnapshotUnsafe(yaml, action.snapshot),
        isNot: false,
        timeout: kActionTimeout,
      }));
    }
    throw new Error('Internal error: unexpected action ' + (action as any).name);
  }

  private _checkStopped() {
    if (this._consumeStopRequest())
      throw new Stopped();
  }

  // Acknowledges a stop request, releasing the promise stop() is waiting on. Returns true
  // when a stop was in flight, so callers can unwind. Kept as a method rather than an
  // inline `if (this._stopping)` because stop() mutates the field concurrently — narrowing
  // it in one branch of run() would wrongly narrow it in every later branch.
  private _consumeStopRequest(): boolean {
    if (!this._stopping)
      return false;
    this._stopping.resolve();
    return true;
  }
}
