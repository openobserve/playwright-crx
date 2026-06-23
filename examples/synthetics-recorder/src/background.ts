/**
 * Background service worker for the synthetics recorder extension.
 *
 * Lifecycle:
 * 1. Sets Crx.recorderAppFactoryOverride → SyntheticsRecorderApp
 * 2. The O2 web app (running in a browser tab) connects via chrome.runtime.connect
 *    and sends startRecording → opens recording tab → attaches
 * 3. Routes BrowserStep[] from SyntheticsRecorderApp → O2 web app (over the Port) + overlay
 * 4. Auto-stops on tab close
 */

import playwright, { crx, Crx, SyntheticsRecorderApp } from 'playwright-crx';
import type { Mode } from '@recorder/recorderTypes';
import type { CrxApplication } from 'playwright-crx';
import type { BrowserStep, SyntheticsForwardMessage } from 'playwright-crx';
import type { O2Command, O2ToExtensionMessage, ExtensionToO2Message, OverlayMessage } from './messaging';

// ---- State ----

let crxApp: CrxApplication | undefined;
let recordingId: string | undefined;
let recordingTabId: number | undefined;
let currentMode: Mode = 'none';
let browserSteps: BrowserStep[] = [];
let isRecording = false;

// Long-lived connection back to the O2 web app running in a browser tab.
// The O2 app opens this via chrome.runtime.connect(extensionId, { name: 'synthetics-recorder' }).
let o2Port: chrome.runtime.Port | undefined;

// Name the O2 web app must use when opening the connection.
const O2_PORT_NAME = 'synthetics-recorder';

// ---- Initialization ----

function init() {
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

  // Long-lived connection from the O2 web app — used to stream events back to it.
  chrome.runtime.onConnectExternal.addListener(handleO2Connect);

  // One-shot commands from the O2 web app (request/response).
  chrome.runtime.onMessageExternal.addListener(handleO2Message);

  // Listen for actions from content script overlay
  chrome.runtime.onMessage.addListener(handleInternalMessage);

  // Auto-stop when recording tab is closed
  chrome.tabs.onRemoved.addListener(handleTabRemoved);

  // Extension icon click → toggle recording
  chrome.action.onClicked.addListener(handleActionClick);
}

// ---- O2 web app connection (externally_connectable Port) ----

function handleO2Connect(port: chrome.runtime.Port) {
  console.log(port);
  if (port.name !== O2_PORT_NAME) return;

  // Only one O2 app drives the recorder at a time; the latest connection wins.
  o2Port = port;

  // Commands may also arrive over the port (so the app can use a single channel).
  port.onMessage.addListener((message: O2ToExtensionMessage) => {
    console.log("O2 message ---", message);
    if (message?.type === 'synthetics-command')
      runO2Command(message.command, response => port.postMessage({ type: 'synthetics-response', response }));
  });

  port.onDisconnect.addListener(() => {
    console.log("disconnect port --------------", o2Port);
    if (o2Port === port) o2Port = undefined;
  });
}

// ---- O2 → Extension commands (externally_connectable) ----

