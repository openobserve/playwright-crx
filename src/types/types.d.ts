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

import { Page, BrowserContext } from '../../playwright/packages/playwright-core/types/types';
import { IFs } from 'memfs';
export * from '../../playwright/packages/playwright-core/types/types';

export type CrxFs = IFs;

export type CrxBrowserContextOptions = {
  // 'no-override' is upstream's fourth value. It was missing here, which made a parsed
  // test carrying it unassignable to the type meant to describe it.
  colorScheme?: 'dark' | 'light' | 'no-preference' | 'no-override';
  locale?: string;
  timezoneId?: string;
  geolocation?: {
    latitude: number;
    longitude: number;
  };
  viewport?: {
    width: number;
    height: number;
  };
  permissions?: string[];
  serviceWorkers?: 'allow' | 'block'; 
};

/**
 * The context options a *parsed test* can carry.
 *
 * A superset of CrxBrowserContextOptions, and deliberately a separate type: `crx.start()`
 * takes what an embedder may ask for, while `list()` reports what was found in code. A
 * parsed test can name a storage state or a HAR to route from — `recordHar` is declared
 * here rather than picked from upstream because 1.54 removed it from the protocol's
 * BrowserNewContextOptions while the parser still recognises `routeFromHAR(...)`.
 *
 * They were previously conflated, so `list()` returned storageState and recordHar through
 * a type that said neither existed.
 */
export type CrxTestContextOptions = CrxBrowserContextOptions & {
  storageState?: string;
  recordHar?: {
    path: string;
    content?: 'embed' | 'attach' | 'omit';
    mode?: 'full' | 'minimal';
    urlGlob?: string;
  };
};

export type CrxTestOptions = {
  deviceName?: string;
  contextOptions?: CrxTestContextOptions;
};

export interface Crx {
  
  /**
   * unionfs filesystem
   */
  readonly fs: CrxFs;

  /**
   * @param options
   */
  start(options?: {
    /**
     * Slows down Playwright operations by the specified amount of milliseconds. Useful so that you can see what is going
     * on.
     */
    slowMo?: number;

    /**
     * Starts an incognito mode application.
     */
    incognito?: boolean;

    /**
     * Attach to exactly this tab instead of searching for an active incognito tab.
     * Callers that already opened their own window should always pass this — the
     * search picks whichever incognito window Chrome lists first, which is the
     * user's own window when they already had one open.
     */
    tabId?: number;

    deviceName?: string;

    contextOptions?: CrxBrowserContextOptions;
  }): Promise<CrxApplication>;

  get(options?: {
    incognito?: boolean;
  }): Promise<CrxApplication | undefined>;
}

export interface CrxApplication {
  /**
   * Emitted when a page is attached.
   */
  on(event: 'attached', listener: (data: {
    /**
     * attached page
     */
    page: Page;

    /**
     * page tab ID
     */
    tabId: number;
  }) => void): this;

  /**
   * Emitted when a page is detached.
   */
  on(event: 'detached', listener: (number: number) => void): this;

  /**
   * Adds an event listener that will be automatically removed after it is triggered once. See `addListener` for more information about this event.
   */
  once(event: 'attached', listener: (data: {
    /**
     * attached page
     */
    page: Page;

    /**
     * page tab ID
     */
    tabId: number;
  }) => void): this;

  /**
   * Adds an event listener that will be automatically removed after it is triggered once. See `addListener` for more information about this event.
   */
  once(event: 'detached', listener: (number: number) => void): this;

  /**
   * Emitted when a page is attached.
   */
  addListener(event: 'attached', listener: (data: {
    /**
     * attached page
     */
    page: Page;

    /**
     * page tab ID
     */
    tabId: number;
  }) => void): this;

  /**
   * Emitted when a page is detached.
   */
  addListener(event: 'detached', listener: (number: number) => void): this;

  /**
   * Removes an event listener added by `on` or `addListener`.
   */
  removeListener(event: 'attached', listener: (data: {
    /**
     * attached page
     */
    page: Page;

    /**
     * page tab ID
     */
    tabId: number;
  }) => void): this;

