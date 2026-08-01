/**
 * Toolbar popup.
 *
 * Recording is driven entirely by the OpenObserve web app, so the extension has no
 * UI of its own. Before this popup existed, clicking the toolbar icon injected the
 * content script and reported nothing at all — the injection failure was swallowed
 * by a bare `.catch(() => {})` — which left both users and Chrome Web Store
 * reviewers with an extension that appears to do nothing when clicked.
 *
 * This makes the three states that actually matter visible: is the service worker
 * awake, is this tab bridged, and is a session already running.
 */

import { SW_PING, CONTENT_PING } from './messaging';
import type { SwPong } from './messaging';

type Tone = 'ok' | 'warn' | 'busy';

const statusEl = document.getElementById('status') as HTMLDivElement;
const dotEl = document.getElementById('dot') as HTMLSpanElement;
const hintEl = document.getElementById('hint') as HTMLParagraphElement;
const connectBtn = document.getElementById('connect') as HTMLButtonElement;
const incognitoBtn = document.getElementById('incognito') as HTMLButtonElement;

function render(tone: Tone, status: string, hint: string, showConnect: boolean): void {
  dotEl.className = `dot ${tone}`;
  statusEl.textContent = status;
  hintEl.textContent = hint;
  connectBtn.hidden = !showConnect;
  incognitoBtn.hidden = true;
}

// Extensions may open chrome://extensions, so the fix is one click away rather
// than a path the user has to find.
incognitoBtn.addEventListener('click', () => {
  void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Chrome refuses to inject into its own pages and the Web Store, and there is no
// point offering a button that can only fail.
function isInjectable(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://');
}

async function pingWorker(): Promise<SwPong | null> {
  try {
    const pong = await chrome.runtime.sendMessage(SW_PING);
    return pong?.ok ? pong as SwPong : null;
  } catch {
    return null;
  }
}

async function isTabBridged(tabId: number): Promise<boolean> {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, CONTENT_PING);
    return !!pong?.ok;
  } catch {
    // No receiving end — the content script is not in this tab.
    return false;
  }
}

async function refresh(): Promise<void> {
  const worker = await pingWorker();
  if (!worker) {
    render('warn', 'Extension not responding',
        'The background worker did not start. Reload the extension from chrome://extensions and try again.',
        false);
    return;
  }

  // Recordings always run in a separate incognito window, and Chrome grants
  // incognito access only when the user turns it on by hand. Until they do,
  // startRecording cannot succeed — so say so here rather than letting the first
  // attempt fail with a message about window creation.
  if (!(await chrome.extension.isAllowedIncognitoAccess())) {
    render('warn', 'Incognito access required',
        'Recordings run in a separate incognito window. Turn on “Allow in incognito” for this extension, then try again.',
        false);
    incognitoBtn.hidden = false;
    return;
  }

  if (worker.isReplaying) {
    render('busy', 'Replaying a journey', 'Leave this window open until the replay finishes.', false);
    return;
  }

  if (worker.isRecording) {
    const steps = `${worker.stepCount} step${worker.stepCount === 1 ? '' : 's'}`;
    // Not "press Stop in the overlay" — OpenObserve's in-page overlay is currently
    // switched off (see OVERLAY_ENABLED in content.ts), so the only control that
    // ends the session is in the OpenObserve tab.
    render('busy', `Recording — ${steps}`,
        'Interact with the incognito recording window, then stop the recording from your OpenObserve tab.',
        false);
    return;
  }

  const tab = await activeTab();
  if (!tab?.id || !isInjectable(tab.url)) {
    render('ok', 'Ready',
        'Open your OpenObserve tab and go to Synthetics to record a journey. This extension cannot run on Chrome’s own pages.',
        false);
    return;
  }

  if (await isTabBridged(tab.id)) {
    render('ok', 'Connected to this tab',
        'Go to Synthetics in OpenObserve and choose Record journey.', false);
    return;
  }

  render('warn', 'Not connected to this tab',
      'This tab was already open when the extension was installed, so it has not been connected yet.',
      true);
}

// Connect the current tab on demand. Chrome does not retroactively inject content
// scripts into tabs that were open at install time; reloading the tab also works,
// but this avoids losing whatever the user has on screen.
connectBtn.addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab?.id) return;

  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting…';
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await refresh();
  } catch (err) {
    render('warn', 'Could not connect to this tab',
        (err as Error)?.message ?? 'Chrome refused the injection. Try reloading the page instead.',
        false);
  } finally {
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect to this tab';
  }
});

void refresh();
