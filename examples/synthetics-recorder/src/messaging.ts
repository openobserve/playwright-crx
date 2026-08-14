/**
 * Shared message types for the synthetics recorder extension.
 */

import type { Mode, Source, ElementInfo } from '@recorder/recorderTypes';
import type { ActionInContext } from '@isomorphic/codegen/actions';
import type { BrowserStep, StructuredError } from 'playwright-crx';

// Auth config for basic HTTP authentication during replay.
export type ReplayAuth = {
  type: 'basic';
  username: string;
  password: string;
};

export type ReplayHeader = { key: string; value: string };

export type ReplayCookie = { name: string; value: string; domain: string };

/**
 * Why a restore stopped short of the point it was aiming for.
 *
 * `window-closed` and `cancelled` are the author ending it — the first through the
 * only exit a restore used to offer. Only `step-failed` is the journey being unable
 * to reach the point that was asked for.
 */
export type PrefixFailureReason = 'window-closed' | 'cancelled' | 'step-failed';

// ---- O2 → Extension commands ----

export type O2Command =
  | { action: 'startRecording'; mode?: Mode; testIdAttr?: string; targetUrl?: string }
  | { action: 'stopRecording' }
  | { action: 'setMode'; mode: Mode }
  | { action: 'getStatus' }
  | { action: 'replay'; steps: BrowserStep[]; targetUrl?: string; testIdAttr?: string; auth?: ReplayAuth; headers?: ReplayHeader[]; cookies?: ReplayCookie[] }
  /**
   * Replay `prefixSteps`, then record in the SAME session. The browser context stays
   * open across the mode flip, which is the whole point: it is what puts the author on
   * the screen their next step will act on. Unlike `replay`, this does not close the
   * CrxApplication when the steps finish — nor when they fail, so the recovery can be
   * a mode flip rather than another replay.
   */
  | { action: 'startRecordingFrom'; prefixSteps: BrowserStep[]; targetUrl?: string; testIdAttr?: string; auth?: ReplayAuth; headers?: ReplayHeader[]; cookies?: ReplayCookie[] }
  /**
   * Start capturing on the session a FAILED prefix left open, from wherever the
   * failing step stopped.
   *
   * Carries nothing because there is nothing to carry: the state it records against
   * is already in the browser, which is what makes this a mode flip and not a second
   * restore. Refused when no such session is open — the caller then has a real
   * restore to run instead, and must not be told this one started.
   */
  | { action: 'recordFromHere' }
  | { action: 'stopReplay' };

/**
 * Response to `getStatus` — also the capability handshake.
 *
 * The extension is installed from the Chrome Web Store and updates asynchronously,
 * so the web app always runs against a mix of versions. `capabilities` is what every
 * O2 affordance gates on: a STRING list rather than a version comparison, so a
 * capability can be added or withdrawn without the web app parsing version numbers.
 * `extVersion` is for the "update the extension" message and for support — never for
 * inferring what the extension can do.
 *
 * Both are optional so that an O2 build reading a pre-handshake extension type-checks;
 * O2 defines the absent-behaviour (assume `record` + `replay`, and nothing newer).
 */
export type RecorderStatus = {
  isRecording: boolean;
  mode: Mode;
  tabId?: number;
  stepCount: number;
  extVersion?: string;
  capabilities?: string[];
  /**
   * The same value as `extVersion`, under the name O2 reads today.
   *
   * Kept because the cost of removing it is invisible: `isExtensionOutdated(status.version)`
   * would receive `undefined` and quietly stop warning, rather than fail. It goes when O2
   * reads `extVersion` — a change on the O2 side, not this one.
   */
  version?: string;
};

/**
 * Answer to a command this build does not implement.
 *
 * It exists because the alternative is silence: an unrecognised action used to fall
 * off the end of `runO2Command` with no response at all, so the caller waited out its
 * full 4 s timeout and could only report a generic failure. `action` names what was
 * refused, so a stale extension can be attributed to the feature the author was using.
 */
export type UnsupportedCommandResponse = {
  success: false;
  error: 'unsupported-command';
  action: string;
};

// Response returned for a `replay` command. `passed` is the overall result; `stopped` is set when the
// replay was cancelled mid-run; `error` carries the failing step's message; `structuredError` carries
// a machine-readable breakdown (error name, stack, failing action/selector, etc.).
export type ReplayResponse = {
  success: boolean;
  passed: boolean;
  stopped?: boolean;
  error?: string;
  structuredError?: StructuredError;
};

export type O2ToExtensionMessage = {
  type: 'synthetics-command';
  command: O2Command;
};

// ---- Extension → O2 data (pushed over the runtime Port back to the O2 web app) ----

