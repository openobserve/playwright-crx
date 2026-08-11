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
import { isUnderTest } from '@utils/debug';
import { ManualPromise } from '@isomorphic/manualPromise';
import { monotonicTime } from '@isomorphic/time';
import { serializeExpectedTextValues } from '@isomorphic/expectUtils';
import { serializeError } from 'playwright-core/lib/server/errors';
import { buildFullSelector } from 'playwright-core/lib/server/recorder/recorderUtils';
import { toKeyboardModifiers } from 'playwright-core/lib/server/codegen/language';
import type { ActionInContextWithLocation, Location } from './parser';
import type { FrameDescription } from '@recorder/actions';
import type { StructuredError } from './syntheticsRecorderApp';
import { toClickOptions } from 'playwright-core/lib/server/recorder/recorderRunner';
import { nullProgress, ProgressController } from 'playwright-core/lib/server/progress';
import type { CallMetadata } from 'playwright-core/lib/server/instrumentation';
import type { Progress } from 'playwright-core/lib/server/progress';
import type { Crx } from '../crx';
import type { InstrumentationListener, SdkObject } from 'playwright-core/lib/server/instrumentation';

class Stopped extends Error {}

// 1.55 deleted `serverSideCallMetadata()` and gave ProgressController a default
// metadata of its own — but that default is `internal: true`, which upstream uses to
// keep housekeeping calls out of traces. Replay steps are not housekeeping, so the
// player keeps building the same non-internal metadata 1.54 gave it.
function playerCallMetadata(): CallMetadata {
  return { id: '', startTime: 0, endTime: 0, type: 'Internal', method: '', params: {}, log: [] };
}