  /**
   * Removes an event listener added by `on` or `addListener`.
   */
  removeListener(event: 'detached', listener: (number: number) => void): this;

  /**
   * Removes an event listener added by `on` or `addListener`.
   */
  off(event: 'attached', listener: (data: {
    /**
     * attached page
     */
    page: Page;

    /**
     * page tab ID
     */
    tabId: number;
  }) => void): this;

  /**
   * Removes an event listener added by `on` or `addListener`.
   */
  off(event: 'detached', listener: (number: number) => void): this;

  /**
   * Emitted when a page is attached.
   */
  prependListener(event: 'attached', listener: (data: {
    /**
     * attached page
     */
    page: Page;

    /**
     * page tab ID
     */
    tabId: number;
  }) => void): this;

  /**
   * Emitted when a page is detached.
   */
  prependListener(event: 'detached', listener: (number: number) => void): this;

  /**
   * Attach a tab and returns the corresponding `Page`.
   * @param tabId
   */
  attach(tabId: number): Promise<Page>;

  /**
   * @param options
   */
  attachAll(options?: {
    /**
     * Optional. Whether the tabs are active in their windows.
     */
    active?: null|boolean;

    /**
     * Optional. Whether the tabs are audible. @since Chrome 45.
     */
    audible?: null|boolean;

    /**
     * Optional. Whether the tabs can be discarded automatically by the browser when resources are low. @since Chrome 54.
     */
    autoDiscardable?: null|boolean;

    /**
     * Optional. Whether the tabs are in the current window. @since Chrome 19.
     */
    currentWindow?: null|boolean;

    /**
     * Optional. Whether the tabs are discarded. A discarded tab is one whose content has been unloaded from memory, but
     * is still visible in the tab strip. Its content gets reloaded the next time it's activated. @since Chrome 54.
     */
    discarded?: null|boolean;

    /**
     * Optional. The ID of the group that the tabs are in, or chrome.tabGroups.TAB_GROUP_ID_NONE for ungrouped tabs.
     * @since Chrome 88
     */
    groupId?: null|number;

    /**
     * Optional. Whether the tabs are highlighted.
     */
    highlighted?: null|boolean;

    /**
     * Optional. The position of the tabs within their windows. @since Chrome 18.
     */
    index?: null|number;

    /**
     * Optional. Whether the tabs are in the last focused window. @since Chrome 19.
     */
    lastFocusedWindow?: null|boolean;

    /**
     * Optional. Whether the tabs are muted. @since Chrome 45.
     */
    muted?: null|boolean;

    /**
     * Optional. Whether the tabs are pinned.
     */
    pinned?: null|boolean;

    /**
     * Optional. Whether the tabs have completed loading. One of: "loading", or "complete"
     */
    status?: null|"loading"|"complete"|"serial";

    /**
     * Optional. Match page titles against a pattern.
     */
    title?: null|string;

    /**
     * Optional. Match tabs against one or more URL patterns. Note that fragment identifiers are not matched.
     */
    url?: null|string|Array<string>;

    /**
     * Optional. The ID of the parent window, or `windows.WINDOW_ID_CURRENT` for the current window.
     */
    windowId?: null|number;

    /**
     * Optional. The type of window the tabs are in. One of: "normal", "popup", "panel", "app", or "devtools"
     */
    windowType?: null|"normal"|"popup"|"panel"|"app"|"devtools";
  }): Promise<Array<Page>>;

  /**
   * Detaches all pages and closes.
   */
  close(): Promise<void>;

  /**
   * This method returns browser context that can be used for setting up context-wide routing, etc.
   */
  context(): BrowserContext;

  /**
   * @param tabIdOrPage
   */
  detach(tabIdOrPage: number|Page): Promise<void>;

  /**
   * Detaches all pages.
   */
  detachAll(): Promise<void>;

