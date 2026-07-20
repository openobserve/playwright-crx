# Chrome Web Store — Reviewer Notes

Paste this into the "Notes for reviewers" field during submission.

---

This extension is a browser test recorder/replayer for the OpenObserve
synthetics monitoring platform. Its single purpose: record user interactions
on any website and replay them for automated monitoring.

## Permission Justifications

### debugger (REQUIRED — core mechanism)
The extension uses the Chrome DevTools Protocol to intercept and replay user
interactions (clicks, inputs, navigation). CDP is the ONLY Chrome API that
enables full interaction recording across arbitrary websites. The extension
attaches to CDP domains including Page, Input, Runtime, and Network. No
less-privileged API can capture the full spectrum of user gestures, run
selectors, or replay interactions. The debugger API is the extension's sole
mechanism for operation, not a supplemental feature.

### tabs (REQUIRED — recording tab management)
chrome.tabs.update() at background.ts:378 navigates the recording tab to the
target URL. This requires the 'tabs' permission because the tab being updated
is in an incognito window and is not always the active tab. Without this
permission, the extension cannot set up the recording environment.

### storage (REQUIRED — owned window tracking)
chrome.storage.session is used at background.ts:322-328 to persist owned
incognito window IDs across service worker restarts. This prevents the
extension from accidentally closing the user's personal incognito windows —
the extension only closes windows whose IDs it has previously persisted.

### host_permissions: <all_urls> (REQUIRED)
The recorder must work on any website the user wants to monitor. Restricting
to specific origins would break the universal recording/replay functionality
that is the extension's single purpose.

### content_scripts: <all_urls> (REQUIRED)
The floating overlay UI must appear on any page being recorded so users can
see recording status, step count, and playback controls. The overlay is a
fixed-position DIV with no access to page content — it only displays
recording state pushed from the background service worker.

### externally_connectable
Only https://*.openobserve.ai/* — the production OpenObserve platform. The
extension is driven entirely by the OpenObserve web app via chrome.runtime.connect.
Clicking the toolbar icon has no popup; the extension opens incognito
windows programmatically in response to commands from the OpenObserve web app.

## Code Review Notes

### new Function() / CSP Compliance
The bundled background.js contains new Function() calls from two sources:

1. **Node.js polyfills** (util.inspect, events, etc.) — These are dead code
   in Chrome's service worker environment (native generators, Promises, etc.)
   and never execute.

2. **Playwright expression evaluator** (normalizeEvaluationExpression) —
   These calls validate JavaScript expressions before passing them to the
   page via CDP's Runtime.evaluate. All input is local (recorded test
   steps), never fetched from a network. Each call is wrapped in try/catch
   specifically designed for CSP-restricted environments. When CSP blocks
   the call, the catch handles it gracefully and Playwright proceeds to
   evaluate via CDP instead.

No code is loaded or executed from remote sources. The new Function() calls
take only hardcoded strings or local function references.

## Privacy

- Recording is explicitly opt-in: nothing is recorded until the user triggers
  "Start Recording" from the OpenObserve web app.
- Recorded data (interactions, URLs, form inputs) is transmitted ONLY to the
  OpenObserve web app via local chrome.runtime messaging — no network requests
  are made by the extension.
- Data is never sent to third parties, never sold, and never used for
  advertising.
- See [privacy policy URL] for full details.

## Testing

The extension is driven entirely by the OpenObserve web app — clicking the
toolbar icon does nothing (no popup, no options page). The OpenObserve web app sends
commands via chrome.runtime.sendMessage/connect, and the extension responds
by opening incognito windows, injecting a recording overlay, and streaming
recording/replay events back.

To verify the extension loads correctly: install it and check that the
service worker activates without errors in chrome://extensions. The
extension cannot be used independently without the OpenObserve web app.
