/**
 * Background service worker for the synthetics recorder extension.
 *
 * Lifecycle:
 * 1. Sets Crx.recorderAppFactoryOverride → SyntheticsRecorderApp
 * 2. Listens for startRecording from O2 → opens recording tab → attaches
 * 3. Routes BrowserStep[] from SyntheticsRecorderApp → O2 API + overlay
 * 4. Auto-stops on tab close
 */

import playwright, { crx, Crx, SyntheticsRecorderApp } from 'playwright-crx';
import type { Mode } from '@recorder/recorderTypes';
import type { CrxApplication } from 'playwright-crx';
import type { BrowserStep, SyntheticsForwardMessage } from 'playwright-crx';
import type { O2ToExtensionMessage, ExtensionToO2Message, OverlayMessage } from './messaging';

// ---- State ----

let crxApp: CrxApplication | undefined;
let recordingId: string | undefined;
let recordingTabId: number | undefined;
let currentMode: Mode = 'none';
let browserSteps: BrowserStep[] = [];
let isRecording = false;
let o2Endpoint = '';

// ---- Initialization ----

async function init() {
  // Load O2 endpoint from storage
  const stored = await chrome.storage.local.get(['o2Endpoint']);
  o2Endpoint = (stored.o2Endpoint as string) || '';

  // Set the factory override BEFORE any CRX operations
  Crx.recorderAppFactoryOverride = async (crxInstance, recorder, _context) => {
    const app = new SyntheticsRecorderApp(crxInstance, recorder, handleRecorderMessage);
    app.on('show', () => { /* headless — no UI */ });
    app.on('hide', () => { /* headless — no UI */ });
    app.on('modeChanged', ({ mode }) => {
      currentMode = mode;
    });
    return app;
  };

  // Set default testIdAttributeName
  playwright.selectors.setTestIdAttribute('data-test');

  // Listen for commands from O2 web app
  chrome.runtime.onMessageExternal.addListener(handleO2Message);

  // Listen for actions from content script overlay
  chrome.runtime.onMessage.addListener(handleInternalMessage);

  // Auto-stop when recording tab is closed
  chrome.tabs.onRemoved.addListener(handleTabRemoved);

  // Extension icon click → toggle recording
  chrome.action.onClicked.addListener(handleActionClick);
}

// ---- O2 → Extension commands (externally_connectable) ----

