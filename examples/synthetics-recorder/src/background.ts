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

import playwright, { crx, Crx, SyntheticsRecorderApp, mapBrowserStepsToActions, describeReplayFidelity, setLocatorTestIdAttribute } from 'playwright-crx';
import type { StepFidelity } from 'playwright-crx';
import type { Mode } from '@recorder/recorderTypes';
import type { CrxApplication } from 'playwright-crx';
import type { BrowserStep, SyntheticsForwardMessage, StepResultData, StepStartedData, StructuredError } from 'playwright-crx';
import type { O2Command, O2ToExtensionMessage, ExtensionToO2Message, OverlayMessage, ReplayResponse, ReplayAuth, ReplayHeader, ReplayCookie, BridgePortMessage, SwPong } from './messaging';
import { SW_PING } from './messaging';

// ---- State ----

let crxApp: CrxApplication | undefined;
let recordingId: string | undefined;
let recordingTabId: number | undefined;
let currentMode: Mode = 'none';
let browserSteps: BrowserStep[] = [];
let isRecording = false;

// Replay state. isReplaying guards against overlapping replays; replayStopped distinguishes a cancelled
// run (CrxPlayer.run swallows the Stopped error and returns normally) from a successful pass.
let isReplaying = false;
let replayStopped = false;
// The BrowserStep[] being replayed — used to map action indices back to step IDs for streaming.
let replaySteps: BrowserStep[] = [];
/** When the first replay step is a 'navigate' with a URL, mapBrowserStepsToActions
 *  converts it to 'openPage', which CrxPlayer.run() skips entirely (no events).
 *  This shifts all subsequent actionIndex values by +1 relative to replaySteps. */
let replayActionOffset = 0;
/** Per-step record of what the preview could NOT simulate (spec P2.S/P3.S/P4.S/P5.S).
 *  Computed once per replay so every step result can carry its own caveats and no
 *  skipped step is ever reported as a plain pass. */
let replayFidelity: StepFidelity[] = [];

// Long-lived connection back to the O2 web app running in a browser tab.
// The O2 app opens this via chrome.runtime.connect(extensionId, { name: 'synthetics-recorder' }).
let o2Port: chrome.runtime.Port | undefined;

// Pending responses that couldn't be delivered because the port was disconnected.
// Re-delivered when a new port connects (e.g., after bfcache restore).
let pendingBridgeResponses: any[] = [];

// Track the tab that owns the bridge connection (sender of the Port).
let o2TabId: number | undefined;

// Name the O2 web app must use when opening the connection.
const O2_PORT_NAME = 'synthetics-recorder';

// Playwright's native default test-id attribute. Used only when O2 doesn't send a (non-empty) testIdAttr —
// we never impose 'class' or 'data-test'.
const DEFAULT_TEST_ID_ATTR = 'data-testid';

// Resolves the test-id attribute for a request: use exactly what O2 sends; fall back to Playwright's
// default only when it's missing or blank (guards against `??` letting "" through).
function resolveTestIdAttr(testIdAttr?: string): string {
  return testIdAttr?.trim() || DEFAULT_TEST_ID_ATTR;
}

// ---- Initialization ----

