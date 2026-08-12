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
import type { CallLog, ElementInfo, EventData, Mode, Source, SourceHighlight } from '@recorder/recorderTypes';
import { EventEmitter } from 'events';
import type { Page } from 'playwright-core/lib/server/page';
import { Recorder, RecorderEvent } from 'playwright-core/lib/server/recorder';
import type * as channels from '../../protocol/channels';
import type { ActionInContextWithLocation } from './parser';
import { PopupRecorderWindow } from './popupRecorderWindow';
import { SidepanelRecorderWindow } from './sidepanelRecorderWindow';
import type { ActionInContext, ActionWithSelector } from '@isomorphic/codegen/actions';
import type * as actions from '@isomorphic/codegen/actions';
import { parse } from './parser';
import { generateCode } from '@isomorphic/codegen/language';
import { languageSet } from '@isomorphic/codegen/languages';
import { collapseActions, metadataToCallLog } from 'playwright-core/lib/server/recorder/recorderUtils';
import { monotonicTime } from '@isomorphic/time';
import type { CallMetadata } from 'playwright-core/lib/server/instrumentation';
import type { Crx } from '../crx';
import type { LanguageGeneratorOptions } from '@isomorphic/codegen/types';
import { toLanguage, traceParamsForAction } from './recorderUtils';
import { primaryPageGuid } from './actionMapper';

export type RecorderMessage = { type: 'recorder' } & (
  | { method: 'resetCallLogs' }
  | { method: 'updateCallLogs', callLogs: CallLog[] }
  | { method: 'setCallLogs', callLogs: CallLog[] }
  | { method: 'setPaused', paused: boolean }
  | { method: 'setMode', mode: Mode }
  | { method: 'setSources', sources: Source[] }
  | { method: 'setActions', actions: ActionInContext[], sources: Source[] }
  | { method: 'elementPicked', elementInfo: ElementInfo, userGesture?: boolean }
);

// `fileChanged` is what the recorder UI actually dispatches (recorder.tsx), with a
// `fileId` param since 1.54. Upstream's EventData union lists `languageChanged`
// instead — a stale type, not a renamed event — so it is spelled out here.
// `setAutoExpect` is dispatched by the vendored recorder UI (1.55) but is absent from
// upstream's EventData union, which lists only the events the UI had when it was written
// — upstream matches on raw strings, so the union never had to keep up.
export type RecorderEventData =  (EventData | { event: 'resetCallLogs' | 'codeChanged' | 'cursorActivity' | 'fileChanged' | 'setAutoExpect', params: any }) & { type: string };

export interface RecorderWindow {
  isClosed(): boolean;
  postMessage: (msg: RecorderMessage) => void;
  open: () => Promise<void>;
  focus: () => Promise<void>;
  close: () => Promise<void>;
  onMessage?: ({ type, event, params }: RecorderEventData) => void;
  hideApp?: () => any;
}

export class CrxRecorderApp extends EventEmitter {
  readonly wsEndpointForTest: string | undefined;
  private _crx: Crx;
  readonly _recorder: Recorder;
  private _filename?: string;
  // The "Generate assertions" switch, added to the vendored toolbar in 1.55. It drove a
  // `generateAutoExpect` codegen option that 1.62 removed along with the action-level
  // preconditionSelector it depended on, so there is nothing left to honour. Kept as state
  // so the UI event is still accepted rather than falling through as unknown; see the
  // setAutoExpect case below.
  private _generateAutoExpect = false;
  private _sources?: Source[];
  private _recorderSources: Source[] = [];
  private _mode: Mode = 'none';
  private _window?: RecorderWindow;
  private _editedCode?: EditedCode;
  private _recordedActions: ActionInContextWithLocation[] = [];
  private _playInIncognito = false;
  private _currentCursorPosition: { line: number } | undefined;

