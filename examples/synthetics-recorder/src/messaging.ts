/**
 * Shared message types for the synthetics recorder extension.
 */

import type { Mode, Source, ElementInfo } from '@recorder/recorderTypes';
import type { ActionInContext } from '@recorder/actions';
import type { BrowserStep } from 'playwright-crx';

// ---- O2 → Extension commands (via externally_connectable) ----

export type O2Command =
  | { action: 'startRecording'; mode?: Mode; testIdAttr?: string }
  | { action: 'stopRecording' }
  | { action: 'setMode'; mode: Mode }
  | { action: 'getStatus' }
  | { action: 'ejectCode'; language?: string };

export type O2ToExtensionMessage = {
  type: 'synthetics-command';
  command: O2Command;
};

// ---- Extension → O2 data (via HTTP fetch) ----

export type ExtensionToO2Payload =
  | { method: 'setMode'; mode: Mode }
  | { method: 'setActions'; actions: ActionInContext[]; browserSteps: BrowserStep[]; sources: Source[] }
  | { method: 'setSources'; sources: Source[]; generatedCode?: string; generatedLanguage?: string }
  | { method: 'elementPicked'; elementInfo: ElementInfo; userGesture?: boolean }
  | { method: 'recordingStarted'; tabId: number; url: string }
  | { method: 'recordingStopped'; totalSteps: number }
  | { method: 'stepReplayResult'; stepId: string; passed: boolean; duration_ms: number; error?: string };

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
