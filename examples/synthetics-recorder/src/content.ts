/**
 * Content script — injects a floating recording overlay into the target page.
 */

import type { Mode } from '@recorder/recorderTypes';
import type { OverlayMessage, OverlayToBackgroundMessage } from './messaging';
import { BRIDGE_CHANNEL, PROBE_CHANNEL, READY_CHANNEL, SW_PING, CONTENT_PING } from './messaging';

// ---- Takeover handshake ----
//
// This file reaches a page three ways: the <all_urls> content_scripts entry at
// document_idle, chrome.scripting.executeScript from the popup, and re-injection
// to repair a tab whose instance was orphaned.
//
// Orphaning is the case that matters and the one a simple "already installed"
// flag gets wrong. Turning on "Allow in incognito" — which every first-time user
// must do, because recording only ever runs in an incognito window — reloads the
// extension. Every already-open tab is left with a content script whose DOM
// listeners still fire but whose chrome.* APIs are dead, so it answers nothing and
// connects nothing. A flag would make the repair injection a no-op and strand the
// tab until a manual reload.
//
// So a new instance does not skip; it tells the old one to stand down. The old
// instance's window listener keeps working even when its extension context is
// gone, which is exactly what lets this reach the orphaned case. Duplicate
// injection into a healthy page lands here too: the previous instance goes quiet
// rather than racing this one for the worker's single o2Port.
const TAKEOVER_EVENT = '__ooSyntheticsTakeover';
const OVERLAY_ID = '__synthetics_recorder_overlay';

let active = true;

window.dispatchEvent(new Event(TAKEOVER_EVENT));
window.addEventListener(TAKEOVER_EVENT, () => {
  active = false;
  // Hand the port back rather than just falling silent. Going quiet is not enough:
  // the worker would still hold this Port and its listener, so each takeover would
  // leak one exactly as repeated probes used to.
  __bridgeClosePort?.();
  // Drop any overlay the outgoing instance owned; the incoming one re-renders
  // from the worker's current state.
  document.getElementById(OVERLAY_ID)?.remove();
});

let __bridgeOpenPort: (() => boolean) | null = null;
let __bridgeClosePort: (() => void) | null = null;

install();

