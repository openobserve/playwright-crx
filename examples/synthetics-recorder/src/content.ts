/**
 * Content script — injects a floating recording overlay into the target page.
 */

import type { Mode } from '@recorder/recorderTypes';
import type { OverlayMessage, OverlayToBackgroundMessage } from './messaging';
import { BRIDGE_CHANNEL } from './messaging';

// Announce presence to the OO web app. When injected on demand (toolbar
// icon click by a user who installed mid-session), this lets the web app
// auto-detect the extension without a manual "Check again".
window.postMessage({ ch: 'oo-bridge-ready' }, '*');

// ---- Context discriminator ----
//
// Default: overlay mode (recording target pages). Bridge mode activates
// only when the OO web app sends 'oo-bridge-probe' (e.g. when the user
// clicks "Record journey" or "Check again"). This avoids the recording
// tab's content script from accidentally opening a bridge port and
// stealing the single o2Port in the service worker.

let __bridgeOpenPort: (() => boolean) | null = null;

// Listen for the web app's probe. When received, switch to bridge mode
// or re-open the port if it died (SW suspend, tab backgrounding).
window.addEventListener('message', (event) => {
  if (event.source === window && event.data?.ch === 'oo-bridge-probe') {
    if (!__bridgeOpenPort) {
      console.log('[bridge] first probe — calling initBridge()');
      initBridge();
    } else {
      console.log('[bridge] subsequent probe — calling __bridgeOpenPort()');
      const result = __bridgeOpenPort();
      console.log('[bridge] __bridgeOpenPort() result:', result);
    }
  }
});

// Default: overlay mode. Runs immediately — no timer, no polling.
// The web app sends the probe on demand when it needs the bridge.
initOverlay();

// ---- bfcache-resilient fallback channel -------------------------------------
// The bridge Port dies when Chrome bfcaches the OO tab. chrome.runtime.sendMessage
// is queued and delivered on reactivation. The SW falls back to this when o2Port
// is dead. Works regardless of mode (bridge or overlay).
chrome.runtime.onMessage.addListener((message: any, _sender, _sendResponse) => {
  if (message?.type === 'oo-bridge-data') {
    window.postMessage(message.payload, '*');
  }
});

// ---- Overlay mode (recorded page) -------------------------------------------

function initOverlay(): void {
const OVERLAY_ID = '__synthetics_recorder_overlay';

let overlayEl: HTMLDivElement | null = null;
let stepListEl: HTMLDivElement | null = null;

// ---- Message listener from background ----

chrome.runtime.onMessage.addListener((message: OverlayMessage, _sender, _sendResponse) => {
  if (message.type !== 'synthetics-overlay') return;

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
  if (overlayEl) return;

  overlayEl = document.createElement('div');
  overlayEl.id = OVERLAY_ID;
  overlayEl.innerHTML = getOverlayHTML();
  document.body.appendChild(overlayEl);

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
      <button class="__synth_step_replay" data-step-id="${s.id}">▶</button>
      <span class="__synth_step_name">${escapeHtml(s.name)}</span>
      <span class="__synth_step_status" data-step-id="${s.id}">—</span>
    </div>`
  ).join('');

  stepListEl.querySelectorAll('.__synth_step_replay').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const stepId = (e.target as HTMLElement).dataset.stepId;
      if (stepId) {
        sendToBackground({ action: 'playStep', stepId });
      }
    });
  });
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

function sendToBackground(action: OverlayToBackgroundMessage['action'], stepId?: string) {
  chrome.runtime.sendMessage({
    type: 'synthetics-overlay-action',
    tabId: 0, // filled by background from sender.tab
    action,
    stepId,
  } as OverlayToBackgroundMessage).catch(() => {});
}

function bindEvents() {
  overlayEl?.querySelector('#__synth_stop_btn')?.addEventListener('click', () => {
    sendToBackground('stop');
  });

  overlayEl?.querySelector('#__synth_play_btn')?.addEventListener('click', () => {
    sendToBackground('play');
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
      #${OVERLAY_ID} .__synth_step_replay {
        background: #45475a;
        color: #cdd6f4;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 10px;
        padding: 2px 6px;
        flex-shrink: 0;
      }
      #${OVERLAY_ID} .__synth_step_replay:hover {
        background: #585b70;
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
      #${OVERLAY_ID} .__synth_btn_play {
        background: #2ecc71;
        color: white;
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
      <button id="__synth_play_btn" class="__synth_btn __synth_btn_play">▶ Play</button>
      <button id="__synth_stop_btn" class="__synth_btn __synth_btn_stop">Stop</button>
    </div>
    <div id="__synth_step_list" class="__synth_body"></div>
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
    if (!chrome?.runtime?.connect) {
      return false;
    }
    try {
      console.log('[bridge] calling chrome.runtime.connect({ name: "synthetics-recorder" })');
      port = chrome.runtime.connect({ name: 'synthetics-recorder' });
      port.onMessage.addListener(handlePortMessage);
      port.onDisconnect.addListener(() => {
        port = null;
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
    console.log('[bridge] forwarding to SW: cmd=', event.data.msg?.command?.action, ' nonce=', (event.data.nonce || '').slice(0,12));
    port!.postMessage({
      type: 'synthetics-command',
      command: event.data.msg?.command,
      _bridgeNonce: event.data.nonce,
    });
  });

  // Warm the port so getStatus / early commands don't pay lazy-connect latency
  openPort();
}
