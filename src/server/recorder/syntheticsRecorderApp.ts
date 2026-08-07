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
 * SyntheticsRecorderApp — IRecorderApp implementation for the synthetics recorder.
 * Uses a HeadlessRecorderWindow (no Playwright editor UI) and maps captured
 * ActionInContext[] to BrowserStep[], forwarding them to O2 via a callback.
 */

import { EventEmitter } from 'events';
import type { CallLog, ElementInfo, Mode, Source } from '@recorder/recorderTypes';
import type { Page } from 'playwright-core/lib/server/page';
import { Recorder, RecorderEvent } from 'playwright-core/lib/server/recorder';
import type { ActionInContext } from '@recorder/actions';
import type * as actions from '@recorder/actions';
import { generateCode } from 'playwright-core/lib/server/codegen/language';
import { languageSet } from 'playwright-core/lib/server/codegen/languages';
import { collapseActions } from 'playwright-core/lib/server/recorder/recorderUtils';
import type { LanguageGeneratorOptions } from 'playwright-core/lib/server/codegen/types';
import type * as channels from '../../protocol/channels';
import type { Crx } from '../crx';
import { HeadlessRecorderWindow } from './headlessRecorderWindow';
import type { RecorderEventData, RecorderMessage, RecorderWindow } from './crxRecorderApp';
import { mapActionsToBrowserSteps } from './actionMapper';
import type { BrowserStep } from './actionMapper';
import { serverSideCallMetadata } from 'playwright-core/lib/server';
import { BrowserContext } from 'playwright-core/lib/server/browserContext';
import type { Response } from 'playwright-core/lib/server/network';
import { monotonicTime } from 'playwright-core/lib/utils';
import { NetworkRecorder, buildSettlePatterns, captureWindows } from './networkCapture';


export type StructuredError = {
  message: string;
  name?: string;
  stack?: string;
  /** The action that failed, e.g. "click", "fill", "navigate" */
  actionName?: string;
  /** The selector targeted by the failing action, if applicable */
  selector?: string;
};

export type StepStartedData = {
  actionIndex: number;
};

export type StepResultData = {
  actionIndex: number;
  passed: boolean;
  duration_ms: number;
  /** Raw error message (kept for backward compat). Prefer structuredError. */
  error?: string;
  /** Detailed, machine-readable error breakdown. */
  structuredError?: StructuredError;
};

export type SyntheticsForwardMessage =
  | (RecorderMessage & {
      browserSteps?: BrowserStep[];
      generatedCode?: string;
      generatedLanguage?: string;
    })
  | {
      type: 'recorder';
      method: 'stepReplayStarted';
      stepStarted: StepStartedData;
    }
  | {
      type: 'recorder';
      method: 'stepReplayResult';
      stepResult: StepResultData;
    };

export type SyntheticsForwardCallback = (msg: SyntheticsForwardMessage) => void;

export class SyntheticsRecorderApp extends EventEmitter {
  readonly wsEndpointForTest: string | undefined;
  readonly _recorder: Recorder;
  private _crx: Crx;
  private _mode: Mode = 'none';
  private _window?: RecorderWindow;
  private _recordedActions: ActionInContext[] = [];
  private _sources?: Source[];
  private _forwardCallback: SyntheticsForwardCallback;
  private _playInIncognito = false;
  private _network = new NetworkRecorder();
  /** Whether the network buffer is live, so the final rebuild runs exactly once. */
  private _collecting = false;