function handleO2Message(
  message: O2ToExtensionMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean {
  if (message.type !== 'synthetics-command') return false;

  const { command } = message;

  switch (command.action) {
    case 'startRecording':
      startRecording(command.mode ?? 'recording', command.testIdAttr ?? 'data-test')
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'stopRecording':
      stopRecording()
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'setMode':
      setMode(command.mode)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'getStatus':
      sendResponse({ isRecording, mode: currentMode, tabId: recordingTabId, stepCount: browserSteps.length });
      return false;

    case 'ejectCode':
      sendResponse({ code: '' }); // TBD
      return false;
  }
  return false;
}

// ---- Internal messages (from content script overlay) ----

function handleInternalMessage(
  message: any,
  sender: chrome.runtime.MessageSender,
  _sendResponse: (response?: any) => void
): boolean {
  if (message.type === 'synthetics-overlay-action') {
    const tabId = sender.tab?.id ?? message.tabId;
    switch (message.action) {
      case 'stop':
        stopRecording().catch(console.error);
        break;
      case 'play':
        replayAll().catch(console.error);
        break;
      case 'playStep':
        if (message.stepId) replayStep(message.stepId, tabId).catch(console.error);
        break;
    }
    return false;
  }
  return false;
}

// ---- Recorder → background messages (from SyntheticsRecorderApp) ----

function handleRecorderMessage(msg: SyntheticsForwardMessage) {
  switch (msg.method) {
    case 'setActions': {
      if (msg.browserSteps) {
        browserSteps = msg.browserSteps;
        if (recordingTabId) {
          sendToOverlay(recordingTabId, {
            method: 'updateSteps',
            steps: browserSteps.map(s => ({ id: s.id, name: s.name })),
          });
          sendToOverlay(recordingTabId, {
            method: 'recordingState',
            isRecording: true,
            mode: currentMode,
            stepCount: browserSteps.length,
          });
        }
      }
      sendToO2({
        type: 'synthetics-recorder',
        recordingId: recordingId!,
        payload: {
          method: 'setActions',
          actions: msg.actions,
          browserSteps: msg.browserSteps ?? [],
          sources: msg.sources ?? [],
        },
      });
      break;
    }
    case 'setSources': {
      sendToO2({
        type: 'synthetics-recorder',
        recordingId: recordingId!,
        payload: {
          method: 'setSources',
          sources: msg.sources ?? [],
          generatedCode: msg.generatedCode,
          generatedLanguage: msg.generatedLanguage,
        },
      });
      break;
    }
    case 'setMode': {
      currentMode = msg.mode;
      if (recordingTabId) {
        sendToOverlay(recordingTabId, { method: 'setMode', mode: msg.mode });
      }
      break;
    }
    case 'elementPicked': {
      sendToO2({
        type: 'synthetics-recorder',
        recordingId: recordingId ?? '',
        payload: {
          method: 'elementPicked',
          elementInfo: msg.elementInfo,
          userGesture: msg.userGesture,
        },
      });
      break;
    }
  }
}

// ---- Recording lifecycle ----

async function startRecording(mode: Mode = 'recording', testIdAttr: string = 'data-test') {
  if (isRecording) return;

  playwright.selectors.setTestIdAttribute(testIdAttr);

  // Open a new dedicated recording tab
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  if (!tab?.id) throw new Error('Failed to create recording tab');

  recordingTabId = tab.id;
  recordingId = `rec_${Date.now()}_${tab.id}`;
  browserSteps = [];
  currentMode = mode;

  // Start CRX application (lazy — reuses if already started)
  crxApp = await crx.start({ incognito: false });

  // Show recorder (creates SyntheticsRecorderApp via factory override)
  await crxApp.recorder.show({
    mode,
    testIdAttributeName: testIdAttr,
  });

  // Attach to the recording tab
  await crxApp.attach(recordingTabId);
  isRecording = true;

  // Show content script overlay
  await sendToOverlay(recordingTabId, { method: 'showOverlay' });
  await sendToOverlay(recordingTabId, {
    method: 'recordingState',
    isRecording: true,
    mode,
    stepCount: 0,
  });

  // Set badge
  chrome.action.setBadgeText({ text: 'REC', tabId: recordingTabId });
  chrome.action.setBadgeBackgroundColor({ color: '#e74c3c', tabId: recordingTabId });

  // Notify O2
  sendToO2({
    type: 'synthetics-recorder',
    recordingId,
    payload: {
      method: 'recordingStarted',
      tabId: recordingTabId,
      url: tab.url ?? '',
    },
  });
}

async function stopRecording() {
  if (!isRecording || !crxApp) return;

  // Hide recorder (detaches, cleans up)
  await crxApp.recorder.hide().catch(() => {});

  // Hide overlay
  if (recordingTabId) {
    await sendToOverlay(recordingTabId, { method: 'hideOverlay' });
  }

  // Notify O2 with final steps
  sendToO2({
    type: 'synthetics-recorder',
    recordingId: recordingId!,
    payload: {
      method: 'recordingStopped',
      totalSteps: browserSteps.length,
    },
  });

  isRecording = false;
  recordingTabId = undefined;
  recordingId = undefined;
  browserSteps = [];

  await crxApp.close().catch(() => {});
  crxApp = undefined;

  chrome.action.setBadgeText({ text: '' });
}

async function setMode(mode: Mode) {
  if (crxApp) {
    await crxApp.recorder.setMode(mode);
  }
}

// ---- Tab lifecycle ----

function handleTabRemoved(tabId: number) {
  if (tabId === recordingTabId && isRecording) {
    stopRecording().catch(console.error);
  }
}

function handleActionClick(tab: chrome.tabs.Tab) {
  if (isRecording) {
    stopRecording().catch(console.error);
  } else {
    startRecording().catch(console.error);
  }
}

// ---- Playback ----

async function replayAll() {
  // Triggered from overlay "Play" button
  // SyntheticsRecorderApp._run() handles the actual playback
  // This requires wiring the event through the message system
  if (crxApp) {
    await crxApp.recorder.setMode('none');
    await crxApp.recorder.setMode('recording');
    // Replay is triggered by the recorder's resume event
  }
}

async function replayStep(stepId: string, tabId: number) {
  // Single-step replay: find the action by step index
  const stepIndex = parseInt(stepId.replace('s', ''), 10) - 1;
  if (isNaN(stepIndex) || stepIndex < 0 || stepIndex >= browserSteps.length) return;

  // For now, replay all steps up to and including the target
  // The SyntheticsRecorderApp handles this
  try {
    // Notify O2 of replay attempt
    sendToO2({
      type: 'synthetics-recorder',
      recordingId: recordingId ?? '',
      payload: {
        method: 'stepReplayResult',
        stepId,
        passed: true, // Placeholder — actual result from CrxPlayer
        duration_ms: 0,
      },
    });
  } catch (err) {
    console.error('[SyntheticsRecorder] Step replay failed:', err);
  }
}

// ---- Communication helpers ----

async function sendToOverlay(tabId: number, payload: OverlayMessage['payload']) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'synthetics-overlay',
      tabId,
      payload,
    });
  } catch {
    // Content script may not be loaded yet (e.g., chrome:// pages)
  }
}

async function sendToO2(message: ExtensionToO2Message) {
  if (!o2Endpoint) return;

  try {
    await fetch(`${o2Endpoint}/recorder/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
  } catch (err) {
    console.error('[SyntheticsRecorder] Failed to send to O2:', err);
  }
}

// ---- Start ----

init();
