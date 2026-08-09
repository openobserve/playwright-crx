# Design: a test suite for the synthetics-recorder extension

**Status:** proposal
**Author:** drafted 2026-08-09, from measurements taken during the Playwright 1.53 → 1.54 migration
**Scope:** `examples/synthetics-recorder` (the shipped extension) and the shared harness it uses in `tests/crx`

---

## 1. Why now

The 1.54 migration is the evidence. Upstream's recorder rewrite broke ten separate behaviours
with **zero compile-time signal** — recording produced no code, Resume was permanently
disabled, stepping ran the whole journey, failing assertions replayed as passes. The existing
browser suite caught every one of them, which is the strongest argument possible for keeping
it. But it caught them *slowly*, and it said nothing at all about the extension's own 1,672
lines of orchestration, because nothing tests those directly.

Measured state today:

| | |
|---|---|
| Tests total | **230** |
| Pure unit tests (`synthetics-v2-capture`) | **59**, running in **65 ms total** |
| Browser-integration tests | **171** |
| Synthetics browser tests | **17**, running in **187 s** |
| Extension source (`background/content/messaging/popup`) | **1,672 LOC** |
| Unit tests over that 1,672 LOC | **0** |
| Typecheck over that 1,672 LOC | **none** — its build is `vite build`, no `tsc` |
| Type errors currently hiding there | **17** |

The asymmetry is the whole problem: a 59-test unit layer costs 65 ms and pins the *pure*
capture logic precisely, while the module that owns the actual product lifecycle —
`background.ts`, 774 lines, 13 pieces of mutable module state — is reachable only through
17 tests that take three minutes and are the flakiest in the repo.

## 2. Goals / non-goals

**Goals**

1. Make a broken `background.ts` fail in **seconds**, not three minutes — and fail *pointing at
   the cause*.
2. Keep the real-Chrome, real-extension tests, and make them **cheaper to write** and
   **less flaky**.
3. Make protocol drift between O2 and the extension impossible to merge unnoticed.
4. Get a typecheck gate over the extension.

**Non-goals**

- Chasing a coverage percentage. The target is *confidence in the flows that matter*, not a number.
- Replacing the browser tests with mocks. They are what caught the 1.54 breakage; mocks would not have.
- Rewriting `background.ts`. The extraction proposed below is additive and mechanical.

## 3. The blocker nobody has worked around yet

**None of the three entry files export anything.** All are side-effecting scripts that run
their bootstrap at import:

| File | Self-executes at import | Exports |
|---|---|---|
| `background.ts` | `init()` — registers 4 `chrome.*` listeners (`:774`) | none |
| `content.ts` | `dispatchEvent(TAKEOVER)` (`:33`), `install()` (`:48`) | none |
| `popup.ts` | `document.getElementById` ×5 at module scope (`:19–23`), `refresh()` (`:148`) | none |
| `messaging.ts` | — | types + 5 string consts |

Import any of them from a spec and it throws (`chrome is not defined`, or null DOM handles)
before a single assertion runs. **That, not a missing framework, is why there are no unit
tests** — `messaging.ts` is the only importable module and it has no runtime logic to test.

The tooling is not the obstacle: Playwright's runner already transpiles TS, and
`synthetics-v2-capture` already imports product code directly
(`from '../../src/server/recorder/locatorBundle'`).

**Everything below follows from making the logic import-safe.**

## 4. Target shape

```
        ┌─────────────────────────────────────────────┐
  few   │  L3  real Chrome + real extension (~20)     │  minutes   keep, make cheaper
        ├─────────────────────────────────────────────┤
        │  L2  contract tests (~15)                   │  seconds   new
  many  │  L1  unit tests over extracted logic (~60)  │  millis    new
        └─────────────────────────────────────────────┘
```

L1 and L2 are new. L3 exists and stays — it is the only layer that can prove the extension
works against a real `chrome.debugger` and a real page, which is exactly what the 1.54
migration needed.

---

## 5. L1 — unit tests over extracted logic

### 5.1 The extraction

