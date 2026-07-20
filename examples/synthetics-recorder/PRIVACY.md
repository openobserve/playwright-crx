# Privacy Policy for OpenObserve Synthetics Recorder

**Last updated:** July 20, 2026

## Overview

The OpenObserve Synthetics Recorder ("the Extension") is a browser extension that records user interactions on web pages and replays them for automated synthetics monitoring. It is designed for developers and QA engineers using the OpenObserve observability platform.

## Data Collection

### What the Extension Records

The Extension records the following data **only while the user has explicitly started a recording session** (recording is opt-in and never automatic):

- **Browser interactions:** clicks, text input, navigation, hover events, keyboard input, and select/dropdown changes
- **Page structure:** DOM element selectors, attributes, and accessibility information needed to locate and replay interactions
- **Page URLs:** the URLs of pages visited during a recording session
- **Timing data:** timestamps and durations of recorded interactions

### What the Extension Does NOT Collect

- The Extension does **not** record or transmit any data when a recording session is not active
- The Extension does **not** collect browsing history, bookmarks, or data from tabs unrelated to an active recording
- The Extension does **not** access cookies, local storage, or other browser storage outside the scope of a recording/replay session
- The Extension does **not** collect personally identifiable information beyond what the user voluntarily enters into web forms during a recording session

## Data Transmission and Storage

### How Data Is Transmitted

Recorded interaction data is transmitted **exclusively** via the Chrome Extension local messaging API (`chrome.runtime.connect`) to the OpenObserve web application:

- Data is sent only to the OpenObserve web app running in the user's browser
- The connection is restricted to the following origins:
  - `https://*.openobserve.ai/*` (production)
  - `https://*.internal.zinclabs.dev/*` (internal)
  - `http://localhost:8081/*` and `http://localhost:5080/*` (local development)
- No data is sent to third-party servers, analytics services, or advertising networks

### How Data Is Stored

- The Extension stores **only** Chrome window identifiers in `chrome.storage.session` to track its own recording windows across service worker restarts
- No recorded interaction data, credentials, or browsing data is persisted by the Extension itself
- Recorded data that the user chooses to save is stored within the OpenObserve platform, subject to OpenObserve's own privacy and data retention policies

## Data Use

Recorded interaction data is used **exclusively** for:

1. Displaying recorded steps to the user within the OpenObserve web application
2. Replaying recorded interactions for automated synthetics monitoring
3. Generating Playwright-compatible test scripts from recorded interactions

The Extension does **not** use recorded data for:
- Advertising or marketing of any kind
- Sale to third parties
- Creditworthiness or lending determinations
- Any purpose not directly related to the Extension's single purpose of browser interaction recording and replay

## User Control

- Recording is **explicitly opt-in**: nothing is recorded until the user triggers "Start Recording" from the OpenObserve web application
- The Extension displays a visible overlay on the recording tab showing recording status, step count, and stop/play controls
- Users can stop recording at any time via the overlay or the OpenObserve web application
- The Extension can be disabled or uninstalled at any time through standard Chrome extension management

## Authentication Credentials During Replay

When a recorded journey is replayed with authentication:
- Basic authentication credentials (username/password) provided by the user are base64-encoded in memory and attached as an HTTP `Authorization` header during replay
- Credentials are held **only in memory** during the replay session and are discarded when the session ends
- The Extension does **not** persist credentials to disk, `chrome.storage`, or any other storage

## Third-Party Access

- No third parties receive data from this Extension
- The Extension bundles the Playwright CRX library, which operates entirely within the Chrome DevTools Protocol and does not make external network requests

## Children's Data

This Extension is a developer tool and is not intended for use by children under the age of 13.

## Security

- All data transmission between the Extension and the OpenObserve web app occurs via Chrome's local messaging API (not over the network)
- The Extension does not make HTTP requests to external servers
- The Extension's source code is bundled at build time and contains no remotely-loaded code

## Changes to This Policy

If data handling practices change, users will be notified through the OpenObserve platform and through an updated version of this policy.

## Compliance

This Extension complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/), including the Limited Use requirements. The Extension's use of user data is limited to the features described above and is necessary for the Extension's single purpose of recording and replaying browser interactions for synthetics monitoring.

## Contact

For questions about this privacy policy, contact the OpenObserve team at [support@openobserve.ai](mailto:support@openobserve.ai) or visit [https://openobserve.ai](https://openobserve.ai).