export type ExtensionToO2Payload =
  | { method: 'setMode'; mode: Mode }
  | { method: 'setActions'; actions: ActionInContext[]; browserSteps: BrowserStep[]; sources: Source[] }
  | { method: 'setSources'; sources: Source[]; generatedCode?: string; generatedLanguage?: string }
  | { method: 'elementPicked'; elementInfo: ElementInfo; userGesture?: boolean }
  | {
    method: 'recordingStarted';
    tabId: number;
    url: string;
    /** Set only for a restore-then-record session, so O2 can tell the two apart. */
    mode?: 'insert';
    /**
     * Where the author's own capture starts. The collection is reset at the mode
     * flip, so this is 0 — sent explicitly rather than assumed, so that if the reset
     * ever fails to clear something, O2 skips it instead of inserting it.
     */
    baselineStepCount?: number;
  }
  | { method: 'recordingStopped'; totalSteps: number }
  /**
   * The restore did not reach the requested point.
   *
   * On `step-failed` the session is deliberately left alive: the browser is sitting
   * where `stepId` stopped, which is a legitimate restored state and exactly where an
   * author fixing that step wants to be. The other two reasons end the session — a
   * window the author closed takes its context with it, and a cancel means they want
   * out — so there is nothing left to recover into.
   *
   * `reason` is what the web app renders from, and it is decided HERE because this is
   * the only place that can decide it: the service worker watched the tab go away and
   * knows which stop it was asked for, while all the web app would have is an
   * exception that reads the same for every one of them.
   */
  | { method: 'prefixFailed'; stepId: string; error?: string; structuredError?: StructuredError; reason?: PrefixFailureReason }
  | { method: 'stepReplayStarted'; stepId: string; stepName?: string }
  | {
    method: 'stepReplayResult';
    stepId: string;
    stepName?: string;
    passed: boolean;
    duration_ms: number;
    error?: string;
    structuredError?: StructuredError;
    /**
     * What the preview could not evaluate for this step (spec P2.S/P3.S/P4.S/P5.S).
     *
     * Present only when there is something to say. A green result WITH notes is a
     * weaker claim than a green result without, and the difference has to reach
     * the author — a sleep-free journey can replay faster than the application
     * responds and fail here on a step the probe would pass, and an author who
     * reads that as a step problem will re-add a sleep.
     */
    fidelity?: { level: 'exact' | 'approximate' | 'not_simulated'; notes: string[] };
  };

export type ExtensionToO2Message = {
  type: 'synthetics-recorder';
  recordingId: string;
  payload: ExtensionToO2Payload;
};

// ---- Overlay messages (background ↔ content script) ----

export type OverlayCommand =
  | { method: 'showOverlay' }
  | { method: 'hideOverlay' }
  | { method: 'setMode'; mode: Mode }
  // The overlay renders a name per step and nothing else, and both senders already
  // map down to that. Typing it as BrowserStep[] overstated what crosses this
  // boundary and forced a cast at one of the two call sites.
  | { method: 'updateSteps'; steps: Array<{ id: string; name: string }> }
  | { method: 'recordingState'; isRecording: boolean; mode: Mode; stepCount: number }
  | { method: 'stepResult'; stepId: string; passed: boolean; error?: string };

export type OverlayMessage = {
  type: 'synthetics-overlay';
  tabId: number;
  payload: OverlayCommand;
};

// ---- Overlay → background messages ----

export type OverlayToBackgroundMessage = {
  type: 'synthetics-overlay-action';
  tabId: number;
  action: 'stop';
};

// ---- Bridge message envelope (postMessage between OO web app ↔ content script) ----

export const BRIDGE_CHANNEL = 'oo-bridge';

// Handshake channels between the OO web app and the content script.
//
// The app posts PROBE_CHANNEL to ask "are you there?"; the content script answers
// with READY_CHANNEL once it has confirmed the service worker is actually awake.
// The answer is what makes detection deterministic — a page cannot control when
// the content script loads relative to its own listener, so an unsolicited
// announcement is not something it can rely on catching.
export const PROBE_CHANNEL = 'oo-bridge-probe';
export const READY_CHANNEL = 'oo-bridge-ready';

// ---- Liveness pings ----

// Content script (or popup) → service worker. The worker bundles the Playwright
// engine and starts on demand, so this doubles as the wake-up call: sendMessage
// queues until the worker has finished evaluating, where connect() would be
// dropped.
export const SW_PING = { type: 'oo-bridge-ping' } as const;

export type SwPong = {
  ok: true;
  isRecording: boolean;
  isReplaying: boolean;
  stepCount: number;
  // Same handshake as RecorderStatus. The popup pings before any port exists, so it
  // must be able to tell a stale extension from a working one without a command.
  extVersion?: string;
  capabilities?: string[];
};

// Popup → content script, to test whether a given tab is already bridged.
export const CONTENT_PING = { type: 'oo-content-ping' } as const;

export type ContentPong = { ok: true };

export type BridgeDirection = 'to-ext' | 'to-page';

export interface BridgeEnvelope<T = unknown> {
  ch: 'oo-bridge';
  dir: BridgeDirection;
  nonce: string;
  msg: T;
}

// ---- Bridge-port command (used over SW internal Port) ----

export interface BridgePortMessage {
  type: 'synthetics-command';
  command: O2Command;
  _bridgeNonce?: string;
}