Move decision logic out of the entry scripts into import-safe modules under
`examples/synthetics-recorder/src/lib/`. No behaviour change; the entry files import them back
and keep their `chrome.*` wiring. Ordered by value, with the seam that makes each testable:

| Extract | From | Why it is worth testing |
|---|---|---|
| `computeReplayOffset(steps)` + `mapReplayIndex(actionIndex, offset, steps)` | `background.ts:657`, `:309–311`, `:327–329` | **The single highest-risk line in the extension.** `replayActionOffset` is one boolean guess about whether step 0 becomes an action. Guess wrong — a journey starting with two navigates, or a navigate with no url — and *every* streamed `stepId` shifts by one, silently attributing results to the wrong step. Needs no chrome fake at all. |
| `buildReplayContext(auth, headers, cookies, initialUrl)` | `background.ts:663–691` | Basic-auth `btoa` encoding, extra headers, cookie `storageState` with a `new URL(...).hostname` fallback. Pure, security-adjacent, currently untested. |
| `onRecorderMessage(state, msg)` | `handleRecorderMessage` (`:244–360`, ~126 lines) | The recorder → O2 translation. The thing 1.54 broke repeatedly. |
| `routeO2Command(command, handlers, state)` | `runO2Command` (`:171–209`) | Pins the whole O2 command surface. |
| `decideState(worker, incognitoAllowed, tab, bridged)` | `popup.ts` `refresh` (`:70–124`) | Six exclusive branches in priority order → a 7-case table test. |
| `describeMode(mode)` | `content.ts:286–298` | 9 modes + fallback, currently trapped inside a DOM writer. |

Plus five functions that need **only an `export` keyword** to become testable as-is:
`firstNavigateUrl` (`bg:631`), `resolveTestIdAttr` (`bg:64`), `isInjectable` (`popup:46`),
`getOverlayHTML` (`content:363`), `escapeHtml` (`content:357`, needs jsdom).

Guideline: a function moves to `lib/` when its decision is deterministic given its inputs.
Anything that must *call* `chrome.*` stays put and becomes a thin caller.

### 5.2 State goes in a parameter, not a module

The 13 module-level `let`s (`background.ts:22–53`) are why behaviour depends on what ran
before. Extracted modules take state as an argument and return the next state, so a test can
construct any situation directly instead of driving the extension into it:

```ts
// lib/stepForwarding.ts
export function onRecorderMessage(state: RecordingState, msg: SyntheticsForwardMessage)
  : { state: RecordingState; outgoing: ExtensionToO2Payload[] }
```

`background.ts` keeps the mutable variables and threads them through. That is the whole change.

### 5.3 Where they live and how they run

`tests/unit/synthetics/*.spec.ts`, run by **`@playwright/test`** — the runner already in use, so
**no new dependency**. This is exactly how `synthetics-v2-capture` works today (59 tests, 65 ms,
no browser launched because no browser fixture is touched).

A second Playwright project keeps them separable:

```ts
// tests/playwright.config.ts
{ name: 'unit', testDir: './unit', use: {} }   // no browser fixtures → nothing launches
```

so `npx playwright test --project=unit` is a sub-second feedback loop, and CI can run it as a
gate before spending sixteen minutes on browsers.

### 5.4 What to assert

Not line coverage — the decisions that have actually broken:

- a `setActions` message produces one `BrowserStep` per action, ranked locator candidates preserved, test-attribute first
- a step result maps to the **step it belongs to** across `replayActionOffset` — including the
  cases the current heuristic guesses at: a journey whose first step is not a navigate, one with
  two leading navigates, and a navigate with no url
- `stopRecording` with zero steps still emits `recordingStopped { totalSteps: 0 }`
- `resolveTestIdAttr(undefined)` → `data-testid`; an explicit attr wins
- window ownership never returns a window id the extension did not open

---

## 5.5 Latent defects the mapping already surfaced

Mapping the seams found real problems **without running anything**. Each is cheap to pin once
the logic is import-safe, and each is invisible to the current suite. This is the concrete
answer to "would these tests have earned their keep?":