  /**
   * Creates a chrome tab using
   * [chrome.tabs.create(createProperties)](https://developer.chrome.com/docs/extensions/reference/tabs/#method-create)
   * and attaches it.
   * @param options
   */
  newPage(options?: {
    /**
     * Optional. Whether the tab should become the active tab in the window. Does not affect whether the window is focused
     * (see windows.update). Defaults to true. @since Chrome 16.
     */
    active?: null|boolean;

    /**
     * Optional. The position the tab should take in the window. The provided value will be clamped to between zero and
     * the number of tabs in the window.
     */
    index?: null|number;

    /**
     * Optional. The ID of the tab that opened this tab. If specified, the opener tab must be in the same window as the
     * newly created tab. @since Chrome 18.
     */
    openerTabId?: null|number;

    /**
     * Optional. Whether the tab should be pinned. Defaults to false @since Chrome 9.
     */
    pinned?: null|boolean;

    /**
     * Optional. Whether the tab should become the selected tab in the window. Defaults to true @deprecated since Chrome
     * 33. Please use active.
     */
    selected?: null|boolean;

    /**
     * Optional. The URL to navigate the tab to initially. Fully-qualified URLs must include a scheme (i.e.
     * 'http://www.google.com', not 'www.google.com'). Relative URLs will be relative to the current page within the
     * extension. Defaults to the New Tab Page.
     */
    url?: null|string;

    /**
     * Optional. The window to create the new tab in. Defaults to the current window.
     */
    windowId?: null|number;
  }): Promise<Page>;

  /**
   * Convenience method that returns all the attached pages.
   */
  pages(): Array<Page>;

  recorder: CrxRecorder;
}

export interface CrxRecorder {
  /**
   * Emitted when recorder is hidden.
   */
  on(event: 'hide', listener: (crxRecorder: CrxRecorder) => void): this;

  /**
   * Emitted when recorder is shown.
   */
  on(event: 'show', listener: (crxRecorder: CrxRecorder) => void): this;

  /**
   * Emitted when recorder mode changes.
   */
  on(event: 'modechanged', listener: (data: {
    /**
     * mode
     */
    mode: "none"|"recording"|"inspecting"|"assertingText"|"recording-inspecting"|"standby"|"assertingVisibility"|"assertingValue"|"assertingSnapshot";
  }) => void): this;

  /**
   * Adds an event listener that will be automatically removed after it is triggered once. See `addListener` for more information about this event.
   */
  once(event: 'hide', listener: (crxRecorder: CrxRecorder) => void): this;

  /**
   * Adds an event listener that will be automatically removed after it is triggered once. See `addListener` for more information about this event.
   */
  once(event: 'show', listener: (crxRecorder: CrxRecorder) => void): this;

  /**
   * Adds an event listener that will be automatically removed after it is triggered once. See `addListener` for more information about this event.
   */
  once(event: 'modechanged', listener: (data: {
    /**
     * mode
     */
    mode: "none"|"recording"|"inspecting"|"assertingText"|"recording-inspecting"|"standby"|"assertingVisibility"|"assertingValue"|"assertingSnapshot";
  }) => void): this;

  /**
   * Emitted when recorder is hidden.
   */
  addListener(event: 'hide', listener: (crxRecorder: CrxRecorder) => void): this;

  /**
   * Emitted when recorder is shown.
   */
  addListener(event: 'show', listener: (crxRecorder: CrxRecorder) => void): this;

  /**
   * Emitted when recorder mode changes.
   */
    addListener(event: 'modechanged', listener: (data: {
      /**
       * mode
       */
      mode: "none"|"recording"|"inspecting"|"assertingText"|"recording-inspecting"|"standby"|"assertingVisibility"|"assertingValue"|"assertingSnapshot";
    }) => void): this;

  /**
   * Removes an event listener added by `on` or `addListener`.
   */
  removeListener(event: 'hide', listener: (crxRecorder: CrxRecorder) => void): this;

  /**
   * Removes an event listener added by `on` or `addListener`.
   */
  removeListener(event: 'show', listener: (crxRecorder: CrxRecorder) => void): this;

  /**
   * Removes an event listener added by `on` or `addListener`.
   */
  removeListener(event: 'modechanged', listener: (data: {
    /**
     * mode
     */
    mode: "none"|"recording"|"inspecting"|"assertingText"|"recording-inspecting"|"standby"|"assertingVisibility"|"assertingValue"|"assertingSnapshot";
  }) => void): this;