function install(): void {
  // ---- Context discriminator ----
  //
  // Default: overlay mode (recording target pages). Bridge mode activates
  // only when the OO web app sends a probe (e.g. when the user clicks
  // "Record journey" or "Check again"). This stops the recording tab's content
  // script from accidentally opening a bridge port and stealing the single
  // o2Port in the service worker.
  window.addEventListener('message', event => {
    if (!active) return;
    if (event.source !== window) return;
    if (event.data?.ch !== PROBE_CHANNEL) return;
    handleProbe();
  });

  // Overlay mode runs immediately — no timer, no polling.
  initOverlay();

  // ---- bfcache-resilient fallback channel ------------------------------------
  // The bridge Port dies when Chrome bfcaches the OO tab. chrome.runtime.sendMessage
  // is queued and delivered on reactivation. The SW falls back to this when o2Port
  // is dead. Works regardless of mode (bridge or overlay).
  chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
    if (!active) return false;
    if (message?.type === 'oo-bridge-data') {
      window.postMessage(message.payload, '*');
      return false;
    }
    // Lets the popup tell whether this tab is already bridged, so it can offer to
    // inject rather than injecting blindly on every click.
    if (message?.type === CONTENT_PING.type) {
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  announceReady();
}

// Tell the OO web app the bridge is present. Sent once on install, and again in
// answer to every probe.
function announceReady(): void {
  if (!active) return;
  window.postMessage({ ch: READY_CHANNEL }, '*');
}

// Answer the web app's probe — but only once the service worker has actually
// acknowledged a message.
//
// Previously a probe produced no observable response at all, so every caller had
// to post it, sleep, and hope: see the sleep(500) plus 3x retry the in-repo bridge
// tests still carry (tests/crx/synthetics-v2-recording.spec.ts). The web app has
// no such retry, so a worker that was still starting up simply read as "extension
// not installed". Answering only after a confirmed round trip turns that race into
// a wait, and silence now genuinely means "not reachable".
function handleProbe(): void {
  // Install the bridge synchronously, before any await. Callers post their first
  // command a short moment after probing — the web app and the bridge specs both
  // do — and the page->port listener lives inside initBridge(), so deferring this
  // past a microtask would drop that command with nothing listening for it.
  if (!__bridgeOpenPort) initBridge();
  else __bridgeOpenPort();

  // Answering is what can wait: it only has to be true by the time it is sent.
  void confirmReady();
}

// Guards against a probe storm. Each confirmReady can hold up to three pending
// sendMessage calls and ~1.5s of backoff, and answering a probe with `ready` is
// exactly the kind of thing a caller may react to by probing again — so without
// this, a page that re-probes on ready would pile up unbounded pending work.
let readyInFlight = false;

async function confirmReady(): Promise<void> {
  if (readyInFlight) return;
  readyInFlight = true;
  try {
    if (await wakeServiceWorker()) announceReady();
  } finally {
    readyInFlight = false;
  }
}

// The worker bundles the Playwright engine, so a cold start is slow enough that a
// connect() landing mid-evaluation is dropped. sendMessage is queued until the
// worker's listeners are registered, which makes it the reliable way to wake it;
// the retries cover an extension reload racing the probe.
async function wakeServiceWorker(): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const pong = await chrome.runtime.sendMessage(SW_PING);
      if (pong?.ok) return true;
    } catch {
      // Worker still booting, or the extension was just reloaded — retry.
    }
    await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
  }
  return false;
}

// ---- Overlay mode (recorded page) -------------------------------------------

/**
 * The in-page recording overlay is ON, but reduced to its header bar. The running
 * step list is OFF — see STEP_LIST_ENABLED below.
 *
 * The overlay is a fixed panel pinned to the bottom-right of the recorded page at
 * `z-index: 2147483647`, so it sits above everything and whatever it covers cannot
 * be clicked, and therefore cannot be recorded. The header alone is a single short
 * bar; the step list is what made that a real problem, because it appended a row
 * per recorded action and grew down the viewport for the whole journey — over
 * exactly the bottom-right region where cookie banners, chat widgets and floating
 * CTAs live.
 *
 * Keeping the header keeps what the recording window actually needs from us: the
 * live status, the step count, and a one-click Stop that ends the session. That
 * last one has no substitute — Playwright's own recorder overlay (`x-pw-glass`) is
 * also injected and does show a floating toolbar with a red record dot and a red
 * wash over the page, but its dot toggles Playwright's record mode and does NOT end
 * the extension's session.
 */
const OVERLAY_ENABLED = true;

/**
 * The running step list inside the overlay is OFF, pending a design decision.
 * Nothing has been removed — updateStepList, the row markup and its styles are all
 * still here and still wired to the background script's `updateSteps` message. Set
 * this to `true` to restore it.
 *
 * WHY IT IS OFF
 *
 * It is unbounded. One row per recorded action, so the panel keeps growing down the
 * page for as long as the journey runs, blocking more of it the longer the author
 * records. The steps are already listed in the OpenObserve tab, which is where the
 * author edits them, so the in-page copy duplicated that at the cost of the page.
 *
 * OPTIONS TO WEIGH
 *
 *  - Cap it at the last N steps, so the panel has a fixed maximum height.
 *  - Keep it collapsed behind the step-count badge, expanding on click.
 *  - Make the list click-through (`pointer-events: none`) while leaving the header
 *    interactive, so it can never swallow a click meant for the page.
 *  - Let the user drag the panel, and remember the chosen corner.
 *
 * The first is the smallest change that keeps the feature and bounds the damage.
 */
const STEP_LIST_ENABLED = false;