1. **`stepId` fallback ignores the offset.** The lookup uses
   `replaySteps[actionIndex + replayActionOffset]` (`bg:309`) but the fallback id is
   `` `s${actionIndex + 1}` `` (`bg:311`) — no offset. When the lookup misses, the reported id is
   off by one and a result is attributed to the wrong step.
2. **An unknown command strands the caller forever.** `runO2Command`'s default (`bg:208`)
   returns `false` and never calls `respond`, so the O2 page waits on a nonce that will never
   be answered — until its own 60 s timeout.
3. **The reconnect buffer mixes two message shapes.** `pendingBridgeResponses` holds both
   `synthetics-response` envelopes (`:161`) and raw data pushes (`:759`, `:767`), and replays
   both verbatim on reconnect (`:121–124`). `content.ts:516` only special-cases the former, so
   replayed pushes arrive with `nonce: ''`.
4. **Type/impl drift is already present.** `ExtensionToO2Payload` declares `method: 'setMode'`
   (`messaging:49`) but background never sends it — `setMode` goes to the overlay only. Exactly
   what an L2 contract test exists to prevent.
5. **`recordingId!` is asserted non-null in three places** (`:265`, `:279`, `:559`) while three
   others use `?? ''` fallbacks (`:297`, `:316`, `:333`). A recorder message arriving after
   `stopRecording` clears the id (`:568`) sends `undefined` as `recordingId`.
6. **Badge set is tab-scoped, clear is global.** `setBadgeText({ text, tabId })` (`:530`) vs
   `setBadgeText({ text: '' })` (`:578`).
7. **Dead paths that should be asserted or deleted:** `'oo-bridge-data'` is handled
   (`content:74`) but never sent; `STEP_LIST_ENABLED` is `false` (`content:197`), making
   `updateStepList`/`updateStepResult` unreachable in practice.

None of these needs a browser to prove. Items 1–3 are the ones that can corrupt a customer's
recorded journey or hang the O2 UI.

## 6. L2 — contract tests

`messaging.ts` already declares the O2 ↔ extension protocol as discriminated unions
(`O2Command`, `ExtensionToO2Payload`, `ReplayResponse`). Nothing enforces that what the
extension *sends at runtime* still matches, and a silent shape change there breaks the O2 web
app with no failing test on either side.

Add a narrow runtime validator per payload `method` and assert:

1. **every** payload the extension emits validates (drive with L1 fixtures — no browser needed);
2. every `O2Command` variant is accepted by the router;
3. an unknown command is rejected rather than silently ignored.

Cheap, fast, and it turns "the O2 app broke after an extension release" into a red test in CI.

---

## 7. L3 — real Chrome, real extension

Keep. Improve three things.

### 7.1 One shared fixture instead of copy-paste

`sendCommand` is currently **duplicated across 4 spec files**, and the synthetics specs carry
**~700 lines of preamble** between them (35–172 lines each) before the first `test(`. Every new
test pays that tax, and a harness fix has to be applied four times.

Extract `tests/crx/syntheticsTest.ts` — a fixture built on the existing `crxTest`, exposing what
the specs actually do:

```ts
export const test = crxTest.extend<{ o2: O2Bridge }>({ /* ... */ });
// o2.sendCommand(cmd)   o2.startRecording(url)   o2.steps()   o2.waitForStep(pred)
```

The retry-on-cold-service-worker logic already written in `synthetics-v2-recording.spec.ts:81`
lives there once, correctly, instead of in whichever spec remembered it.

### 7.2 Cover the flows that have no L3 test

Current 17 synthetics browser tests skew toward capture. Missing, and each is a real user
journey:

- replay **failure** reporting end to end (a step that genuinely fails → `stepReplayResult { passed: false }` with a structured error reaching O2)
- **stop mid-replay** (partly covered by `synthetics-replay-stop`, not for the in-flight-action case)
- recording across a **cross-origin navigation**
- extension **reload / service-worker restart** mid-session — the MV3 failure mode most likely to bite in production
- popup ↔ background state agreement

### 7.3 Make them honest about flakiness

