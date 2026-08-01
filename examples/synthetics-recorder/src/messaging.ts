/**
 * Shared message types for the synthetics recorder extension.
 */

import type { Mode, Source, ElementInfo } from '@recorder/recorderTypes';
import type { ActionInContext } from '@recorder/actions';
import type { BrowserStep, StructuredError } from 'playwright-crx';

// Auth config for basic HTTP authentication during replay.
export type ReplayAuth = {
  type: 'basic';
  username: string;
  password: string;
};

export type ReplayHeader = { key: string; value: string };

export type ReplayCookie = { name: string; value: string; domain: string };

// ---- O2 → Extension commands ----

export type O2Command =
  | { action: 'startRecording'; mode?: Mode; testIdAttr?: string; targetUrl?: string }
  | { action: 'stopRecording' }
  | { action: 'setMode'; mode: Mode }
  | { action: 'getStatus' }
  | { action: 'replay'; steps: BrowserStep[]; targetUrl?: string; testIdAttr?: string; auth?: ReplayAuth; headers?: ReplayHeader[]; cookies?: ReplayCookie[] }
  | { action: 'stopReplay' };

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
  | { method: 'recordingStarted'; tabId: number; url: string }
  | { method: 'recordingStopped'; totalSteps: number }
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