  constructor(
    crx: Crx,
    recorder: Recorder,
    forwardCallback: SyntheticsForwardCallback,
    context?: BrowserContext,
  ) {
    super();
    this._crx = crx;
    this._recorder = recorder;
    this._forwardCallback = forwardCallback;

    // P4.1.1 — the source is the extension's real Playwright context, not raw
    // CDP. It is the same API the probe waits on, so one matcher serves both
    // sides and a recorded pattern cannot be one the runner could never match.
    // When each request BEGAN, so a response that merely landed inside an
    // action's window can be told apart from one the action actually caused
    // (P4 / §3.5). Weakly held: the map must not keep a finished request alive
    // for the length of the recording session.
    const requestStartedAt = new WeakMap<object, number>();
    context?.on(BrowserContext.Events.Request, (request: object) => {
      requestStartedAt.set(request, monotonicTime());
    });
    context?.on(BrowserContext.Events.Response, (response: Response) => {
      this._network.record({
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        contentType: response.headerValue('content-type') ?? '',
        // The same clock `recorderCollection` stamps actions with. Mixing
        // Date.now() in here would make every action window miss.
        timestamp: monotonicTime(),
        initiatedAt: requestStartedAt.get(response.request()),
      });
    });
    this._crx.player.on('start', () => {
      this._recorder.clearErrors();
      this.resetCallLogs().catch(() => {});
    });
    this._crx.player.on('stepStarted', (data: StepStartedData) => {
      // eslint-disable-next-line no-console
      console.log('Step Started ----', data);
      this._forwardCallback({
        type: 'recorder',
        method: 'stepReplayStarted',
        stepStarted: data,
      });
    });
    this._crx.player.on('stepResult', (result: StepResultData) => {
      // eslint-disable-next-line no-console
      console.log('Step Result ----', result);
      this._forwardCallback({
        type: 'recorder',
        method: 'stepReplayResult',
        stepResult: result,
      });
    });

    // 1.54 reversed the Recorder <-> RecorderApp dependency (microsoft/playwright#36544).
    // The recorder now streams actions and signals instead of calling setActions() on us,
    // so the accumulation the deleted RecorderCollection did happens here. The BrowserStep
    // mapping and the network-evidence rebuild below are unchanged — they just run off
    // this list instead of a pushed one.
    recorder.on(RecorderEvent.ActionAdded, (action: actions.ActionInContext) => {
      this._recordedActions.push(action);
      this._regenerate();
    });
    // The navigation-signal patch in recorderSignalProcessor.ts is what makes this fire
    // for navigations caused by a click/press/fill. It is the evidence that turns a
    // recorded hard sleep into a wait condition, so it must land on the causing action.
    recorder.on(RecorderEvent.SignalAdded, (signal: actions.SignalInContext) => {
      const lastAction = this._recordedActions.findLast(a => a.frame.pageGuid === signal.frame.pageGuid);
      if (lastAction)
        lastAction.action.signals.push(signal.signal);
      this._regenerate();
    });
    recorder.on(RecorderEvent.ModeChanged, (mode: Mode) => {
      this.setMode(mode).catch(() => {});
    });
    recorder.on(RecorderEvent.ElementPicked, (elementInfo: ElementInfo, userGesture?: boolean) => {
      this.elementPicked(elementInfo, userGesture).catch(() => {});
    });
    recorder.on(RecorderEvent.CallLogsUpdated, (callLogs: CallLog[]) => {
      this.updateCallLogs(callLogs).catch(() => {});
    });
  }

  // Renders the recorded actions through the playwright-test generator so the
  // "eject to code" path keeps working, then runs the BrowserStep mapping.
  private _regenerate() {
    const collapsed = collapseActions(this._recordedActions);
    const options: LanguageGeneratorOptions = {
      browserName: 'chromium',
      launchOptions: {},
      contextOptions: {},
    };
    const sources: Source[] = [];
    for (const languageGenerator of languageSet()) {
      const { header, footer, actionTexts, text } = generateCode(collapsed, languageGenerator, options);
      sources.push({
        isPrimary: languageGenerator.id === 'playwright-test',
        timestamp: 0,
        isRecorded: true,
        label: languageGenerator.name,
        group: languageGenerator.groupName,
        id: languageGenerator.id,
        text,
        header,
        footer,
        actions: actionTexts,
        language: languageGenerator.highlighter,
        highlight: [],
      });
    }
    this.setActions(this._recordedActions, sources).catch(() => {});
  }

  async open(options?: channels.CrxApplicationShowRecorderParams) {
    const mode = options?.mode ?? 'recording';

    if (this._window)
      await this._window.close();

    this._playInIncognito = options?.playInIncognito ?? false;

    this._window = new HeadlessRecorderWindow((msg: RecorderMessage) => {
      this._forwardCallback(msg);
    });
    this._window.onMessage = this._onMessage.bind(this);
    this._window.hideApp = this._hide.bind(this);

    // Initialize recorder state — setOutput is intentionally skipped:
    // the synthetics recorder is headless (no code editor), so calling
    // setOutput would restart() the action collection and destroy the
    // initial openPage step that install() just generated.
    this._recorder.setMode(mode);

    this.emit('show');
    this.setMode(mode);
  }

  async close() {
    if (!this._window || this._window.isClosed())
      return;
    await this._hide();
    this._window = undefined;
  }

  // Awaited, because `setMode('none')` is what rebuilds the steps one last time
  // against the full network buffer. Letting it float means the caller reads the
  // step list before the rebuild lands, which is the same bug it is fixing.
  private async _hide() {
    this._recorder.setMode('none');
    await this.setMode('none');
    this._window?.close();
    this.emit('hide');
  }

  async setPaused(paused: boolean) {
    // eslint-disable-next-line no-console
    console.log('setPausedsetPaused ---', paused);
    this._sendMessage({ type: 'recorder', method: 'setPaused', paused });
  }

  async setMode(mode: Mode) {
    // P4.S.2 — network evidence is collected only while RECORDING. Replay runs
    // incognito on the author's machine, so its timings and its traffic are
    // incomparable to a probe location; letting a replay update settle patterns
    // would quietly overwrite production evidence with laptop evidence.
    if (this._recorder._isRecording()) {
      this._network.enable();
      this._collecting = true;
    } else {
      // One last rebuild before the buffer is thrown away.
      //
      // `setActions` runs when the action collection CHANGES, which is the
      // instant the action is recorded — before the calls it causes have
      // answered. A step that navigates is rescued by the navigation's own
      // `setActions` firing later; a step that only fires an XHR has nothing
      // behind it, so its evidence was computed against a buffer that could not
      // yet contain it and every response arriving afterwards was lost.
      //
      // Recording stops here, so this is the last moment the whole recording is
      // visible. `disable()` clears the buffer, so the order matters.
      if (this._collecting) {
        this._collecting = false;
        await this.setActions(this._recordedActions, this._sources ?? []);
      }
      this._network.disable();
    }

    if (!this._recorder._isRecording())
      this._crx.player.pause().catch(() => {});
    else
      this._crx.player.stop().catch(() => {});

    if (this._mode !== mode) {
      this._mode = mode;
      this.emit('modeChanged', { mode });
    }
    this._sendMessage({ type: 'recorder', method: 'setMode', mode });
  }