// 1.55 also removed ProgressController's SdkObject, and with it the instrumentation
// call it used to make from `progress.log` (see the 1.54 controller, which did
// `instrumentation.onCallLog(sdkObject, metadata, logName, message)` on every log).
// The controller now only offers an opt-in callback, so callers forward the logs
// themselves; upstream's own dispatcher does exactly this in `_runCommand`.
//
// This is not cosmetic for us: the recorder's call-log panel — and the incognito
// forwarding listener installed in run() — are fed entirely from onCallLog. Without
// this, a replay executes correctly but narrates nothing.
function progressControllerFor(sdkObject: SdkObject): ProgressController {
  const metadata = playerCallMetadata();
  return new ProgressController(metadata, message => {
    sdkObject.instrumentation.onCallLog(sdkObject, metadata, sdkObject.logName || 'api', message);
  });
}

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
  // The controller driving the call that is in flight right now. stop() aborts it;
  // _checkStopped() alone only lands at the next step boundary.
  //
  // 1.54 removed `BrowserContext.stopPendingOperations()`, which is what this used to
  // call. ProgressController.abort() is the replacement and is strictly better here:
  // it cancels exactly this player's call instead of every pending operation on the
  // context, so a stop can no longer disturb unrelated work (e.g. the recorder's own).
  private _currentController?: ProgressController;

  constructor(crx: Crx) {
    super();
    this._crx = crx;
  }

  async pause() {
    if (!this._pause) {
      const context = (await this._crx.get({ incognito: false }))!._context;
      const pauseAction = {
        action: { name: 'pause' },
        frame: { pageGuid: '', pageAlias: 'page', framePath: [] },
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
      page = context.pages()[0] ?? await progressControllerFor(context)
          .run(progress => context.newPage(progress, false));
    }

    const crxApp = await this._crx.get({ incognito: false });
    const recorder = crxApp?._recorder();
    let instrumentationListener: InstrumentationListener | undefined;

    if (recorder && crxApp && crxApp._context !== context) {
      // we intercept incognito call logs and forward them into the recorder
      const instrumentationListener: InstrumentationListener = {
        onBeforeCall: recorder.onBeforeCall.bind(recorder),
        // 1.59 dropped onBeforeInputAction from the Recorder. It only ever cleared the
        // highlight before an input action; the recorder now does that from onBeforeCall.
        onCallLog: recorder.onCallLog.bind(recorder),
        onAfterCall: recorder.onAfterCall.bind(recorder),
      };
      if (instrumentationListener)
        context.instrumentation.addListener(instrumentationListener, context);
    }

    // Preserve aliases across calls: stepping runs one action per run(), and clearing
    // here would drop the aliases that earlier openPage steps created.
    if (!this._pageAliases.has(page)) {
      this._pageAliases.clear();
      this._pageAliases.set(page, 'page');
    }
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
      this.pause().catch(() => {});
      if (instrumentationListener)
        context.instrumentation.removeListener(instrumentationListener);
    }
  }

  isPlaying() {
    return !!this._currAction;
  }

  /** Drops page aliases so the next run() starts a fresh replay. */
  resetPageAliases() {
    this._pageAliases.clear();
  }

  async stop() {
    if (this._currAction || this._pause) {
      this._currAction = undefined;
      this._stopping = new ManualPromise();
      // Abort whatever call is pending right now. _checkStopped() only runs at the START
      // of an action, so without this the stop waits out the in-flight click/fill/expect
      // — up to kActionTimeout, 60s — and only lands one step later.
      await this._currentController?.abort(new Stopped()).catch(() => {});
      await Promise.all([
        this._stopping,
        this._pause,
      ]);
      this._stopping = undefined;
      this._pause = undefined;
      this.emit('stop');
    }
  }

  // Mirrors playwright/packages/playwright-core/src/server/recorder/recorderRunner.ts,
  // which since 1.54 drives frame methods with a Progress from a ProgressController
  // instead of hand-built CallMetadata (microsoft/playwright#36429 and follow-ups).
  //
  // The controller is stored on the instance so stop() can abort the call in flight.
  private async _runWithProgress<T>(sdkObject: SdkObject, task: (progress: Progress) => Promise<T>, timeout: number): Promise<T> {
    const controller = progressControllerFor(sdkObject);
    this._currentController = controller;
    try {
      return await controller.run(task, timeout);
    } finally {
      if (this._currentController === controller)
        this._currentController = undefined;
    }
  }

  private async _performAction(browserContext: BrowserContext, actionInContext: PerformAction) {
    this._checkStopped();

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
      return;

    if (action.name === 'openPage') {
      const pageAlias = actionInContext.frame.pageAlias;
      if ([...pageAliases.values()].includes(pageAlias))
        throw new Error(`Page with alias ${pageAlias} already exists`);
      const newPage = await this._runWithProgress(context, progress => context.newPage(progress, false), kActionTimeout);
      if (action.url && action.url !== 'about:blank' && action.url !== 'chrome://newtab/') {
        await this._runWithProgress(newPage.mainFrame(),
            progress => newPage.mainFrame().goto(progress, action.url), kActionTimeout);
      }
      pageAliases.set(newPage, pageAlias);
      return;
    }

    const pageAlias = actionInContext.frame.pageAlias;
    const page = [...pageAliases.entries()].find(([, alias]) => pageAlias === alias)?.[0];
    if (!page)
      throw new Error('Internal error: page not found');
    const mainFrame = page.mainFrame();

    if (action.name === 'closePage') {
      pageAliases.delete(page);
      // 1.60 made Page.close take a Progress; 1.61 moved runBeforeUnload out of its
      // options into a method of its own. Nothing here is cancellable — the step is
      // closing a page it already owns — so both run unbounded, as the untimed close did.
      await page.runBeforeUnload(nullProgress);
      await page.close(nullProgress);
      return;
    }

    await this._runWithProgress(mainFrame, async progress => {
      this._checkStopped();

      if (action.name === 'navigate')
        return await mainFrame.goto(progress, action.url);

      const selector = buildFullSelector(actionInContext.frame.framePath, action.selector);

      if (action.name === 'click')
        return await mainFrame.click(progress, selector, { ...toClickOptions(action), strict: true });
      if (action.name === 'press') {
        const shortcut = [...toKeyboardModifiers(action.modifiers), action.key].join('+');
        return await mainFrame.press(progress, selector, shortcut, { strict: true });
      }
      if (action.name === 'fill')
        return await mainFrame.fill(progress, selector, action.text, { strict: true });
      if (action.name === 'setInputFiles')
        throw new Error(`player does not support setInputFiles yet`);
      if (action.name === 'check')
        return await mainFrame.check(progress, selector, { strict: true });
      if (action.name === 'uncheck')
        return await mainFrame.uncheck(progress, selector, { strict: true });
      if (action.name === 'select')
        return await mainFrame.selectOption(progress, selector, [], action.options.map((value: any) => ({ value })), { strict: true });

      // 1.54 had made Frame.expect() RESOLVE with { matches } instead of throwing, so this
      // wrapped it and turned a false result back into a throw — without which every
      // failing assertion replayed as a pass. 1.61 returned it to throwing (it now returns
      // void), which makes the wrapper not merely redundant but inverted: `result.matches`
      // on undefined would throw on every assertion that PASSED. Calling it directly again.
      const expectAndThrow = (options: Parameters<typeof mainFrame.expect>[2]) =>
        mainFrame.expect(progress, selector, options);

      if (action.name === 'assertChecked') {
        return await expectAndThrow({
          selector,
          expression: 'to.be.checked',
          expectedValue: { checked: action.checked },
          isNot: false,
        });
      }
      if (action.name === 'assertText') {
        return await expectAndThrow({
          selector,
          expression: 'to.have.text',
          expectedText: serializeExpectedTextValues([action.text], { matchSubstring: true, normalizeWhiteSpace: true }),
          isNot: false,
        });
      }
      if (action.name === 'assertValue') {
        return await expectAndThrow({
          selector,
          expression: 'to.have.value',
          expectedText: serializeExpectedTextValues([action.value], { matchSubstring: false, normalizeWhiteSpace: true }),
          isNot: false,
        });
      }
      if (action.name === 'assertVisible') {
        return await expectAndThrow({
          selector,
          expression: 'to.be.visible',
          isNot: false,
        });
      }
      if (action.name === 'assertSnapshot') {
        return await expectAndThrow({
          selector,
          expression: 'to.match.aria',
          // 1.54 renamed the action field `snapshot` -> `ariaSnapshot`. 1.61 moved the
          // parsing into Frame.expect itself, so the raw string goes across now — parsing
          // it here first made expect parse an already-parsed template and every
          // aria-snapshot assertion replayed red.
          expectedValue: action.ariaSnapshot,
          isNot: false,
        });
      }
      throw new Error('Internal error: unexpected action ' + (action as any).name);
    }, kActionTimeout);
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