  constructor(crx: Crx, recorder: Recorder) {
    super();
    this._crx = crx;
    this._recorder = recorder;
    this._crx.player.on('start', () => {
      this.setPaused(false).catch(() => {});
      this._recorder.clearErrors();

      // NB: do NOT clear _replayedActions here. _run() assigns it immediately before
      // calling player.run(), which is what emits 'start' — clearing it made every
      // stepStarted/stepResult lookup miss, so the call log stayed empty.
      this.resetCallLogs().catch(() => {});
    });

    // Replay call logs are built in _run() rather than from the player's step events:
    // stepping executes one action per player.run() call, so the player's per-run
    // actionIndex cannot address the journey as a whole. (SyntheticsRecorderApp still
    // consumes those events directly — it replays whole journeys.)
    // 1.54 reversed the Recorder <-> RecorderApp dependency (microsoft/playwright#36544):
    // the recorder streams events instead of calling into an IRecorderApp, and the app
    // is now responsible for turning actions into code. Everything below replaces what
    // the deleted ContextRecorder/RecorderCollection used to push at us.
    recorder.on(RecorderEvent.ActionAdded, (action: actions.ActionInContext) => {
      this._recordedActions.push(action as ActionInContextWithLocation);
      // New recorded actions supersede hand-edited code; without this the stale
      // EditedCode keeps winning in _getActions() and newly recorded steps vanish.
      if (this._editedCode) {
        this._editedCode.stopLoad();
        this._editedCode = undefined;
      }
      this._generateSources();
    });
    recorder.on(RecorderEvent.SignalAdded, (signal: actions.SignalInContext) => {
      const lastAction = this._recordedActions.findLast(a => a.pageGuid === signal.pageGuid);
      if (lastAction)
        lastAction.action.signals.push(signal.signal);
      this._generateSources();
    });
    recorder.on(RecorderEvent.ModeChanged, (mode: Mode) => {
      this.setMode(mode).catch(() => {});
    });
    recorder.on(RecorderEvent.UserSourcesChanged, (sources: Source[]) => {
      this.setSources([...this._recorderSources, ...sources]).catch(() => {});
    });
    recorder.on(RecorderEvent.CallLogsUpdated, (callLogs: CallLog[]) => {
      this.updateCallLogs(callLogs).catch(() => {});
    });
    recorder.on(RecorderEvent.ElementPicked, (elementInfo: ElementInfo, userGesture?: boolean) => {
      this.elementPicked(elementInfo, userGesture).catch(() => {});
    });
    // Deliberately NOT forwarding RecorderEvent.PausedStateChanged: it reflects the
    // *debugger's* pause state, which crx never uses for replay (the player drives frame
    // calls directly). Forwarding it pinned `paused` to false and left the Resume/Step
    // buttons permanently disabled. crx owns this state — see _setReplayPaused below.
  }

  // The actions handed to the player for the current replay, indexed the same way the
  // player's stepStarted/stepResult actionIndex is, plus the call log built from them.
  private _replayedActions: ActionInContextWithLocation[] = [];
  private _actionIndex = 0;
  private _completedLogs: CallLog[] = [];

  private _highlightSourceLine(line: number | undefined, type: 'error' | 'paused' | 'running' = 'error', message?: string) {
    const decorated = this._recorderSources.map(s => ({
      ...s,
      highlight: line && s.id === (this._filename ?? 'playwright-test') ? [{ line, type, message }] : [],
      revealLine: s.id === (this._filename ?? 'playwright-test') ? line : undefined,
    }));
    this.setSources(decorated).catch(() => {});
  }

  // Built through upstream's own metadataToCallLog so the entries render exactly as the
  // instrumented ones did — same human title ("Set input files"), same params rendering,
  // same duration — rather than a crx-specific approximation.
  private _buildCallLog(action: ActionInContextWithLocation, status: CallLog['status'], startTime: number, error?: string): CallLog {
    const traceParams = traceParamsForAction(action as ActionInContext);
    const metadata: CallMetadata = {
      id: `call@crx-replay-${action.location?.line ?? 0}`,
      internal: false,
      objectId: '',
      pageId: '',
      frameId: '',
      startTime,
      endTime: (status === 'done' || status === 'error') ? monotonicTime() : 0,
      type: 'Frame',
      log: error ? [error] : [],
      location: action.location,
      ...traceParams,
    };
    if (error)
      metadata.error = { error: { name: 'Error', message: error, stack: '' } };
    return metadataToCallLog(metadata, status);
  }

