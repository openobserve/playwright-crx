# Playwright 1.53.0 → 1.62.x Migration Report

**Scope:** vendored `playwright/` subtree, the `playwright-crx` adapter (`src/`), and `examples/synthetics-recorder`.
**Status:** research/planning only — no code changes.
**Date:** 2026-08-05

---

## 0. Executive summary

- Latest stable Playwright is **v1.62.1** (2026-07-29); v1.62.0 shipped 2026-07-24. Target **1.62.1** (the .1 patch fixes tsconfig-resolution and aria-snapshot regressions).
- Upstream **ruifigueira/playwright-crx is dormant**: latest release is v0.15.0 (Playwright 1.53.0, June 2025), last push to `main` Sep 2025, upgrade requests unanswered ([issue #108](https://github.com/ruifigueira/playwright-crx/issues/108), [PR #111](https://github.com/ruifigueira/playwright-crx/pull/111) closed unmerged). **There is no upstream merge to ride — we own this upgrade.**
- The maintainer left a ready-made first step: branch `merge-1.54.0` on upstream (subtree squash `dc48fee8d4` + merge `fbdbfee243`, no adaptation work).
- The only known completed upgrade is the **stevez/playwright-crx** fork (npm `@playwright-repl/playwright-crx`): 1.53 → 1.59.1, done one minor at a time (PRs [#13](https://github.com/stevez/playwright-crx/pull/13), #15, #18, #19, #20, #21) with a per-version changelog. **Caveat: it deleted the recorder app + player entirely** (PR #17, ~4,500 lines) because recorder upgrades were the painful part — and the recorder is exactly what synthetics-recorder depends on. Use it as a change map and cherry-pick source (esp. commit `f6aeffac62` and PR #14), not as a new base.
- This is a **recorder-heavy fork** (custom `SyntheticsRecorderApp`, patched injected recorder, `selectors[]` fallback capture), and the recorder backend is the subsystem upstream rewrote most (1.54) and kept churning through 1.62. That is the dominant cost.
- **Rough estimate: ~3–5 weeks of focused engineering** (one person) to land 1.62.1 across all three packages, including re-verification of synthetics capture/replay. A de-scoped stop at 1.59.1 (maximally leveraging stevez) would be ~2–3 weeks but leaves us behind again immediately.

Why upgrade at all: the 1.53-era recorder is already known to break against modern Chrome (upstream issues [#101](https://github.com/ruifigueira/playwright-crx/issues/101) — Chrome 143 recorder produces nothing; [#108](https://github.com/ruifigueira/playwright-crx/issues/108) — Chrome 146). Playwright 1.62 tracks Chromium 151.

---

## 1. Version diff: 1.53.0 → 1.62.1

| Version | Date | Chromium | Headline changes relevant to us |
|---|---|---|---|
| 1.53.0 (current) | 2025-06-10 | 138 | baseline |
| 1.54.x | 2025-07-09 | 139 | **Recorder backend rewrite**; CallMetadata→Progress migration begins; Node 16 dropped |
| 1.55.x | 2025-08-20 | 140 | MV2 extension support dropped; action `ref` model; `_toImpl` removed from ChannelOwner |
| 1.56.x | 2025-10-06 | 141 | `backgroundpage` event deprecated; MCP/zod bundle appears |
| 1.57.0 | 2025-11-25 | 143 | **`page.accessibility` removed**; Chrome-for-Testing default; SW network routing |
| 1.58.x | 2026-01-23 | 145 | `_react`/`_vue` engines removed; `:light` removed; `devtools` option removed |
| 1.59.x | 2026-03-31 | 147 | `tNumber` → `tFloat`/`tInt` validators; `pickLocator` API; Screencast API |
| 1.60.0 | 2026-05-11 | 148 | **protocol.yml split (19 files); `server/utils` → `packages/utils`; coreBundle**; several API removals |
| 1.61.x | 2026-06-15 | 149 | WebAuthn virtual authenticator (new injected script); no breaking changes |
| 1.62.x | 2026-07/24–29 | 151 | **Node ≥ 20**; channels/callMetadata `.d.ts` deleted & regenerated per side; **codegen moved to `packages/isomorphic`** |

### Notable breaking changes (public API)

- **1.54**: Node 16 removed, Node 18 deprecated ([release notes](https://playwright.dev/docs/release-notes)); `npx playwright open` no longer records.
- **1.55**: Chromium **Manifest V2 extension support dropped** (we're MV3 — fine, but any MV2 test paths die).
- **1.56**: `browserContext.on('backgroundpage')` deprecated, `backgroundPages()` returns `[]` (#37518).
- **1.57**: `page.accessibility` **removed** (#38152) — deletes `server/accessibility.ts`, `crAccessibility.ts`, and their protocol channels.
- **1.58**: `_react`/`_vue` selector engines removed; `:light` suffix removed; `devtools` launch option removed.
- **1.60**: `Locator.ariaRef()` removed; `exposeBinding()` `handle` option removed; `connect()`/`connectOverCDP()` `logger` option removed; `videosPath`/`videoSize` context options removed (#40196); CDP `port` launch option removed (#40190).
- **1.62**: **Node.js minimum ≥ 20** (engines flipped in #41497 — not headlined in release notes); Debian 11 dropped.

### Internal refactors that hit a fork hardest

1. **Recorder backend rewrite (1.54)** — `contextRecorder.ts` merged into `recorder.ts` (#36487); `recorderFrontend.ts` deleted, dependency between Recorder and RecorderApp reversed (#36544); `recorderCollection.ts` deleted for a "streaming recorder backend" (#36484); action updates moved into RecorderApp (#36523). Also renames: `params.file` → `params.fileId`, `action.snapshot` → `action.ariaSnapshot`.
2. **CallMetadata → Progress migration (1.54 onward)** — Frame/server methods take `Progress` instead of `CallMetadata` (#36429, #36439, #36455 et al.); `serverSideCallMetadata` removed; `callMetadata.d.ts` deleted entirely in 1.62.
3. **Recorder app interface changes (1.55–1.58)** — `IRecorderApp`/`EmptyRecorderApp`/`RecorderApp.factory` gone; `Recorder.show()` → `Recorder.forContext()`; recorder popup init changed (1.55); interface hardened (#38672, 1.58); action `ref` added to the recorded-action model (#36818, 1.55).
4. **Protocol restructuring** — `protocol.yml` split into `packages/protocol/spec/*.yml` (#40645, 1.60); then channel/dispatcher types split per side and `packages/protocol/src/{channels,callMetadata}.d.ts` deleted, validators moved into `packages/protocol/src` (#41321, 1.62).
5. **Directory moves** — `src/server/utils/*` → top-level `packages/utils` (#40137, 1.60); codegen generators + device descriptors → `packages/isomorphic` (#41594, 1.62); direct-import rewrite (#40102) and coreBundle build (#40074) change how playwright-core sources import each other.
6. **Injected scripts** — react/vue engines deleted (1.58); new entries `webAuthn.ts` (1.61), `ariaSnapshotDistiller.ts` (1.62); `injectedScript.ts` had 57 commits and `injected/src/recorder` 28 commits in the range.
7. **`packages/extension` (1.60, #40280)** — Playwright's own Chrome-extension driver, ported from playwright-mcp. The closest official analogue to playwright-crx; useful reference and possible long-term direction.

---

## 2. Impact on playwright-crx (this fork) and synthetics-recorder

### 2a. Our exposure surface (measured)

- **20 files inside `playwright/packages/` carry live downstream patches** (+215/−60 vs. upstream 1.53.0). The invasive ones: `server/recorder.ts` (+35/−9), `server/recorder/contextRecorder.ts` (+42/−11), `injected/src/recorder/recorder.ts` (+36/−4), `injected/src/selectorGenerator.ts` (+32/−4), `recorder/src/recorder.tsx` (+14/−3).
- `src/` deep-imports **~45 distinct playwright-core internal modules** and reaches into **~12 private fields** (`_crPages`, `_contexts`, `_browserContextId`, `_targetId`, `_page`, `_context`, `_isRecording`, `_dispatcherByGuid`, …). Two subtree patches exist solely to widen visibility (`3a999ff`, `6d8ea93`).
- Only **one openobserve commit touches the subtree**: `b9ff217` (selectors[] ranked-list capture through injected recorder → recorderCollection → actions). Everything else openobserve-specific lives in `src/server/recorder/*` and `examples/synthetics-recorder/`.

### 2b. Per-version breakage map for `src/`

| Version | What breaks in our code |
|---|---|
| 1.54 | `crxRecorderApp.ts` / `syntheticsRecorderApp.ts` implement `IRecorderApp` (file deleted); [crx.ts:141-147](../src/server/crx.ts#L141-L147) reassigns `RecorderApp.factory` (gone); `serverSideCallMetadata` used in 3 files (removed); `crxPlayer.ts` drives Frames with `CallMetadata` (now `Progress`) → **player rewrite** (stevez had to do the same); our patches to `contextRecorder.ts` and `recorderCollection.ts` must be re-implemented inside the new merged/streaming `recorder.ts` backend; `packages/recorder` app restructure moves `actions.d.ts` (aliased as `@recorder/actions` from 6 of our files + synthetics-recorder) |
| 1.55 | [index.ts:57](../src/index.ts#L57) sets `_toImpl` on the client (removed upstream — stevez restores it); recorder popup init changed → `crxRecorderApp` popup path; action `ref` model (#36818) intersects our `selectors[]` patch on the same injected-recorder code paths |
| 1.56 | New MCP/zod bundle needs Vite stubbing for the service-worker build (stevez hit this) |
| 1.57 | `Accessibility` removed → [crxZone.ts](../src/client/crxZone.ts) imports/wraps it; `isChromium` → `browserType` in `BrowserOptions` ([crx.ts:19](../src/server/crx.ts#L19) constructs one); `bidiChromium`/`bidiFirefox` leave `PlaywrightInitializer` → our validator patch in [src/protocol/validator.ts:38](../src/protocol/validator.ts#L38) and the `bidiChromium.ts` exclude in [vite.config.mts](../vite.config.mts) |
| 1.58 | Recorder-app interface hardened (#38672) → re-check `crxRecorderApp`/`syntheticsRecorderApp` conformance |
| 1.59 | `tNumber` → `tFloat`/`tInt` → [src/protocol/validator.ts](../src/protocol/validator.ts) and generated crx channels; `pickLocator` channels plumb through RecorderApp |
| 1.60 | `server/utils` → `packages/utils` breaks imports of `debugLogger`, `zones` (incl. our `c934c77` zones patch); protocol.yml split → crx protocol generation/patching re-targeted; direct-import rewrite + coreBundle → re-validate `vite.config.mts` aliases (`playwright-core/lib` → `src`) and `commonjsOptions` include/exclude paths; `exposeBinding` `handle` removal → check `PageBinding` usage |
| 1.62 | `@protocol/channels` + `@protocol/callMetadata` paths deleted (types regenerated into `client/channels.d.ts` + `server/channels.d.ts`) → rework [src/protocol/channels.ts](../src/protocol/channels.ts), [validator.ts](../src/protocol/validator.ts), both crx dispatchers; codegen moved to `packages/isomorphic/codegen` → our four codegen patches (`javascript.ts`, `language.ts`, `types.ts`, `jsonl.ts` — the `generateHeader(options, includeContext)` change) re-applied at the new location, and imports in `crx.ts`, `parser.ts`, `recorderUtils.ts`, `crxPlayer.ts`, `crxRecorderApp.ts` re-pointed; Node ≥ 20 (root `engines` currently `>=18`) |

Cross-cutting build risks:

- [vite.config.mts](../vite.config.mts) hard-codes upstream paths in `commonjsOptions.exclude` (`server/recorder/recorderApp.ts`, `server/bidi/bidiChromium.ts`) — these **silently** stop matching when upstream moves files.
- The tsconfig aliases (`@injected/*`, `@protocol/*`, `@recorder/*`, …) point into subtree `src/` dirs that move in 1.60/1.62.
- `generate:pw` runs upstream's `utils/generate_injected.js`, which gains 4 new injected entry points across the range — works, but our patched `injected/src/recorder/recorder.ts` + `selectorGenerator.ts` are baked into the generated bundles, so those merges are load-bearing at runtime.
- The CSP `unsafe-eval` guard patch in `server/javascript.ts` must be re-applied on every upgrade (stevez calls this out explicitly).

### 2c. synthetics-recorder impact

Direct imports are narrow — `playwright-crx` runtime exports plus type-only deep imports (`Mode`, `Source`, `ElementInfo` from `@recorder/recorderTypes`; `ActionInContext` from `@recorder/actions`) — so the extension's own code mostly breaks *transitively* via `SyntheticsRecorderApp`:

- `SyntheticsRecorderApp` implements the deleted `IRecorderApp` contract, calls removed `serverSideCallMetadata`, relies on our `_isRecording`-made-public patch, and consumes `crx.player` events — all rewritten territory in 1.54+.
- The **`selectors[]` fallback capture** (`b9ff217`: injected recorder → recorderCollection → `ActionWithSelector.selectors`) must be re-designed onto the 1.55+ action model (streaming backend + action `ref`), since `recorderCollection.ts` no longer exists. This is the single most bespoke piece to port.
- Replay fidelity (`crxPlayer.run` + `stepReplayStarted`/`stepReplayResult` forwarding) sits on the rewritten Progress-based player.
- `crxApp.recorder.show/hide/setMode/stop/runActions` are crx's own channel API — stable in shape, but their server implementations all change.
- Watch-out: synthetics-recorder's build is `vite build` with **no `tsc` step**, and ~10 of the exports it imports have no `.d.ts` declarations — type breakage will surface at runtime, not compile time. Recommend adding a `tsc --noEmit` gate during the migration.

---

## 3. Step-by-step migration plan

**Strategy: incremental subtree upgrades, one Playwright minor at a time**, replicating upstream's own process (`git subtree pull --squash` + adaptation commit), keeping the build green at every step. Two independent forks validate this cadence (ruifigueira's own release history; stevez's PRs #13–#21). Big-bang 1.53→1.62 would put the 1.54 recorder rewrite, the 1.60 directory moves, and the 1.62 protocol split into one unreviewable conflict pile.

**Order across the three packages:** for each version step, upgrade `playwright/` subtree + adapt `src/` together (they can't be separated — `src/` won't compile against a half-merged subtree), validate with `examples/recorder-crx` (thin consumer, cheap smoke test), and bring `examples/synthetics-recorder` along only at the checkpoints below. Full synthetics re-verification happens once at the end.

### Phase 0 — Preparation (no behavior change)

1. Baseline: confirm `npm run build` + `npm test` green on current HEAD; record results.
2. Add `microsoft/playwright` as a remote; confirm subtree mechanics against upstream's commit pattern (`Squashed 'playwright/' changes from <old>..<new>` + merge commit).
3. Export the downstream patch set as a reviewable series: `git diff bfbe7f8^2:packages HEAD:playwright/packages` (20 files, +215/−60). This is the re-application checklist for every step.
4. Bump toolchain to **Node 20** now (required by 1.62; harmless earlier). Update `engines`, CI images.
5. Optional but recommended: adopt stevez's PR #14 idea — where a subtree patch can become a monkey-patch/subclass in `src/`, move it out of the vendored tree first. Best candidates: `debug.ts` (`setUnderTest`), `channelOwner.ts` apiName hook, `debugger.ts` playing-state. The recorder/injected patches can't move (they're baked into generated bundles) — accept those as permanent merge surface.

### Phase 1 — 1.53 → 1.54 (the hard step)

6. Start from upstream's `merge-1.54.0` branch (squash `dc48fee8d4`, merge `fbdbfee243`) — the subtree pull is already done; only adaptation remains.
7. Re-implement subtree patches displaced by the recorder rewrite: `contextRecorder.ts` and `recorderCollection.ts` patches into the merged streaming `recorder.ts`; re-apply `recorder.tsx`, injected recorder, `selectorGenerator.ts`, codegen, `javascript.ts` CSP guard.
8. Adapt `src/`: replace `IRecorderApp`/`RecorderApp.factory` override with the new recorder-app wiring; `Recorder.show()` → `forContext()`; drop `serverSideCallMetadata`; **rewrite `crxPlayer` for `Progress`** (use stevez PR #13 + `f6aeffac62` as the map); renames `file`→`fileId`, `snapshot`→`ariaSnapshot`.
9. Checkpoint: build green, `tests/` pass, recorder-crx records a simple flow, synthetics-recorder builds and does a basic record/replay.

### Phase 2 — 1.55 → 1.59.1 (guided by stevez PRs #15–#21)

10. **1.55**: restore `_toImpl` shim; adapt popup init; reconcile our `selectors[]` patch with the new action-`ref` model (design decision: attach ranked selectors alongside `ref`).
11. **1.56**: stub zod/MCP bundle in Vite; note `backgroundpage` deprecation.
12. **1.57**: drop `Accessibility` from `crxZone`; `isChromium`→`browserType`; update `PlaywrightInitializer` validator patch; re-check `bidiChromium` vite exclude.
13. **1.58**: conform to hardened recorder-app interface; confirm no reliance on removed `_react`/`_vue`/`:light`.
14. **1.59.1**: `tNumber`→`tFloat`/`tInt` in `src/protocol`; regenerate crx channels; wire (or explicitly no-op) `pickLocator` channels.
15. Checkpoint: same as step 9, plus record/replay on a couple of real sites.

### Phase 3 — 1.60 → 1.62.1 (unaided; biggest structural moves)

16. **1.60**: fix all `server/utils` → `packages/utils` imports (incl. zones patch, `debugLogger`); re-target protocol generation to split spec files; re-validate vite aliases + commonjs include/exclude against the direct-import/coreBundle changes; audit removed options (`exposeBinding` handle, etc.). Budget extra time here for the build config.
17. **1.61**: mostly additive; confirm `generate_injected.js` output (new `webAuthn` entry) bundles clean.
18. **1.62.1**: rework `src/protocol/{channels,validator}.ts` + both crx dispatchers for the deleted `@protocol/channels`/`callMetadata` (types now per-side generated); re-apply codegen patches under `packages/isomorphic/codegen` and re-point 5 importing files; flip `engines` to `>=20`.
19. Checkpoint: full build, full `tests/` run.

### Phase 4 — synthetics-recorder finalization

20. Add `tsc --noEmit` to its build; declare the ~10 undeclared exports in `index.d.ts`/`types.d.ts` (or generate them).
21. Re-verify `SyntheticsRecorderApp` end-to-end on the new backend: mode changes, source forwarding, `BrowserStep` mapping, network capture, replay fidelity reporting.
22. Manual test matrix (§4), bump version, `npm run package`.

### Batching note

If per-minor feels too slow, the defensible batches are: **1.54 alone → 1.55 alone → 1.56–1.58 together → 1.59 → 1.60 → 1.61–1.62 together**. Do not batch across 1.54, 1.60, or 1.62 boundaries — each is a structural break.

---

## 4. Risk areas and manual testing

| Risk | Why | Manual test |
|---|---|---|
| **Recorder capture** (highest) | Backend rewritten 1.54; our injected-recorder + `selectors[]` patches sit on 28-commit-churn code | Record click/fill/press/select/assert flows on 2–3 real sites; verify every action carries the ranked `selectors[]` list; verify testid vs. no-testid selector choices; recorder uninstall/reinstall on re-attach |
| **Replay / crxPlayer** | Rewritten for `Progress`; drives fidelity reporting | Step-by-step replay of recorded scripts incl. navigation, iframes, popups; verify `stepReplayStarted`/`stepReplayResult` forwarding and `describeReplayFidelity` output |
| **chrome.debugger transport vs. modern Chrome** | 1.53 core already misbehaves on Chrome 143+ (upstream #101/#108); 1.62 core expects Chromium-151-era CDP | Attach/detach cycles, multi-tab, incognito (`crx.start({incognito, tabId})`), service-worker-heavy sites (upstream #104), frame-detach on attach (upstream #93) |
| **Vite/service-worker bundle** | zod/MCP bundle (1.56), coreBundle + direct imports (1.60), hard-coded exclude paths | Extension loads with no SW console errors; bundle-size sanity check; `manifest.json` unchanged |
| **CSP eval guard** | Must be re-applied each merge or evaluation breaks on strict-CSP pages | Record + replay on a strict-CSP site |
| **Codegen output** | Our `generateHeader(options, includeContext)` patch re-applied in a moved+churned subsystem | Recorded source shown in recorder UI matches pre-upgrade shape; parser round-trip (`parser.ts`) still works |
| **Silent type drift in synthetics-recorder** | No `tsc` in its build; undeclared runtime exports | Add `tsc --noEmit` (step 20) so this class of failure moves to compile time |
| **Dropped `.d.ts` patches** | `actions.d.ts`/`recorderTypes.d.ts`/`callMetadata.d.ts` additions merge without conflict but their loss only surfaces as `src/` compile errors | Full-repo `tsc` after every subtree step |

Also monitor: `packages/extension` (upstream, since 1.60) — if it matures, it may eventually replace much of the crx transport layer; not actionable now, but worth tracking before investing in further deep customization.

---

## 5. Effort estimate

Assumes one engineer familiar with the codebase, per-minor strategy, stevez fork as reference through 1.59.1.

| Phase | Estimate |
|---|---|
| Phase 0 prep (+ optional patch extraction) | 1–2 days |
| 1.54 (recorder rewrite, Progress migration, player rewrite) | 3–5 days |
| 1.55 (action ref × selectors[] reconciliation) | 1–2 days |
| 1.56–1.58 | 2–3 days |
| 1.59.1 | 1–2 days |
| 1.60 (protocol split, utils move, build config) | 3–4 days |
| 1.61 | 0.5 day |
| 1.62.1 (channels/codegen relocation, Node 20) | 3–4 days |
| synthetics-recorder finalization + manual matrix | 3–5 days |
| **Total** | **~18–28 working days ≈ 3½–5½ weeks** |

Confidence: medium. The two big unknowns are (a) how cleanly the `selectors[]` capture maps onto the streaming/ref-based action model, and (b) surprise interactions between the 1.60/1.62 build refactors and the crx Vite/shim setup — neither has a prior-art fork to copy from. If the first checkpoint (1.54) takes materially longer than 5 days, revisit scope (e.g. land 1.59.1 first, ship, then do 1.60–1.62 as a follow-up).

---

## Sources

- [Playwright release notes](https://playwright.dev/docs/release-notes) · [microsoft/playwright releases](https://github.com/microsoft/playwright/releases)
- Key upstream PRs: recorder rewrite [#36487](https://github.com/microsoft/playwright/pull/36487), [#36544](https://github.com/microsoft/playwright/pull/36544), [#36484](https://github.com/microsoft/playwright/pull/36484); action ref [#36818](https://github.com/microsoft/playwright/pull/36818); accessibility removal [#38152](https://github.com/microsoft/playwright/pull/38152); protocol.yml split [#40645](https://github.com/microsoft/playwright/pull/40645); utils move [#40137](https://github.com/microsoft/playwright/pull/40137); channel-type split [#41321](https://github.com/microsoft/playwright/pull/41321); codegen→isomorphic [#41594](https://github.com/microsoft/playwright/pull/41594); Node 20 [#41497](https://github.com/microsoft/playwright/pull/41497); extension package [#40280](https://github.com/microsoft/playwright/pull/40280)
- [ruifigueira/playwright-crx](https://github.com/ruifigueira/playwright-crx): releases, `merge-1.54.0` branch, issues #93/#101/#104/#108, PR #111
- [stevez/playwright-crx](https://github.com/stevez/playwright-crx): PRs #13–#21, #14 (patch extraction), #17 (recorder removal), commit `f6aeffac62`, CHANGELOG.md
- Local analysis: downstream delta `git diff bfbe7f8^2:packages HEAD:playwright/packages`; fork divergence `git log 3425f33..HEAD`