function init() {
  // Set the factory override BEFORE any CRX operations
  Crx.recorderAppFactoryOverride = async (crxInstance, recorder, _context) => {
    // The context is what the app listens on for response evidence (Phase 4).
    const app = new SyntheticsRecorderApp(crxInstance, recorder, handleRecorderMessage, _context);
    app.on('show', () => { /* headless — no UI */ });
    app.on('hide', () => { /* headless — no UI */ });
    app.on('modeChanged', ({ mode }) => {
      currentMode = mode;
    });
    return app;
  };

  // Leave Playwright's native default test-id attribute ('data-testid'). Recording/replay use whatever
  // O2 sends per request; we don't impose 'class' or 'data-test'.
  playwright.selectors.setTestIdAttribute(DEFAULT_TEST_ID_ATTR);
  setLocatorTestIdAttribute(DEFAULT_TEST_ID_ATTR);

  // Long-lived connection from the O2 web app (bridge content script).
  // Internal connect replaces external — the content script owns the Port.
  chrome.runtime.onConnect.addListener(handleO2Connect);

  // Listen for actions from content script overlay
  chrome.runtime.onMessage.addListener(handleInternalMessage);

  // Auto-stop when recording tab is closed
  chrome.tabs.onRemoved.addListener(handleTabRemoved);

  // Re-project the overlay after the recorded page navigates. A journey is mostly
  // navigation, and every navigation destroys the content script along with the
  // overlay — but showOverlay was only ever sent once, from startRecording. An SPA
  // that bounces / -> /login dropped the recording indicator and the Stop button
  // before the user ever saw them, leaving recording with no visible state at all.
  chrome.tabs.onUpdated.addListener(handleTabUpdated);

  // NOTE: no chrome.action.onClicked listener. The action declares a default_popup,
  // and Chrome does not fire onClicked for an action that has one. On-demand
  // content-script injection — for users who installed the extension while the OO
  // page was already open, since Chrome does not retroactively inject content
  // scripts — now happens in popup.ts, where its success or failure is visible.
}

// ---- O2 web app connection (bridge content-script Port) ----

function handleO2Connect(port: chrome.runtime.Port) {
  if (port.name !== O2_PORT_NAME) return;

  // Only one O2 app drives the recorder at a time; the latest connection wins.
  // If there are pending responses from a previous disconnected port,
  // re-deliver them on the new port.
  if (pendingBridgeResponses.length > 0) {
    for (const pending of pendingBridgeResponses) {
      port.postMessage(pending);
    }
    pendingBridgeResponses = [];
  }
  o2Port = port;

  // Track the sender's tab and origin for trust checks + cleanup
  if (port.sender?.tab?.id) {
    o2TabId = port.sender.tab.id;
  }

  // Commands arrive over the port from the bridge content script.
  port.onMessage.addListener(handleBridgePortMessage);

  port.onDisconnect.addListener(() => {
    if (o2Port === port) {
      o2Port = undefined;
      o2TabId = undefined;
    }
  });
}

// ---- Bridge port message handler ----

function handleBridgePortMessage(message: any): void {
  // Bridge command from content script
  if (message?.type === 'synthetics-command') {
    const bridgeMsg = message as BridgePortMessage;
    if (!bridgeMsg.command) return;

    const respond = (response: any) => {
      const msg = {
        type: 'synthetics-response',
        response,
        _bridgeNonce: bridgeMsg._bridgeNonce,
      };
      if (o2Port) {
        o2Port.postMessage(msg);
      } else {
        pendingBridgeResponses.push(msg);
      }
    };

    runO2Command(bridgeMsg.command, respond);
  }
}

// Runs a single O2 command, replying via `respond`. Returns true when the
// response is sent asynchronously (required by chrome.runtime.onMessage*).
function runO2Command(command: O2Command, respond: (response?: any) => void): boolean {
  switch (command.action) {
    case 'replay':
      handleReplay(command.steps, command.targetUrl, command.testIdAttr, command.auth, command.headers, command.cookies)
        .then(result => respond(result))
        .catch(err => respond({ success: false, passed: false, error: err.message }));
      return true;
    case 'startRecording':
      startRecording(command.mode ?? 'recording', command.testIdAttr, command.targetUrl)
        .then(() => respond({ success: true }))
        .catch(err => {
          respond({ success: false, error: err.message })
        });
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
      respond({
        isRecording,
        mode: currentMode,
        tabId: recordingTabId,
        stepCount: browserSteps.length,
        // Chrome updates this extension independently of when O2 deploys, so the
        // two can disagree about the wire with no way to say so. Reporting the
        // manifest version — already the source of truth, and the package script
        // requires it to agree with package.json — lets O2 say "update the
        // extension" instead of failing obscurely on a message shape it does not
        // recognise.
        version: chrome.runtime.getManifest().version,
      });
      return false;

    case 'stopReplay':
      handleStopReplay()
        .then(() => respond({ success: true }))
        .catch(err => respond({ success: false, error: err.message }));
      return true;
  }

  // An unrecognised command must still be answered. The O2 page correlates replies by nonce,
  // so falling through without responding leaves it waiting out its own 60s timeout with no
  // way to tell "this build does not support that command" from "the extension is wedged".
  respond({ success: false, error: `unknown command: ${(command as { action?: string }).action ?? '(none)'}` });
  return false;
}