  // Publishes sources from whichever action list is authoritative right now: the
  // hand-edited code when it has parsed cleanly, otherwise what the recorder captured.
  // _recordedActions is kept intact either way — the recorder's actions carry page guids
  // and signals the parser cannot reconstruct.
  private _publishSources() {
    const edited = this._editedCode;
    if (edited && edited.hasLoaded() && !edited.hasErrors()) {
      const recorded = this._recordedActions;
      this._recordedActions = edited.actions();
      this._generateSources();
      this._recordedActions = recorded;
    } else {
      this._generateSources();
    }
  }

  // Code generation moved app-side in 1.54. Mirrors what RecorderCollection +
  // ContextRecorder did together: collapse the action list, then render it through
  // every registered language generator so the UI's language chooser keeps working.
  // Shared by _generateSources and _getActions' line mapping: two renderings of the same
  // actions have to agree, or a highlight lands on the wrong line.
  private _languageGeneratorOptions(): LanguageGeneratorOptions {
    return {
      browserName: 'chromium',
      // headless:false matches what upstream's RecorderApp passes; without it the
      // standalone (non-test-runner) generators emit `launch()` instead of
      // `launch({ headless: false })`, changing the code shown and saved.
      launchOptions: { headless: false },
      contextOptions: {},
    };
  }

  private _generateSources() {
    const collapsed = collapseActions(this._recordedActions);
    const languageGeneratorOptions = this._languageGeneratorOptions();

    const recorderSources: Source[] = [];
    for (const languageGenerator of languageSet()) {
      const { header, footer, actionTexts, text } = generateCode(collapsed, languageGenerator, languageGeneratorOptions);
      recorderSources.push({
        // 1.55 removed `isPrimary` and `timestamp` from Source. They were how the Recorder
        // component chose a file to display when nothing was selected; it now shows only
        // the source last revealed to it (`sourceRevealRequested` since 1.58). The popup
        // owns that choice and pushes it — see crxRecorder.tsx.
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
        revealLine: text.split('\n').length - 1,
      });
    }

    this._recorderSources = recorderSources;
    this._sources = recorderSources;
    // NB: no _updateCode(null) here. Discarding hand-edited code when a *new action* is
    // recorded is handled in the ActionAdded handler; doing it here as well wiped the
    // edited code during the regeneration that an edit itself triggers, so the editor
    // reverted to generated code while the user was typing.
    // Must be setSources, not setActions: the recorder UI only listens for 'setSources'
    // (crxRecorder.tsx), so pushing actions alone left the editor empty.
    this.setSources(recorderSources).catch(() => {});
  }

  async open(options?: channels.CrxApplicationShowRecorderParams) {
    const mode = options?.mode ?? 'none';
    const language = options?.language ?? 'playwright-test';

    if (this._window)
      await this._window.close();

    this._playInIncognito = options?.playInIncognito ?? false;

    this._window = options?.window?.type === 'sidepanel' ? new SidepanelRecorderWindow(options.window.url) : new PopupRecorderWindow(options?.window?.url);
    this._window.onMessage = this._onMessage.bind(this);
    this._window.hideApp  = this._hide.bind(this);

    // set in recorder before, so that if it opens the recorder UI window, it will already reflect the changes
    this._onMessage({ type: 'recorderEvent', event: 'clear', params: {} });
    // 1.54 renamed the recorder-UI event param `file` -> `fileId`.
    this._onMessage({ type: 'recorderEvent', event: 'fileChanged', params: { fileId: language } });
    // 1.54: setOutput(codegenId, file) -> setLanguage(highlighterLanguage).
    this._recorder.setLanguage(toLanguage(language));
    this._recorder.setMode(mode);

    // Seed the opening navigation: the recorder's own `openPage` for already-open pages is
    // emitted while installing, before setMode() enables ActionAdded, so it is dropped.
    // clear() re-signals navigation for every open page. See syntheticsRecorderApp.open().
    if (this._recorder._isRecording())
      this._recorder.clear();

    if (this._window.isClosed()) {
      await this._window.open();
      this.emit('show');
    } else {
      await this._window.focus();
    }

    this.setMode(mode);

    // Publish the initial sources — AFTER the window is open, because postMessage is a
    // no-op until the port exists (popupRecorderWindow), so anything sent earlier is
    // silently dropped. Until 1.54 the recorder pushed recorder-generated sources while
    // installing the app; now that the app owns code generation, nothing would reach the
    // UI until the first action was recorded, leaving the editor and the language
    // chooser empty.
    this._generateSources();
  }