Measured this session: at the configured `workers: 2` this machine reaches load average 7+ and
produces uniform 30-second timeouts in specs unrelated to any change; **four tests** were
confirmed to fail in batch and pass alone. With `retries: 0` locally, a flake reads exactly like
a real failure — which cost real time during the migration.

- Give L3 its own Playwright project with `workers: 1` (browser tests are not the parallelism win; L1 is).
- Keep `retries: 2` in CI, and record flakes rather than hiding them.
- Add teardown that kills orphaned browsers: a killed run leaves headed Chromes holding user-data-dirs, and **52 orphans** were found after one aborted run — they then fail the *next* run and look like product bugs.

The extension's own wall-clock hazards set the floor on L3 duration, so they are worth knowing
before blaming the harness: tab-population polling is 20 × 250 ms (**5 s** worst case,
`bg:469`), overlay re-projection retries 5 × 200 ms (`bg:602`), and the service-worker wake
does 3 attempts at 250/500/750 ms (**~1.5 s**, `content:139`). A failing L3 test pays all
three. Another argument for pushing logic down to L1 rather than adding L3 cases.

---

### 7.4 Decision: no Chrome API fake — ever

**Settled.** Anything that touches `chrome.*` is tested against a real headed Chrome running
the real extension. Nothing is faked.

For the record, faking that tier would have meant standing up: `runtime`
(onConnect/onMessage/sendMessage/connect/Port), `tabs`
(query/update/sendMessage/create/onRemoved/onUpdated), `windows`
(create/get/remove/update/getLastFocused), `storage.session`, `action`,
`extension.isAllowedIncognitoAccess`, `scripting.executeScript` — plus doubles for
`crx.start`, `Crx.recorderAppFactoryOverride`, `mapBrowserStepsToActions` and
`describeReplayFidelity`.

That surface is both large and *load-bearing*: a fake would have to encode our beliefs about
MV3 worker eviction, incognito window ownership and `chrome.debugger` attach semantics — the
exact beliefs that turned out to be wrong during the 1.54 upgrade. A fake that matches our
assumptions passes while the product is broken. So the split is:

- **L1** covers logic that is deterministic given its inputs and needs *no* chrome API at all
  (it is pure, not faked — `computeReplayOffset`, `buildReplayContext`, `describeMode`, …).
- **L3** covers everything else, against a real browser.

There is no middle tier, by choice.

## 8. Typecheck gate

`examples/synthetics-recorder/package.json` builds with `vite build` only, while its sibling
`recorder-crx` uses `tsc && vite build`. Align them:

```json
"build": "tsc && vite build && vite build --config vite.content.config.ts"
```

This currently surfaces **17 errors**, ~10 of them runtime exports imported from `playwright-crx`
with no `.d.ts` declaration (`SyntheticsRecorderApp`, `BrowserStep`, `StepFidelity`, …). Fixing
those means declaring the public surface the extension actually consumes — worth doing on its
own merits, and already tracked as Phase 4 of the upgrade.

---

## 9. Delivery order

Each step is independently useful; stop after any of them and you are ahead.

