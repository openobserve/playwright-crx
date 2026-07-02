/**
 * Shared message types for the synthetics recorder extension.
 */

import type { Mode, Source, ElementInfo } from '@recorder/recorderTypes';
import type { ActionInContext } from '@recorder/actions';
import type { BrowserStep, StructuredError } from 'playwright-crx';

// ---- O2 → Extension commands (via externally_connectable) ----

export type O2Command =
  | { action: 'startRecording'; mode?: Mode; testIdAttr?: string; targetUrl?: string }
  | { action: 'stopRecording' }
  | { action: 'setMode'; mode: Mode }
  | { action: 'getStatus' }
  | { action: 'ejectCode'; language?: string }
  | { action: 'replay'; steps: BrowserStep[]; targetUrl?: string; testIdAttr?: string }
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
  | { method: 'stepReplayResult'; stepId: string; stepName?: string; passed: boolean; duration_ms: number; error?: string; structuredError?: StructuredError };

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
  | { method: 'updateSteps'; steps: BrowserStep[] }
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
  action: 'stop' | 'play' | 'playStep';
  stepId?: string;
};