  load(code: string) {
    this._updateCode(code);
    this._editedCode?.load();
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
    this._sendMessage({ type: 'recorder', method: 'setPaused',  paused });
  }

  async setMode(mode: Mode) {
    if (!this._recorder._isRecording()) {
      this._crx.player.pause().catch(() => {});
      // Leaving a recording mode means the journey is ready to replay, so the UI must
      // offer Resume/Step. Until 1.54 this fell out of the player's 'pause' action being
      // routed through instrumentation into the debugger's paused state; the player now
      // drives frame calls directly, so nothing would ever enable those buttons.
      this.setPaused(true).catch(() => {});
    } else {
      this._crx.player.stop().catch(() => {});
      this.setPaused(false).catch(() => {});
    }

    if (this._mode !== mode) {
      this._mode = mode;
      this.emit('modeChanged', { mode });
    }
    this._sendMessage({ type: 'recorder', method: 'setMode', mode });
  }

  async setRunningFile() {
    // this doesn't make sense in crx, it only runs recorded files
  }

  async setSources(sources: Source[]) {
    sources = sources
    // hack to prevent recorder from opening files
        .filter(s => s.isRecorded)
        .map(s => this._editedCode?.decorate(s) ?? s);
    this._sendMessage({ type: 'recorder', method: 'setSources', sources });
  }