| # | Step | Effort | Unlocks |
|---|---|---|---|
| 1 | `tsc` gate + declare missing types | 0.5–1 d | type drift caught at build |
| 2 | `unit` project + export the 5 already-pure fns + extract `computeReplayOffset`/`mapReplayIndex` | 0.5 d | the loop exists, and **the highest-risk logic is pinned first** (defect #1) |
| 3 | Extract `onRecorderMessage` + `buildReplayContext` + ~25 unit tests | 1–2 d | **the core translation and the auth/cookie encoding are pinned** |
| 4 | `syntheticsTest.ts` shared fixture; de-duplicate 4 specs | 1 d | ~700 lines of preamble deleted |
| 5 | Contract tests (L2) | 0.5–1 d | protocol drift impossible to merge |
| 6 | New L3 flows (§7.2) | 1–2 d | SW restart + replay failure covered |
| 7 | Split projects, `workers: 1` for L3, orphan teardown | 0.5 d | a suite that can reach green |

**Total ≈ 5–8 days.** Steps 1–3 deliver most of the confidence.

Sequencing note: doing this **before** Phase 2 of the Playwright upgrade (1.55 → 1.59) would pay
for itself. Every defect the 1.54 step surfaced was found by running browsers for sixteen
minutes; steps 1–3 turn a meaningful share of that into a sub-second signal, four more times.

## 10. Risks

- **Extraction changes behaviour by accident.** Mitigate by moving code verbatim, one module per
  commit, with the L3 suite green before and after. No refactor-and-improve in the same commit.
- **Unit tests calcify the wrong shape.** Mitigate by asserting on the O2-visible payload
  (`BrowserStep`, `ExtensionToO2Payload`) rather than internals — the contract, not the plumbing.
- **The suite still cannot reach green**, so new reds stay invisible. The two stale
  `synthetics-v2-recording` tests assert on `BrowserStep.selector`, a field v2 deliberately
  removed; they have been red long enough that nobody notices. Fix them (find by
  `locator.candidates[0].value`) as part of step 4 — **a suite that is never green cannot tell
  you when you broke something.**

## 10a. Status — what has been built (2026-08-09)

Steps 4 and 6 of the delivery plan are done, and they paid for themselves immediately.

| Built | Result |
|---|---|
| `tests/crx/syntheticsTest.ts` — shared real-Chrome fixture (`o2` bridge) | no `chrome.*` faked; consolidates the `sendCommand` copied byte-identically into 4 specs |
| `tests/crx/synthetics-lifecycle.spec.ts` — 5 new L3 tests | **5/5 green**: replay failure, stop-mid-replay, cross-origin navigation, MV3 worker teardown, unknown command |
| `synthetics-v2-recording` migrated onto the fixture | **247 → 126 lines**, 3/3 green (2 were red at baseline) |
| Stale `step.selector` lookups replaced with `findStep()` | the v1 field BrowserStep records as having "went with version 1 (Phase 2c)" |

**Two product defects found and fixed by writing these tests:**

1. **Unresponsive unknown command** (predicted as latent defect #2 above). `runO2Command` fell
   through without calling `respond()`, stranding the O2 page on a nonce until its own 60 s
   timeout. The test went 12.8 s (timing out) → 2.8 s once fixed.
2. **Journeys recorded no network wait conditions at all.** Every step had an empty
   `settle.responses` — the core of v2 capture, silently producing nothing. A regression from
   the 1.54 adaptation: 1.53's `Recorder.show(context, factory, params)` built the app *while
   installing*, so it heard the initial `openPage`; 1.54's `forContext()` + `_createRecorderApp()`
   emits it before anything subscribes, leaving `_journeyOrigin()` undefined — and `setActions`
   skips settle computation entirely without an origin.

The second one is the argument for this whole design, stated as an event rather than a
prediction: it was **hidden behind the stale tests**. They died on the `selector` lookup long
before reaching the settle assertions, so the defect shipped invisibly. A suite that is never
green cannot tell you when you broke something.

**Suite state:** 219 passed / 4 failed, versus 196 / 19 at the migration baseline —
**15 of the 19 baseline failures fixed, zero regressions** (verified by diffing the failing
sets).

## 11. How we will know it worked

- A deliberately broken `handleRecorderMessage` fails a unit test in **< 5 s**, naming the behaviour.
- The synthetics suite is **green**, not "green except the known four".
- Writing a new L3 test needs **no copied helpers**.
- The next Playwright upgrade finds its first defects in the unit layer, not after a 16-minute run.

---

### Appendix — evidence

All figures measured on this branch, 2026-08-08/09:

- unit vs integration cost: 59 unit tests **65 ms** total (42 of them 1 ms); synthetics browser tests **187 s** for 17
- full serial suite: **212 passed / 6 failed**, 16.6 min, reproduced twice
- helper duplication: `sendCommand` defined in **4** spec files; preamble 35/41/92/117/122/133/172 lines
- `background.ts`: **13** module-level mutable variables (`:22–53`), `init()` at import (`:774`)
- extension typecheck: **17** errors, currently ungated