  /**
   * Removes an event listener added by `on` or `addListener`.
   */
  off(event: 'hide', listener: (crxRecorder: CrxRecorder) => void): this;

  /**
   * Removes an event listener added by `on` or `addListener`.
   */
  off(event: 'show', listener: (crxRecorder: CrxRecorder) => void): this;

  /**
   * Removes an event listener added by `on` or `addListener`.
   */
  off(event: 'modechanged', listener: (data: {
    /**
     * mode
     */
    mode: "none"|"recording"|"inspecting"|"assertingText"|"recording-inspecting"|"standby"|"assertingVisibility"|"assertingValue"|"assertingSnapshot";
  }) => void): this;

  /**
   * Emitted when recorder is hidden.
   */
  prependListener(event: 'hide', listener: (crxRecorder: CrxRecorder) => void): this;

  /**
   * Emitted when recorder is shown.
   */
  prependListener(event: 'show', listener: (crxRecorder: CrxRecorder) => void): this;

  /**
   * Emitted when recorder mode changes.
   */
  prependListener(event: 'modechanged', listener: (data: {
    /**
     * mode
     */
    mode: "none"|"recording"|"inspecting"|"assertingText"|"recording-inspecting"|"standby"|"assertingVisibility"|"assertingValue"|"assertingSnapshot";
  }) => void): this;

  hide(): Promise<void>;

  isHidden(): boolean;

  /**
   * @param options
   */
  show(options?: {
    language?: null|string;

    mode?: null|"none"|"recording"|"inspecting"|"assertingText"|"recording-inspecting"|"standby"|"assertingVisibility"|"assertingValue"|"assertingSnapshot";

    testIdAttributeName?: null|string;

    playInIncognito?: null|boolean;

    window?: {
      type?: null|"popup"|"sidepanel";
      
      url?: null|string;
    };
  }): Promise<void>;

  mode(): "none"|"recording"|"inspecting"|"assertingText"|"recording-inspecting"|"standby"|"assertingVisibility"|"assertingValue"|"assertingSnapshot";

  setMode(mode: "none"|"recording"|"inspecting"|"assertingText"|"recording-inspecting"|"standby"|"assertingVisibility"|"assertingValue"|"assertingSnapshot"): Promise<void>;

  list(code: string): Promise<{
    title: string,
    options?: CrxTestOptions;
    location?: {
      file: string,
      line?: number,
      column?: number,
    },
  }[]>;

  load(code: string): Promise<void>;

  run(code: string, page?: Page): Promise<void>;

  runActions(actions: any[]): Promise<void>;

  stop(): Promise<void>;
}

// ─── Synthetics recorder surface ────────────────────────────────────────────
//
// These are exported by src/index.ts at runtime and, until Phase 4, had no
// declarations at all — so the synthetics-recorder extension imported ten symbols
// that TypeScript believed did not exist, and its build said nothing because it never
// ran tsc. It does now.
//
// The shapes here are curated rather than emitted: the implementations reach into
// playwright-core's server internals (Recorder, BrowserContext, SdkObject) and those
// paths have no business in a published surface. What crosses the boundary as *data* —
// everything O2 stores or reads — is declared exactly, and checked against the
// implementation by src/types/conformance.ts so it cannot drift again. What crosses only
// as an opaque handle is declared opaque on purpose.

import type { ActionInContext } from '@isomorphic/codegen/actions';
import type { CallLog, ElementInfo, Mode, Source } from '@recorder/recorderTypes';

// ── Opaque handles ──
// Supplied by the recorder-app factory and passed straight back to the app's
// constructor. Deliberately not structural: an embedder should be able to carry one
// across, and nothing else.

/** The server-side Crx object. */
export interface CrxServer {}
/** The server-side Recorder driving a session. */
export interface RecorderServer {}
/** The server-side BrowserContext a session is recording. */
export interface BrowserContextServer {}

// ── Locators ──

export type LocatorKind = 'test_attribute' | 'role' | 'text' | 'css' | 'xpath';

/** How one part of a combined locator attaches to the part before it. */
export type CompositeRelation = 'and' | 'has' | 'has_not' | 'descendant';