  async elementPicked(elementInfo: ElementInfo, userGesture?: boolean) {
    if (userGesture) {
      if (this._recorder.mode() === 'inspecting') {
        this._recorder.setMode('standby');
        this._window?.focus();
      }
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
    this._recordedActions = Array.from(actions);
    this._sources = Array.from(sources);
    if (this._recorder._isRecording())
      this._updateCode(null);
  }

  private _updateCode(code: string | null) {
    if (this._editedCode?.code === code)
      return;

    this._editedCode?.stopLoad();
    this._editedCode = undefined;

    if (!code)
      return;

    this._editedCode = new EditedCode(this._recorder, code, () => {
      this._updateLocator(this._currentCursorPosition);
      // Until 1.54 the recorder owned this: loadScript() handed it the parsed actions
      // and the edited text, and it re-published the sources. It no longer has either,
      // so regenerating the *other* languages from the edited code — and re-publishing
      // so error highlights reach the editor — is the app's job now.
      this._publishSources();
    });
  }

  private async _updateLocator(position?: { line: number}) {
    if (!position)
      return;

    // codemirror line is 0-based while action line is 1-based
    const action = this._getActions(true).find(a => a.location?.line === position.line + 1);
    if (!action || !(action.action as ActionWithSelector).selector)
      return;
    const selector = (action.action as ActionWithSelector).selector;
    this.elementPicked({ selector, ariaSnapshot: '' }, false);
    this._onMessage({ type: 'recorderEvent', event: 'highlightRequested', params: { selector } });
  }

  private _onMessage({ type, event, params }: RecorderEventData) {
    if (type === 'recorderEvent') {
      switch (event) {
        case 'fileChanged':
          this._filename = params.fileId;
          this._recorder.setLanguage(toLanguage(params.fileId));
          // The chosen language decides which source the highlight and revealLine attach
          // to, so the sources have to be rebuilt — the recorder used to do this when it
          // owned them.
          this._publishSources();
          if (this._editedCode?.hasErrors()) {
            this._updateCode(null);
            // force editor sources to refresh
            if (this._sources)
              this.setSources(this._sources);
          }
          break;
        case 'setAutoExpect':
          this._generateAutoExpect = !!params.autoExpect;
          this._publishSources();
          break;
        case 'codeChanged':
          this._updateCode(params.code);
          break;
        case 'cursorActivity':
          this._currentCursorPosition = params.position;
          this._updateLocator(this._currentCursorPosition);
          break;
        case 'resume':
          this._run(false).catch(() => {});
          break;
        case 'step':
          this._run(true).catch(() => {});
          break;
        case 'highlightRequested':
          // Until 1.54 the Recorder subscribed to this app's 'event' emission and did
          // this itself (recorder.ts `_install`). The dependency was reversed, so the
          // app has to drive the recorder now — see the setMode case below.
          if (params.selector)
            this._recorder.setHighlightedSelector(params.selector);
          if (params.ariaTemplate)
            this._recorder.setHighlightedAriaTemplate(params.ariaTemplate);
          break;
        case 'setMode':
          const { mode } = params;
          // Drive the recorder. Without this the recorder UI's Record/Inspect/Assert
          // buttons change nothing: in 1.53 the Recorder listened to this event
          // (recorder.ts:104) and called setMode on itself; 1.54 deleted that listener
          // along with the IRecorderApp interface.
          //
          // The recorder emits ModeChanged back, which lands in our own subscription
          // and calls this.setMode() — so the local state update below is kept only
          // for the case where the recorder is already in that mode and stays silent.
          this._recorder.setMode(mode);
          if (this._mode !== mode) {
            this._mode = mode;
            this.emit('modeChanged', { mode });
          }
          break;
      }

      this.emit('event', { event, params });
    }
  }

  async _run(step: boolean) {
    if (this._crx.player.isPlaying())
      return;
    const incognito = this._playInIncognito;
    if (incognito) {
      const incognitoCrxApp = await this._crx.get({ incognito });
      await incognitoCrxApp?.close({ closeWindows: true });
    }
    const crxApp = await this._crx.get({ incognito }) ?? await this._crx.start({ incognito });

    // The player skips a leading openPage for the 'page' alias, so index the same list
    // it iterates or the call-log entries would point at the wrong action.
    const actionsForRun = this._getActions();
    const primaryGuid = primaryPageGuid(actionsForRun);
    const all = actionsForRun.filter(a => !(a.action.name === 'openPage' && a.pageGuid === primaryGuid));
    this._replayedActions = all;

    // Until 1.54 stepping was the debugger's job: recorder.step() resumed it for a single
    // statement and the player's calls paused on the next one. The player now drives frame
    // calls directly and the debugger never sees them, so the step cursor lives here.
    // Start a fresh replay unless we are mid-step: a Resume pressed while stepping must
    // continue from the paused action, not re-run the journey from the top (re-running
    // the navigation would undo whatever the user changed on the page before resuming).
    const hasError = this._completedLogs.some(l => l.status === 'error');
    const allDone = this._completedLogs.length >= all.length;
    const midStep = this._actionIndex > 0 && !allDone && !hasError;
    if (!midStep) {
      this._actionIndex = 0;
      this._completedLogs = [];
      this._crx.player.resetPageAliases();
      this.resetCallLogs().catch(() => {});
      this._highlightSourceLine(undefined);
    }

    const runOne = async (action: ActionInContextWithLocation) => {
      const startTime = monotonicTime();
      try {
        // The journey's primary page, not this step's — see CrxPlayer.run.
        await this._crx.player.run(crxApp._context, [action], primaryGuid);
        this._completedLogs.push(this._buildCallLog(action, 'done', startTime));
        return true;
      } catch (e) {
        const message = (e as Error).message;
        this._completedLogs.push(this._buildCallLog(action, 'error', startTime, message));
        if (action.location?.line)
          this._highlightSourceLine(action.location.line, 'error', message);
        return false;
      }
    };

    if (step) {
      // First press pauses on the first action; each later press executes the action it
      // was paused on and pauses on the next.
      let ok = true;
      if (this._actionIndex > 0)
        ok = await runOne(all[this._actionIndex - 1]);
      const paused = ok ? all[this._actionIndex] : undefined;
      if (paused) {
        this._actionIndex++;
        if (paused.location?.line)
          this._highlightSourceLine(paused.location.line, 'paused');
        this._pushCallLogs(paused);
      } else {
        this._pushCallLogs();
        this._highlightSourceLine(undefined);
      }
      this.setPaused(!!paused).catch(() => {});
    } else {
      // Resume: finish whatever the step cursor is paused on, then run to the end.
      const from = this._actionIndex > 0 ? this._actionIndex - 1 : 0;
      for (let i = from; i < all.length; i++) {
        this._pushCallLogs(all[i], 'in-progress');
        if (!await runOne(all[i]))
          break;
        this._pushCallLogs();
      }
      this._actionIndex = all.length;
      this._pushCallLogs();
      this.setPaused(!this._recorder._isRecording()).catch(() => {});
    }
  }

  // Sends the completed entries, optionally followed by the action the cursor sits on.
  private _pushCallLogs(pending?: ActionInContextWithLocation, status: CallLog['status'] = 'paused') {
    const logs = [...this._completedLogs];
    if (pending)
      logs.push(this._buildCallLog(pending, status, monotonicTime()));
    this._sendMessage({ type: 'recorder', method: 'setCallLogs', callLogs: logs });
  }

  _sendMessage(msg: RecorderMessage) {
    return this._window?.postMessage(msg);
  }

  async uninstall(page: Page) {
    await this._recorder._uninstallInjectedRecorder(page);
  }

  private _getActions(skipLoad = false): ActionInContextWithLocation[] {
    if (this._editedCode && !skipLoad) {
      // this will indirectly refresh sources
      this._editedCode.load();
      const actions = this._editedCode.actions();

      if (!this._filename || this._filename === 'playwright-test')
        return actions;
    }

    // Prefer the app-generated sources: since 1.54 they are the authoritative
    // rendering of the recorded actions, while `_sources` also carries user sources.
    const source = this._recorderSources.find(s => s.id === this._filename) ?? this._sources?.find(s => s.id === this._filename);
    if (!source)
      return [];

    const actions = this._editedCode?.hasLoaded() && !this._editedCode.hasErrors() ? this._editedCode.actions() : this._recordedActions;

    const { header } = source;
    const languageGenerator = [...languageSet()].find(l => l.id === this._filename)!;
    // we generate actions here to have a one-to-one mapping between actions and text
    // (source actions are filtered, only non-empty actions are included)
    // 1.62 gave generateAction the generator options as a second argument. These have to
    // match what _generateSources() used, or the line numbers this maps back to would
    // describe a different rendering of the same actions.
    const actionTexts = actions.map(a => languageGenerator.generateAction(a, this._languageGeneratorOptions()));

    const sourceLine = (index: number) => {
      const numLines = (str?: string) => str ? str.split(/\r?\n/).length : 0;
      return numLines(header) + numLines(actionTexts.slice(0, index).filter(Boolean).join('\n')) + 1;
    };

    return actions.map((action, index) => ({
      ...action,
      location: {
        file: this._filename!,
        line: sourceLine(index),
        column: 1
      }
    }));
  }
}

class EditedCode {
  readonly code: string;
  private _recorder: Recorder;
  private _actions: ActionInContextWithLocation[] = [];
  private _highlight: SourceHighlight[] = [];
  private _codeLoadDebounceTimeout: NodeJS.Timeout | undefined;
  private _onLoaded?: () => any;