  async setRunningFile() {
    // Not applicable — no file-based code editor
  }

  async setSources(sources: Source[]) {
    // eslint-disable-next-line no-console
    console.log('setSources ---', sources);
    sources = sources.filter(s => s.isRecorded);
    this._sources = sources;

    // Forward sources with generated full-test code for "eject to code" path
    const recordedSource = sources.find(s => s.isRecorded);
    const msg: SyntheticsForwardMessage = {
      type: 'recorder',
      method: 'setSources',
      sources,
    };
    if (recordedSource) {
      msg.generatedCode = recordedSource.text;
      msg.generatedLanguage = recordedSource.language;
    }
    this._forwardCallback(msg);
  }

  async elementPicked(elementInfo: ElementInfo, userGesture?: boolean) {
    // eslint-disable-next-line no-console
    console.log('Element Picked ---', elementInfo);
    if (userGesture) {
      if (this._recorder.mode() === 'inspecting')
        this._recorder.setMode('standby');

    }
    this._sendMessage({ type: 'recorder', method: 'elementPicked', elementInfo, userGesture });
  }

  async resetCallLogs() {
    this._sendMessage({ type: 'recorder', method: 'resetCallLogs' });
  }

  async updateCallLogs(callLogs: CallLog[]) {
    this._sendMessage({ type: 'recorder', method: 'updateCallLogs', callLogs });
  }

  /**
   * The origin a recorded request is judged "same-site" against.
   *
   * Taken from the journey's own first navigation rather than from whatever page
   * happens to be focused: that is the site the monitor is about, it is stable
   * for the whole recording, and it needs no per-request frame walking.
   */
  private _journeyOrigin(): string | undefined {
    for (const a of this._recordedActions) {
      if (a.action.name === 'navigate' || a.action.name === 'openPage')
        return a.action.url;
    }
    return undefined;
  }

  async setActions(actions: ActionInContext[], sources: Source[]) {
    // eslint-disable-next-line no-console
    console.log('setActions ---', actions, sources);
    this._recordedActions = Array.from(actions);
    this._sources = Array.from(sources);

    const origin = this._journeyOrigin();

    // Everything observed OUTSIDE every action window is background by
    // definition — nothing the author did was in flight, or the author had
    // stopped waiting for it. Computed once for the whole recording so each
    // step is classified against the same evidence.
    const windows = captureWindows(actions);
    const idleResponses = this._network.outside(windows);
    const windowFor = new Map(actions.map((action, i) => [action, windows[i]]));

    // Map to BrowserStep[] format (no generated code snippets)
    const browserSteps = mapActionsToBrowserSteps(actions, action => {
      const window = windowFor.get(action);
      if (!origin || !window)
        return undefined;
      const responses = this._network.between(window.start, window.end);
      const patterns = buildSettlePatterns(origin, responses, {
        actionStart: action.startTime,
        idleResponses,
      });
      return patterns.length ? patterns : undefined;
    });

    const msg: SyntheticsForwardMessage = {
      type: 'recorder',
      method: 'setActions',
      actions,
      sources,
      browserSteps,
    };
    this._forwardCallback(msg);
  }

  async _run() {
    if (this._crx.player.isPlaying())
      return;
    const incognito = this._playInIncognito;
    if (incognito) {
      const incognitoCrxApp = await this._crx.get({ incognito });
      await incognitoCrxApp?.close({ closeWindows: true });
    }
    const crxApp = await this._crx.get({ incognito }) ?? await this._crx.start({ incognito }, serverSideCallMetadata());
    await this._crx.player.run(crxApp._context, this._recordedActions);
  }

  _sendMessage(msg: RecorderMessage) {
    // eslint-disable-next-line no-console
    console.log('_sendMessage ---', msg);
    return this._window?.postMessage(msg);
  }

  async uninstall(page: Page) {
    await this._recorder._uninstallInjectedRecorder(page);
  }

  private _onMessage({ type, event, params }: RecorderEventData) {
    // eslint-disable-next-line no-console
    console.log('_onMessage ---', type, event, params);
    if (type === 'recorderEvent') {
      switch (event) {
        case 'resume':
        case 'step':
          this._run().catch(() => {});
          break;
        case 'setMode':
          const { mode } = params;
          if (this._mode !== mode) {
            this._mode = mode;
            this.emit('modeChanged', { mode });
          }
          break;
      }
      this.emit('event', { event, params });
    }
  }
}

export type { ForwardCallback } from './headlessRecorderWindow';