function handleO2Message(
  message: O2ToExtensionMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean {
  if (message.type !== 'synthetics-command') return false;
  return runO2Command(message.command, sendResponse);
}

// Runs a single O2 command, replying via `respond`. Returns true when the
// response is sent asynchronously (required by chrome.runtime.onMessage*).
function runO2Command(command: O2Command, respond: (response?: any) => void): boolean {
  console.log("O2 command ---", command);
  switch (command.action) {
    case 'startRecording':
      startRecording(command.mode ?? 'recording', command.testIdAttr ?? 'class', command.targetUrl)
        .then(() => respond({ success: true }))
        .catch(err => respond({ success: false, error: err.message }));
      return true;

    case 'stopRecording':
      stopRecording()
        .then(() => respond({ success: true }))
        .catch(err => respond({ success: false, error: err.message }));
      return true;

    case 'setMode':
      setMode(command.mode)
        .then(() => respond({ success: true }))
        .catch(err => respond({ success: false, error: err.message }));
      return true;

    case 'getStatus':
      respond({ isRecording, mode: currentMode, tabId: recordingTabId, stepCount: browserSteps.length });
      return false;

    case 'ejectCode':
      respond({ code: '' }); // TBD
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
  console.log("handleRecorderMessage ---", msg);
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

// ---- Recorder-owned window tracking ----
//
// We track the window ids the recorder itself created in chrome.storage.session. This is the ONLY
// source of truth for "which incognito windows are ours" — the recorder never closes a window that
// isn't in this set, so the user's personal incognito windows are always safe. The set survives
// service-worker restarts (so orphaned recorder windows are still recoverable) and is cleared when
// the browser closes.

const OWNED_WINDOWS_KEY = 'recordingWindowIds';

async function getOwnedWindowIds(): Promise<number[]> {
  const stored = await chrome.storage.session.get(OWNED_WINDOWS_KEY);
  const ids = stored[OWNED_WINDOWS_KEY];
  return Array.isArray(ids) ? ids : [];
}

async function setOwnedWindowIds(ids: number[]): Promise<void> {
  await chrome.storage.session.set({ [OWNED_WINDOWS_KEY]: ids });
}

// ---- Recording lifecycle ----

// Prepares the incognito window/tab to record on and returns its tab id. If the recorder already owns
// a live incognito window, that window is reused (its tab navigated to targetUrl) and any other
// recorder-owned windows are closed; otherwise a fresh incognito window is created.
async function prepareRecordingWindow(targetUrl: string): Promise<number> {
  // Tear down any in-memory session WITHOUT closing the window (so it can be reused). Awaiting
  // crxApp.close() lets the context Close event clear the incognito lock in crx.ts, otherwise the
  // next crx.start({ incognito: true }) throws 'incognito crxApplication is already started'.
  if (crxApp) {
    await crxApp.recorder.hide().catch(() => {});
    await crxApp.close().catch(() => {});
    crxApp = undefined;
  }

  // Resolve which of our tracked windows are still alive and still incognito.
  const ownedIds = await getOwnedWindowIds();
  const ownedWindows = (await Promise.all(
    ownedIds.map(id => chrome.windows.get(id, { populate: true }).catch(() => undefined)),
  )).filter((w): w is chrome.windows.Window => !!w && !!w.id && w.incognito);

  // Prefer the window that holds the previous recording tab; otherwise the first live owned window.
  const reuseWin = ownedWindows.find(w => w.tabs?.some(t => t.id === recordingTabId)) ?? ownedWindows[0];

  // Close every OTHER recorder-owned window (orphans from prior sessions). Never touches windows
  // outside the tracked set, so personal incognito windows are left alone.
  await Promise.all(
    ownedWindows
      .filter(w => w.id !== reuseWin?.id)
      .map(w => chrome.windows.remove(w.id!).catch(() => {})),
  );

  if (reuseWin?.id) {
    const reuseTab = reuseWin.tabs?.find(t => t.active) ?? reuseWin.tabs?.[0];
    if (reuseTab?.id) {
      await chrome.windows.update(reuseWin.id, { focused: true });
      await chrome.tabs.update(reuseTab.id, { url: targetUrl || 'about:blank', active: true });
      await setOwnedWindowIds([reuseWin.id]);
      return reuseTab.id;
    }
  }

  // No reusable window — open a fresh incognito window. crx.start({ incognito: true }) reuses the
  // active incognito tab (see _startIncognitoCrxApplication in crx.ts), keeping it to one window.
  const win = await chrome.windows.create({
    incognito: true,
    focused: true,
    url: targetUrl || 'about:blank',
  });
  const tab = win?.tabs?.[0];
  if (!win?.id || !tab?.id) throw new Error('Failed to create incognito recording window');

  await setOwnedWindowIds([win.id]);
  return tab.id;
}

async function startRecording(mode: Mode = 'recording', testIdAttr: string = 'class', targetUrl: string = '') {
  playwright.selectors.setTestIdAttribute(testIdAttr);

  // Reuse an existing recorder window if present (resetting everything), else open a new one.
  recordingTabId = await prepareRecordingWindow(targetUrl);
  recordingId = `rec_${Date.now()}_${recordingTabId}`;
  browserSteps = [];
  currentMode = mode;

  // Start CRX in incognito — finds & reuses the incognito tab prepared above.
  crxApp = await crx.start({ incognito: true });

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
      url: targetUrl,
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

  // Clear window tracking so the next start treats things as a clean slate. The window itself is
  // left open (matching prior behavior) — only the tracking is reset.
  await setOwnedWindowIds([]);

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

// Pushes an event to the O2 web app over the live Port. If no app is connected
// (e.g. recording was started from the extension icon), the event is dropped.
function sendToO2(message: ExtensionToO2Message) {
  console.log("Send to o2 ---", message);
  console.log("O2 Port ----", o2Port);
  if (!o2Port) return;

  try {
    o2Port.postMessage(message);
  } catch (err) {
    // Port may have disconnected between the check and the post.
    console.error('[SyntheticsRecorder] Failed to send to O2 app:', err);
    o2Port = undefined;
  }
}

// ---- Start ----

init();