function initOverlay(): void {

let overlayEl: HTMLDivElement | null = null;
let stepListEl: HTMLDivElement | null = null;

// ---- Message listener from background ----

chrome.runtime.onMessage.addListener((message: OverlayMessage, _sender, _sendResponse) => {
  if (!active) return;
  if (message?.type !== 'synthetics-overlay') return;

  switch (message.payload.method) {
    case 'showOverlay':
      showOverlay();
      break;
    case 'hideOverlay':
      hideOverlay();
      break;
    case 'setMode':
      updateMode(message.payload.mode);
      break;
    case 'updateSteps':
      updateStepList(message.payload.steps);
      break;
    case 'recordingState':
      updateRecordingState(message.payload.isRecording, message.payload.mode, message.payload.stepCount);
      break;
    case 'stepResult':
      updateStepResult(message.payload.stepId, message.payload.passed, message.payload.error);
      break;
  }
});

// ---- Overlay DOM ----

function showOverlay() {
  // Disabled — see OVERLAY_ENABLED. This is the single chokepoint: with no overlay
  // element, every update function below already no-ops on its null check, so
  // nothing else needs a guard and nothing else had to change.
  if (!OVERLAY_ENABLED) return;

  if (overlayEl) return;

  document.getElementById(OVERLAY_ID)?.remove();

  overlayEl = document.createElement('div');
  overlayEl.id = OVERLAY_ID;
  overlayEl.innerHTML = getOverlayHTML();
  document.body.appendChild(overlayEl);

  // Null when STEP_LIST_ENABLED is false, because the container is not rendered —
  // updateStepList then no-ops on its own guard. When the list is on, this is what
  // makes it render at all: before, stepListEl was only ever assigned null (in
  // hideOverlay), so updateStepList returned early every time.
  stepListEl = overlayEl.querySelector<HTMLDivElement>('#__synth_step_list');

  bindEvents();
}

function hideOverlay() {
  overlayEl?.remove();
  overlayEl = null;
  stepListEl = null;
}

function updateMode(mode: Mode) {
  const statusEl = overlayEl?.querySelector('#__synth_status_text');
  const dotEl = overlayEl?.querySelector('#__synth_status_dot');
  if (!statusEl || !dotEl) return;

  const modeConfig: Record<string, { text: string; color: string }> = {
    recording: { text: 'Recording', color: '#e74c3c' },
    'recording-inspecting': { text: 'Recording + Inspecting', color: '#e74c3c' },
    inspecting: { text: 'Inspecting', color: '#3498db' },
    assertingText: { text: 'Asserting Text', color: '#f39c12' },
    assertingVisibility: { text: 'Asserting Visibility', color: '#f39c12' },
    assertingValue: { text: 'Asserting Value', color: '#f39c12' },
    assertingSnapshot: { text: 'Asserting Snapshot', color: '#f39c12' },
    none: { text: 'Stopped', color: '#95a5a6' },
    standby: { text: 'Standby', color: '#bdc3c7' },
  };

  const config = modeConfig[mode] ?? { text: mode, color: '#95a5a6' };
  statusEl.textContent = config.text;
  (dotEl as HTMLElement).style.background = config.color;
}

function updateRecordingState(isRecording: boolean, mode: Mode, stepCount: number) {
  updateMode(mode);
  const stepCountEl = overlayEl?.querySelector('#__synth_step_count');
  if (stepCountEl) {
    stepCountEl.textContent = `${stepCount} step${stepCount !== 1 ? 's' : ''}`;
  }
  const stopBtn = overlayEl?.querySelector('#__synth_stop_btn') as HTMLElement;
  if (stopBtn) {
    stopBtn.style.display = isRecording ? '' : 'none';
  }
}

function updateStepList(steps: Array<{ id: string; name: string }>) {
  if (!stepListEl || !overlayEl) return;

  stepListEl.innerHTML = steps.map(s =>
    `<div class="__synth_step_row" data-step-id="${s.id}">
      <span class="__synth_step_name">${escapeHtml(s.name)}</span>
      <span class="__synth_step_status" data-step-id="${s.id}">—</span>
    </div>`
  ).join('');
}

function updateStepResult(stepId: string, passed: boolean, error?: string) {
  const statusEl = overlayEl?.querySelector(`.__synth_step_status[data-step-id="${stepId}"]`) as HTMLElement;
  if (!statusEl) return;

  if (passed) {
    statusEl.textContent = '✓';
    statusEl.style.color = '#2ecc71';
    statusEl.title = '';
  } else {
    statusEl.textContent = '✗';
    statusEl.style.color = '#e74c3c';
    statusEl.title = error ?? 'Failed';
  }
}

// ---- Helpers ----

function sendToBackground(action: OverlayToBackgroundMessage['action']) {
  chrome.runtime.sendMessage({
    type: 'synthetics-overlay-action',
    tabId: 0, // filled by background from sender.tab
    action,
  } as OverlayToBackgroundMessage).catch(() => {});
}

function bindEvents() {
  overlayEl?.querySelector('#__synth_stop_btn')?.addEventListener('click', () => {
    sendToBackground('stop');
  });
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getOverlayHTML(): string {
  return `
    <style>
      #${OVERLAY_ID} {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 2147483647;
        background: #1e1e2e;
        color: #cdd6f4;
        border-radius: 12px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        user-select: none;
        border: 1px solid #45475a;
        min-width: 240px;
        max-width: 360px;
      }
      #${OVERLAY_ID} .__synth_header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 16px;
        border-bottom: 1px solid #45475a;
      }
      #${OVERLAY_ID} .__synth_dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #e74c3c;
        flex-shrink: 0;
      }
      #${OVERLAY_ID} .__synth_dot.recording {
        animation: __synth_pulse 1.5s infinite;
      }
      #${OVERLAY_ID} .__synth_body {
        padding: 8px 12px;
        max-height: 300px;
        overflow-y: auto;
      }
      #${OVERLAY_ID} .__synth_step_row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 0;
        font-size: 12px;
      }
      #${OVERLAY_ID} .__synth_step_name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${OVERLAY_ID} .__synth_step_status {
        width: 16px;
        text-align: center;
        flex-shrink: 0;
        color: #6c7086;
      }
      #${OVERLAY_ID} .__synth_btn {
        border: none;
        border-radius: 6px;
        padding: 4px 10px;
        cursor: pointer;
        font-size: 12px;
        font-family: inherit;
      }
      #${OVERLAY_ID} .__synth_btn_stop {
        background: #e74c3c;
        color: white;
        margin-left: auto;
      }
      @keyframes __synth_pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }
    </style>
    <div class="__synth_header">
      <span id="__synth_status_dot" class="__synth_dot recording"></span>
      <span id="__synth_status_text">Recording</span>
      <span id="__synth_step_count" style="background:#45475a;border-radius:8px;padding:2px 8px;font-size:11px;">0 steps</span>
      <button id="__synth_stop_btn" class="__synth_btn __synth_btn_stop">Stop</button>
    </div>
    ${STEP_LIST_ENABLED ? '<div id="__synth_step_list" class="__synth_body"></div>' : ''}
  `;
}

// ---- End overlay mode block ----


}

// ── Bridge mode (OO web app page) ────────────────────────────────────────────

function initBridge(): void {
  (window as any).__ooBridgeActive = true;
  let port: chrome.runtime.Port | null = null;
  let pageOrigin = '*'; // set on first message from the page

  // Open the internal Port to the service worker. The SW's onConnect
  // listener (replaces onConnectExternal) receives this.
  function openPort(): boolean {
    // Reuse the live port. Without this, every probe opened another one: the
    // variable was overwritten, the previous Port was never disconnected, and the
    // worker kept it plus the onMessage listener registered for it. Ten probes
    // meant ten live ports, verified by counting chrome.runtime.onConnect in the
    // worker — enough of them starves the worker and the whole browser drags.
    // onDisconnect clears `port`, so a genuinely dead port still reconnects here.
    if (port) return true;

    if (!chrome?.runtime?.connect) {
      return false;
    }
    try {
      port = chrome.runtime.connect({ name: 'synthetics-recorder' });
      port.onMessage.addListener(handlePortMessage);
      port.onDisconnect.addListener(() => {
        port = null;
        // A disconnect caused by our own takeover is not news for the page — a
        // newer instance already owns the bridge.
        if (!active) return;
        window.postMessage(
          { ch: BRIDGE_CHANNEL, dir: 'to-page', nonce: '', msg: { type: 'bridge-disconnected' } },
          '*',
        );
      });
      return true;
    } catch (e) {
      port = null;
      return false;
    }
  }

  // Expose openPort so subsequent oo-bridge-probe messages can re-open
  // the port if it died (SW suspend, tab bfcache, etc.).
  __bridgeOpenPort = openPort;

  // Let the takeover handler release this port. Wrapped because an instance
  // orphaned by an extension reload has no live chrome.* APIs left to call.
  __bridgeClosePort = () => {
    try {
      port?.disconnect();
    } catch {
      // Extension context already gone; the worker has dropped the port anyway.
    }
    port = null;
  };

  // Port → Page: forward SW responses and data pushes to the OO web app
  function handlePortMessage(msg: any): void {
    // Command acks (synthetics-response): forward with the command's nonce
    if (msg?.type === 'synthetics-response') {
      window.postMessage(
        {
          ch: BRIDGE_CHANNEL,
          dir: 'to-page',
          nonce: msg._bridgeNonce ?? '',
          msg: msg.response,
        },
        pageOrigin,
      );
      return;
    }

    // Data pushes (synthetics-recorder, etc.) — forward as-is
    window.postMessage(
      { ch: BRIDGE_CHANNEL, dir: 'to-page', nonce: '', msg },
      pageOrigin,
    );
  }

  // Page → Port: forward OO web app commands to the SW
  window.addEventListener('message', (event: MessageEvent) => {
    // Guard: only accept messages from our own window (not iframes)
    if (event.source !== window) return;
    if (!active) return;
    if (event.data?.ch !== BRIDGE_CHANNEL) return;
    if (event.data?.dir !== 'to-ext') return;


    pageOrigin = event.origin;

    // Lazy-connect on first command
    if (!port && !openPort()) {
      // Extension not available — reply with null so the caller's timeout resolves
      window.postMessage(
        { ch: BRIDGE_CHANNEL, dir: 'to-page', nonce: event.data.nonce, msg: null },
        pageOrigin,
      );
      return;
    }

    // Forward the command envelope to the SW, attaching the nonce for correlation
    const envelope = {
      type: 'synthetics-command',
      command: event.data.msg?.command,
      _bridgeNonce: event.data.nonce,
    };

    // A Port whose worker has gone away throws here, and onDisconnect does not
    // always land before the next command. Reconnect once and retry rather than
    // letting the throw escape the listener and strand the caller waiting for a
    // reply that can never come — "Record" appearing to do nothing.
    try {
      port!.postMessage(envelope);
    } catch {
      port = null;
      if (!openPort()) {
        window.postMessage(
          { ch: BRIDGE_CHANNEL, dir: 'to-page', nonce: event.data.nonce, msg: null },
          pageOrigin,
        );
        return;
      }
      try {
        port!.postMessage(envelope);
      } catch {
        window.postMessage(
          { ch: BRIDGE_CHANNEL, dir: 'to-page', nonce: event.data.nonce, msg: null },
          pageOrigin,
        );
      }
    }
  });

  // Warm the port so getStatus / early commands don't pay lazy-connect latency
  openPort();
}
