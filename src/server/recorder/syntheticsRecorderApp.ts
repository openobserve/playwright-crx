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
import type { Recorder } from 'playwright-core/lib/server/recorder';
import type { IRecorderApp } from 'playwright-core/lib/server/recorder/recorderFrontend';
import type { ActionInContext } from '@recorder/actions';
import type * as channels from '../../protocol/channels';
import type { Crx } from '../crx';
import { HeadlessRecorderWindow } from './headlessRecorderWindow';
import type { RecorderEventData, RecorderMessage, RecorderWindow } from './crxRecorderApp';
import { mapActionsToBrowserSteps } from './actionMapper';
import type { BrowserStep } from './actionMapper';
import { serverSideCallMetadata } from 'playwright-core/lib/server';

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

export class SyntheticsRecorderApp extends EventEmitter implements IRecorderApp {
  readonly wsEndpointForTest: string | undefined;
  readonly _recorder: Recorder;
  private _crx: Crx;
  private _mode: Mode = 'none';
  private _window?: RecorderWindow;
  private _recordedActions: ActionInContext[] = [];
  private _sources?: Source[];
  private _forwardCallback: SyntheticsForwardCallback;
  private _playInIncognito = false;

  constructor(crx: Crx, recorder: Recorder, forwardCallback: SyntheticsForwardCallback) {
    super();
    this._crx = crx;
    this._recorder = recorder;
    this._forwardCallback = forwardCallback;
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
    this._hide();
    this._window = undefined;
  }

  private _hide() {
    this._recorder.setMode('none');
    this.setMode('none');
    this._window?.close();
    this.emit('hide');
  }

  async setPaused(paused: boolean) {
    // eslint-disable-next-line no-console
    console.log('setPausedsetPaused ---', paused);
    this._sendMessage({ type: 'recorder', method: 'setPaused', paused });
  }

  async setMode(mode: Mode) {
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

  async setActions(actions: ActionInContext[], sources: Source[]) {
    // eslint-disable-next-line no-console
    console.log('setActions ---', actions, sources);
    this._recordedActions = Array.from(actions);
    this._sources = Array.from(sources);

    // Map to BrowserStep[] format (no generated code snippets)
    const browserSteps = mapActionsToBrowserSteps(actions);

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