export type CompositePart = {
  value: string;
  /** Absent on the first (base) part. */
  relation?: CompositeRelation;
};

export type LocatorCandidate = {
  kind: LocatorKind;
  value: string;
  /**
   * Where it came from. The recorder only ever writes `recorded`; the editor writes the
   * other two. It is the heal-suppression signal — healing may replace a recorded value
   * in place and must not touch anything else.
   */
  origin?: 'recorded' | 'authored' | 'composite';
  /** What a combined locator was built from. Editor-written, never recorded. */
  from?: CompositePart[];
};

export type StepLocator = {
  candidates: LocatorCandidate[];
  /**
   * A human has reordered, added, deleted or combined. The recorder never sets it; a
   * fresh recording is by definition not author-ordered.
   */
  author_ordered?: boolean;
};

// ── Steps ──

export type BrowserStepAction = 'navigate' | 'openPage' | 'click' | 'hover' | 'type' | 'press' | 'select' | 'check' | 'uncheck' | 'setInputFiles' | 'waitFor' | 'assert' | 'screenshot';

/**
 * The stored spellings that only ever arrive, never leave. A journey saved and reloaded
 * comes back in the version-2 vocabulary, where `fill` names `type` and `upload` names
 * `setInputFiles`.
 */
export type StoredStepAction = 'fill' | 'upload';

/** The v2 assertion vocabulary, mirrored from the server-side closed set. */
export type AssertionKind = 'element_visible' | 'element_not_visible' | 'element_text' | 'url_matches' | 'page_title' | 'element_attribute';

export interface StepAssertion {
  kind: AssertionKind;
  expected?: string;
  attribute?: string;
}

export type SettleResponsePattern = {
  url_pattern: string;
  /** Always false from the recorder — a recording cannot observe that a call is required. */
  required: boolean;
  method?: string;
};

/**
 * What the page demonstrably did after this step's action.
 *
 * Recorded as evidence, not as a contract: a signal that stops arriving annotates the
 * step rather than failing the run, which is what lets a recorded journey outlive the
 * endpoint names it was recorded against.
 */
export interface StepSettle {
  navigation?: { url_pattern: string };
  responses?: SettleResponsePattern[];
  /** How long settling took while recording. Reporting only — never a timeout. */
  observed_duration_ms?: number;
}

export interface BrowserStep {
  id: string;
  action: BrowserStepAction | StoredStepAction;
  /**
   * Every way the recorder could find this element. This IS the step's identity: the
   * bare `selector`/`selector_type` pair beside it was the version-1 channel and went
   * with version 1.
   */
  locator?: StepLocator;
  settle?: StepSettle;
  assertion?: StepAssertion;
  /**
   * Author-set flow control. Never emitted by the recorder — they come back from the
   * step editor on replay, and the player reports that it cannot honour them rather
   * than diverging silently.
   */
  optional?: boolean;
  always_run?: boolean;
  name: string;
  /**
   * Absent by design. The recorder must never stamp a timeout — a recorded value encodes
   * the recording session's timing, not the application's contract. The runner owns
   * defaults per action category; an author may still set one in the step editor.
   */
  timeout_ms?: number;
  url?: string;
  value?: string;
  key?: string;
  options?: string[];
  text?: string;
  checked?: boolean;
  snapshot?: string;
  files?: string[];
  modifiers?: number;
  button?: 'left' | 'middle' | 'right';
  position?: { x: number, y: number };
  startTime: number;
  endTime?: number;
  pageAlias: string;
  framePath: string[];
  description?: string;
}

// ── Replay fidelity ──

export type FidelityLevel = 'exact' | 'approximate' | 'not_simulated';

export type StepFidelity = {
  /** Aligned with the player's `actionIndex`. */
  stepIndex: number;
  stepId: string;
  level: FidelityLevel;
  notes: string[];
};

/** Fidelity for a whole journey, one entry per step, in replay order. */
export function describeReplayFidelity(steps: BrowserStep[]): StepFidelity[];
/** One step's fidelity, so a single step can be reasoned about without a journey. */
export function describeStepFidelity(step: BrowserStep, stepIndex: number): StepFidelity;
/** Only the steps with something to say — what a UI actually renders. */
export function replayFidelityWarnings(steps: BrowserStep[]): StepFidelity[];