  constructor(recorder: Recorder, code: string, onLoaded?: () => any) {
    this.code = code;
    this._recorder = recorder;
    this._onLoaded = onLoaded;
    this._codeLoadDebounceTimeout = setTimeout(this.load.bind(this), 500);
  }

  actions() {
    return Array.from(this._actions);
  }

  hasErrors() {
    return this._highlight?.length > 0;
  }

  hasLoaded() {
    return !this._codeLoadDebounceTimeout;
  }

  decorate(source: Source) {
    if (source.id !== 'playwright-test')
      return;

    return {
      ...source,
      highlight: this.hasLoaded() && this.hasErrors() ? this._highlight : source.highlight,
      text: this.code,
    };
  }

  stopLoad() {
    clearTimeout(this._codeLoadDebounceTimeout);
    this._codeLoadDebounceTimeout = undefined;
  }

  load() {
    if (this.hasLoaded())
      return;

    this.stopLoad();
    try {
      const [{ actions }] = parse(this.code);
      this._actions = actions;
      this._highlight = [];
    } catch (error) {
      this._actions = [];
      // syntax error / parsing error
      const line = error.loc.line ?? error.loc.start.line ?? this.code.split('\n').length;
      this._highlight = [{ line, type: 'error', message: error.message }];
    }

    // 1.54 removed `Recorder.loadScript()` — sources are owned by the recorder app
    // now, so the parsed result is surfaced through `decorate()` on the app's own
    // sources rather than pushed back into the recorder.
    this._onLoaded?.();
  }
}