// ---- Internal messages (from content script overlay) ----

function handleInternalMessage(
  message: any,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean {
  // Liveness probe from the content script or popup. Answering it is what lets a
  // caller distinguish "worker still starting" from "extension not installed" —
  // sendMessage is queued until this listener is registered, so a reply proves the
  // worker has finished evaluating and the bridge port will be accepted.
  if (message?.type === SW_PING.type) {
    const pong: SwPong = { ok: true, isRecording, isReplaying, stepCount: browserSteps.length };
    sendResponse(pong);
    return false;
  }

  if (message?.type === 'synthetics-overlay-action') {
    switch (message.action) {
      case 'stop':
        if (isReplaying)
          handleStopReplay().catch(console.error);
        else
          stopRecording().catch(console.error);
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
    case 'stepReplayStarted': {
      const started = msg.stepStarted;
      if (!started) break;
      const stepIndex = started.actionIndex + replayActionOffset;
      const step = replaySteps[stepIndex];
      const stepId = step?.id ?? `s${started.actionIndex + 1}`;
      const stepName = step?.name;
      sendToO2({
        type: 'synthetics-recorder',
        recordingId: recordingId ?? `replay_${Date.now()}`,
        payload: {
          method: 'stepReplayStarted',
          stepId,
          stepName,
        },
      });
      break;
    }
    case 'stepReplayResult': {
      const result = msg.stepResult;
      if (!result) break;
      const stepIndex = result.actionIndex + replayActionOffset;
      const step = replaySteps[stepIndex];
      const stepId = step?.id ?? `s${result.actionIndex + 1}`;
      const stepName = step?.name;
      sendToO2({
        type: 'synthetics-recorder',
        recordingId: recordingId ?? `replay_${Date.now()}`,
        payload: {
          method: 'stepReplayResult',
          stepId,
          stepName,
          passed: result.passed,
          duration_ms: result.duration_ms,
          error: result.error,
          structuredError: result.structuredError,
          // What the preview did not actually evaluate for this step. A green
          // result with notes is not the same claim as a green result without.
          fidelity: replayFidelity[stepIndex]?.notes?.length
            ? { level: replayFidelity[stepIndex].level, notes: replayFidelity[stepIndex].notes }
            : undefined,
        },
      });
      if (recordingTabId) {
        sendToOverlay(recordingTabId, {
          method: 'stepResult',
          stepId,
          passed: result.passed,
          error: result.error,
        });
      }
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
  // Chrome grants incognito access to an extension only after the user turns it on by hand, and a
  // freshly installed extension therefore cannot record at all: chrome.windows.create({incognito:true})
  // fails and the session dies with "Failed to create incognito recording window", which says nothing
  // about what to do. Check first so the message names the fix.
  if (!(await chrome.extension.isAllowedIncognitoAccess())) {
    throw new Error(
      'Recording needs incognito access. Open chrome://extensions, find "OpenObserve Synthetics Recorder", ' +
      'and turn on "Allow in incognito" — recordings always run in a separate incognito window.');
  }

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

  // Window dimensions: 80% of the last focused window, centered over it.
  const focusedWin = await chrome.windows.getLastFocused();
  const screenW = focusedWin?.width ?? 1440;
  const screenH = focusedWin?.height ?? 900;
  const screenL = focusedWin?.left ?? 0;
  const screenT = focusedWin?.top ?? 0;
  const winWidth = Math.round(screenW * 0.9);
  const winHeight = Math.round(screenH * 0.9);
  const winLeft = screenL + screenW - winWidth;
  const winTop = screenT + Math.round((screenH - winHeight) / 2);

  if (reuseWin?.id) {
    const reuseTab = reuseWin.tabs?.find(t => t.active) ?? reuseWin.tabs?.[0];
    if (reuseTab?.id) {
      await chrome.windows.update(reuseWin.id, { focused: true, width: winWidth, height: winHeight, left: winLeft, top: winTop });
      await chrome.tabs.update(reuseTab.id, { url: targetUrl || 'about:blank', active: true });
      await setOwnedWindowIds([reuseWin.id]);
      return reuseTab.id;
    }
  }

  // No reusable window — open a fresh incognito window. crx.start({ incognito: true }) reuses the
  // active incognito tab (see _startIncognitoCrxApplication in crx.ts), keeping it to one window.
  let win: chrome.windows.Window | undefined;
  const windowOpts = {
    focused: true,
    url: targetUrl || 'about:blank',
    width: winWidth,
    height: winHeight,
    left: winLeft,
    top: winTop,
  };

  win = await chrome.windows.create({ ...windowOpts, incognito: true }).catch(() => undefined);

  // If incognito creation failed, throw — a non-incognito window would cause
  // crxApp.attach() to fail with "Tab is not in the expected browser context"
  // because crx.start({ incognito: true }) expects an incognito tab.
  if (!win?.id)
    throw new Error('Failed to create incognito recording window');


  // Poll for the tab if it's not immediately available (Chromium quirk: tabs may
  // populate asynchronously after window.create resolves).
  let tab = win?.tabs?.[0];
  for (let attempt = 0; (!tab?.id) && (win?.id) && attempt < 20; attempt++) {

    await new Promise(r => setTimeout(r, 250));
    const w = await chrome.windows.get(win.id!, { populate: true }).catch(() => null);
    tab = w?.tabs?.[0];
  }

  if (!win?.id) {
    console.error('[synthetics-recorder:sw] window create failed — no window id');
    throw new Error('Failed to create incognito recording window: no window id returned');
  }
  if (!tab?.id) {
    console.error('[synthetics-recorder:sw] window created but no tab — win.id=' + win.id + ', tabs=' + JSON.stringify(win.tabs));
    // Last resort: try chrome.tabs.query
    const tabs = await chrome.tabs.query({ windowId: win.id });
    tab = tabs?.[0] ?? tab;

  }
  if (!tab?.id) throw new Error('Failed to create incognito recording window: no tab in window ' + win.id);

  await setOwnedWindowIds([win.id]);
  return tab.id;
}

async function startRecording(mode: Mode = 'recording', testIdAttr?: string, targetUrl: string = '') {
  const attr = resolveTestIdAttr(testIdAttr);
  setLocatorTestIdAttribute(attr);
  playwright.selectors.setTestIdAttribute(attr);

  // Reuse an existing recorder window if present (resetting everything), else open a new one.
  recordingTabId = await prepareRecordingWindow(targetUrl);
  recordingId = `rec_${Date.now()}_${recordingTabId}`;
  browserSteps = [];
  currentMode = mode;

  // Start CRX on the exact tab prepared above. There is deliberately no
  // non-incognito fallback: that application would have isIncognito() === false,
  // and the attach below would always fail with 'Tab is not in the expected
  // browser context', hiding whatever actually went wrong here.
  crxApp = await crx.start({ incognito: true, tabId: recordingTabId });

  // Show recorder (creates SyntheticsRecorderApp via factory override)
  await crxApp.recorder.show({
    mode,
    testIdAttributeName: attr,
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

  // NOTE: we intentionally keep the owned-window tracking after stop so a subsequent `replay` can reuse
  // the just-recorded incognito window. The set is updated whenever a window is created/reused in
  // prepareRecordingWindow.

  chrome.action.setBadgeText({ text: '' });
}

async function setMode(mode: Mode) {
  if (crxApp) {
    await crxApp.recorder.setMode(mode);
  }
}

// ---- Tab lifecycle ----

// Restores the overlay onto the recording tab once a navigation has settled. Only ever touches the
// tab the recorder owns, and only while recording, so ordinary browsing is untouched.
//
// Currently a no-op in effect: the content script has the overlay switched off (see OVERLAY_ENABLED
// in content.ts, which explains why and what still needs deciding). Kept wired up deliberately — it
// is what makes the overlay survive navigation, and it has to be here whichever way that decision
// goes. The messages are harmless while the overlay is off; the content script ignores them.
async function handleTabUpdated(tabId: number, changeInfo: chrome.tabs.TabChangeInfo) {
  if (!isRecording || tabId !== recordingTabId || changeInfo.status !== 'complete') return;

  // 'complete' can beat the content script's document_idle registration, and a
  // send with no receiver is simply dropped — so retry briefly rather than lose
  // the overlay to a race that only shows up on slower pages.
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await sendToOverlay(tabId, { method: 'showOverlay' })) break;
    await new Promise(r => setTimeout(r, 200));
  }
  await sendToOverlay(tabId, {
    method: 'updateSteps',
    steps: browserSteps.map(s => ({ id: s.id, name: s.name })),
  });
  await sendToOverlay(tabId, {
    method: 'recordingState',
    isRecording: true,
    mode: currentMode,
    stepCount: browserSteps.length,
  });
}

async function handleTabRemoved(tabId: number) {
  if (tabId === recordingTabId && isRecording) {
    stopRecording().catch(console.error);
  }
  // O2 web app tab closed — tear down the bridge port
  if (tabId === o2TabId) {
    o2Port = undefined;
    o2TabId = undefined;
  }
}

// ---- Replay (web app sends BrowserStep[]) ----

function firstNavigateUrl(steps: BrowserStep[]): string | undefined {
  return steps.find(s => s.action === 'navigate')?.url;
}

// Replays a recorded journey sent by the O2 web app. Reverse-maps BrowserStep[] → ActionInContext[],
// reuses the recording incognito window (or opens one), and runs them via the server CrxPlayer. The player
// isn't reachable from the client, so we drive it through crxApp.recorder.runActions(actions) — the actions
// are passed directly (no code/parse round-trip). Stops at the first failing step; reports overall pass/fail.
async function handleReplay(steps: BrowserStep[], targetUrl?: string, testIdAttr?: string, auth?: ReplayAuth, headers?: ReplayHeader[], cookies?: ReplayCookie[]): Promise<ReplayResponse> {
  if (isReplaying)
    return { success: false, passed: false, error: 'A replay is already in progress' };

  // Replay and recording can't share the incognito CRX app — stop recording first.
  if (isRecording)
    await stopRecording();

  // Match the test-id attribute the recording used (sent by O2), otherwise internal:testid= selectors
  // resolve against the wrong attribute and time out.
  playwright.selectors.setTestIdAttribute(resolveTestIdAttr(testIdAttr));
  setLocatorTestIdAttribute(resolveTestIdAttr(testIdAttr));

  replayStopped = false;
  replaySteps = steps;
  replayFidelity = describeReplayFidelity(steps);
  // When the first step is a navigate with URL, mapBrowserStepsToActions converts
  // it to openPage, which the player skips — offset action indices by +1.
  replayActionOffset = (steps.length > 0 && steps[0].action === 'navigate' && !!steps[0].url) ? 1 : 0;
  const actions = mapBrowserStepsToActions(steps);

  // When auth/cookies/headers are configured, open the tab to about:blank so the context options
  // (extraHTTPHeaders / storageState) are in place before any navigation happens. The first replay
  // step (usually 'navigate') will then carry the set headers and cookies.
  const needsContextSetup = !!(auth || (headers && headers.length > 0) || (cookies && cookies.length > 0));
  const initialUrl = needsContextSetup ? 'about:blank' : (targetUrl || firstNavigateUrl(steps) || 'about:blank');
  const tabId = await prepareRecordingWindow(initialUrl);

  // Build context options for auth/headers/cookies.
  const contextOptions: Record<string, any> = {};
  const extraHeaders: Record<string, string> = {};
  if (auth?.type === 'basic' && auth.username) {
    const encoded = btoa(`${auth.username}:${auth.password}`);
    extraHeaders['Authorization'] = `Basic ${encoded}`;
  }
  if (headers) {
    for (const h of headers) {
      extraHeaders[h.key] = h.value;
    }
  }
  if (Object.keys(extraHeaders).length > 0) {
    contextOptions.extraHTTPHeaders = Object.entries(extraHeaders).map(([name, value]) => ({ name, value }));
  }
  if (cookies && cookies.length > 0) {
    contextOptions.storageState = {
      cookies: cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain || new URL(initialUrl !== 'about:blank' ? initialUrl : 'http://localhost').hostname,
        path: '/',
      })),
    };
  }

  try {
    crxApp = await crx.start({ incognito: true, tabId, contextOptions });
    await crxApp.attach(tabId);
    isReplaying = true;

    // show({ mode: 'none' }) triggers _createRecorderApp → factory → SyntheticsRecorderApp,
    // which registers a stepResult listener on Crx.player so per-step results stream to O2 in
    // real-time during replay. Mode 'none' avoids capturing any recording actions.
    await crxApp.recorder.show({ mode: 'none' });

    // runActions() stops at the first failing step and throws; on stopReplay the server swallows the
    // Stopped error and returns normally, so we distinguish a cancel via the replayStopped flag.
    await crxApp.recorder.runActions(actions);
    return replayStopped
      ? { success: true, passed: false, stopped: true }
      : { success: true, passed: true };
  } catch (err) {
    const e = err as Error;
    return {
      success: true,
      passed: false,
      error: e?.message ?? String(err),
      structuredError: {
        message: e?.message ?? String(err),
        name: e?.name,
        stack: e?.stack,
      },
    };
  } finally {
    isReplaying = false;
    replayActionOffset = 0;
    await crxApp?.close().catch(() => {});
    crxApp = undefined;
  }
}

// Cancels an in-progress replay. The server CrxPlayer.stop() makes the in-flight action throw Stopped,
// which run() catches and returns from — handleReplay then reports stopped:true.
async function handleStopReplay(): Promise<void> {
  if (!isReplaying || !crxApp) return;
  replayStopped = true;
  await crxApp.recorder.stop().catch(() => {});
}

// ---- Communication helpers ----

// Returns false when nothing received the message — the content script is not (yet) in that tab,
// e.g. a chrome:// page, or a document that has not reached document_idle.
async function sendToOverlay(tabId: number, payload: OverlayMessage['payload']): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'synthetics-overlay',
      tabId,
      payload,
    });
    return true;
  } catch {
    return false;
  }
}

// Pushes an event to the O2 web app over the live Port. If no app is connected,
// the event is dropped.
function sendToO2(message: ExtensionToO2Message) {
  if (!o2Port) {
    pendingBridgeResponses.push(message);
    return;
  }

  try {
    o2Port.postMessage(message);
  } catch (err) {
    // Port may have disconnected between the check and the post.
    // Buffer for re-delivery.
    pendingBridgeResponses.push(message);
    o2Port = undefined;
  }
}

// ---- Start ----

init();