// ── Replay progress and errors ──

export type StructuredError = {
  message: string;
  name?: string;
  stack?: string;
  /** The action that failed, e.g. "click", "fill", "navigate". */
  actionName?: string;
  /** The selector targeted by the failing action, if applicable. */
  selector?: string;
};

export type StepStartedData = {
  actionIndex: number;
};

export type StepResultData = {
  actionIndex: number;
  passed: boolean;
  duration_ms: number;
  /** Raw error message, kept for backward compatibility. Prefer `structuredError`. */
  error?: string;
  /** Detailed, machine-readable error breakdown. */
  structuredError?: StructuredError;
};

/** What the recorder pushes to its host. Discriminated on `method`. */
export type SyntheticsForwardMessage = ({ type: 'recorder' } & (
  { method: 'resetCallLogs' } |
  { method: 'updateCallLogs', callLogs: CallLog[] } |
  { method: 'setCallLogs', callLogs: CallLog[] } |
  { method: 'setPaused', paused: boolean } |
  { method: 'setMode', mode: Mode } |
  { method: 'setSources', sources: Source[] } |
  { method: 'setActions', actions: ActionInContext[], sources: Source[] } |
  { method: 'elementPicked', elementInfo: ElementInfo, userGesture?: boolean }
) & {
  browserSteps?: BrowserStep[];
  generatedCode?: string;
  generatedLanguage?: string;
}) | {
  type: 'recorder';
  method: 'stepReplayStarted';
  stepStarted: StepStartedData;
} | {
  type: 'recorder';
  method: 'stepReplayResult';
  stepResult: StepResultData;
};

export type SyntheticsForwardCallback = (msg: SyntheticsForwardMessage) => void;

// ── The recorder app ──

export type RecorderAppFactoryOverride = (crx: CrxServer, recorder: RecorderServer, context: BrowserContextServer) => SyntheticsRecorderApp | Promise<SyntheticsRecorderApp>;

/**
 * An `IRecorderApp` that drives no Playwright editor UI, maps captured actions to
 * `BrowserStep[]`, and forwards them to a host over a callback.
 */
export class SyntheticsRecorderApp {
  constructor(crx: CrxServer, recorder: RecorderServer, forwardCallback: SyntheticsForwardCallback, context?: BrowserContextServer);
  on(event: 'show' | 'hide', listener: () => void): this;
  on(event: 'modeChanged', listener: (params: { mode: Mode }) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  open(options?: { mode?: Mode, language?: string, testIdAttributeName?: string }): Promise<void>;
  close(): Promise<void>;
  setMode(mode: Mode): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  setSources(sources: Source[]): Promise<void>;
  setActions(actions: ActionInContext[], sources: Source[]): Promise<void>;
  elementPicked(elementInfo: ElementInfo, userGesture?: boolean): Promise<void>;
  resetCallLogs(): Promise<void>;
  updateCallLogs(callLogs: CallLog[]): Promise<void>;
}

/**
 * The server-side Crx class, exported as a value so an embedder can install a recorder-app
 * factory. Note that the *type* `Crx` above is the client-side API of the `crx` export —
 * a pre-existing collision in this package's surface, where one name means two things.
 */
export const Crx: {
  recorderAppFactoryOverride: RecorderAppFactoryOverride | null;
};

// ── Mapping ──

export function mapActionToBrowserStep(actionInContext: ActionInContext, actionIndex: number, responses?: SettleResponsePattern[], aliasFor?: (pageGuid: string) => string): BrowserStep;
export function mapActionsToBrowserSteps(actions: ActionInContext[], responsesFor?: (action: ActionInContext) => SettleResponsePattern[] | undefined): BrowserStep[];
export function mapBrowserStepToAction(step: BrowserStep): ActionInContext;
export function mapBrowserStepsToActions(steps: BrowserStep[]): ActionInContext[];

/**
 * Override the attribute treated as the test id when ranking locator candidates.
 * Recording and replay use whatever the host configures per request.
 */
export function setLocatorTestIdAttribute(attributeName: string): void;
