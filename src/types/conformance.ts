/**
 * Copyright (c) Rui Figueira.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Holds the published declarations to the implementation they describe.
 *
 * `src/types/types.d.ts` is written by hand, and a hand-written declaration can lie. The
 * synthetics surface is where that already happened: ten symbols were exported from
 * `src/index.ts` and declared nowhere, and no gate noticed, because a `.d.ts` is checked
 * against its *consumers* rather than against the code it claims to describe. Adding
 * `tsc --noEmit` to the extension build closes half of that — it catches a declaration
 * that is missing or unusable. It cannot catch one that is present and wrong.
 *
 * This file is the other half. Every type O2 stores or reads is asserted structurally
 * identical to the implementation type, in both directions. Renaming a `BrowserStep`
 * field, widening `AssertionKind`, or making a required property optional now fails the
 * build here rather than in production, where the two sides simply disagree in silence.
 *
 * It deliberately does not check the opaque handles (`CrxServer`, `RecorderServer`,
 * `BrowserContextServer`). Those are declared unlike their implementations on purpose,
 * to keep playwright-core's server internals out of a published surface.
 *
 * Nothing here runs; the assertions are discharged by the type checker. `npm run build`
 * enforces it via `check:patches`, which fails on any error under `src/`.
 */

import type * as Declared from './types';

import type * as ActionMapper from '../server/recorder/actionMapper';
import type * as LocatorBundle from '../server/recorder/locatorBundle';
import type * as NetworkCapture from '../server/recorder/networkCapture';
import type * as ReplayFidelity from '../server/recorder/replayFidelity';
import type * as SyntheticsApp from '../server/recorder/syntheticsRecorderApp';
import type * as Parser from '../server/recorder/parser';

/**
 * True only when A and B are mutually assignable.
 *
 * The nested conditionals are what make this an equality rather than a subtype check: a
 * one-directional `extends` would happily accept a declaration that had quietly dropped a
 * field, which is the exact drift this file exists to catch.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Fails to compile unless the two types are structurally identical. */
function assertSameType<A, B>(_: MutuallyAssignable<A, B> extends true ? true : never): void {}

// ── Steps: the stored journey format ──
assertSameType<Declared.BrowserStep, ActionMapper.BrowserStep>(true);
assertSameType<Declared.BrowserStepAction, ActionMapper.BrowserStepAction>(true);
assertSameType<Declared.StoredStepAction, ActionMapper.StoredStepAction>(true);
assertSameType<Declared.AssertionKind, ActionMapper.AssertionKind>(true);
assertSameType<Declared.StepAssertion, ActionMapper.StepAssertion>(true);
assertSameType<Declared.StepSettle, ActionMapper.StepSettle>(true);

// ── Parsed tests: what list() reports ──
assertSameType<Declared.CrxTestOptions, Parser.TestOptions>(true);
assertSameType<Declared.CrxTestContextOptions, Parser.TestBrowserContextOptions>(true);

// ── Locators: the step's identity ──
assertSameType<Declared.StepLocator, LocatorBundle.StepLocator>(true);
assertSameType<Declared.LocatorCandidate, LocatorBundle.LocatorCandidate>(true);
assertSameType<Declared.LocatorKind, LocatorBundle.LocatorKind>(true);
assertSameType<Declared.CompositeRelation, LocatorBundle.CompositeRelation>(true);
assertSameType<Declared.CompositePart, LocatorBundle.CompositePart>(true);

// ── Network evidence ──
assertSameType<Declared.SettleResponsePattern, NetworkCapture.SettleResponsePattern>(true);

// ── Replay fidelity ──
assertSameType<Declared.StepFidelity, ReplayFidelity.StepFidelity>(true);
assertSameType<Declared.FidelityLevel, ReplayFidelity.FidelityLevel>(true);

// ── Replay progress and errors, as forwarded to the host ──
assertSameType<Declared.StructuredError, SyntheticsApp.StructuredError>(true);
assertSameType<Declared.StepStartedData, SyntheticsApp.StepStartedData>(true);
assertSameType<Declared.StepResultData, SyntheticsApp.StepResultData>(true);
assertSameType<Declared.SyntheticsForwardMessage, SyntheticsApp.SyntheticsForwardMessage>(true);

// ── Function signatures ──
// Checked by assignability rather than equality: a declaration that accepts what the
// implementation accepts and returns what it returns is correct, even where the declared
// parameter types are the curated public ones.
const _mapActionsToBrowserSteps: typeof ActionMapper.mapActionsToBrowserSteps = null as unknown as typeof Declared.mapActionsToBrowserSteps;
const _mapBrowserStepsToActions: typeof ActionMapper.mapBrowserStepsToActions = null as unknown as typeof Declared.mapBrowserStepsToActions;
const _mapActionToBrowserStep: typeof ActionMapper.mapActionToBrowserStep = null as unknown as typeof Declared.mapActionToBrowserStep;
const _mapBrowserStepToAction: typeof ActionMapper.mapBrowserStepToAction = null as unknown as typeof Declared.mapBrowserStepToAction;
const _describeReplayFidelity: typeof ReplayFidelity.describeReplayFidelity = null as unknown as typeof Declared.describeReplayFidelity;
const _describeStepFidelity: typeof ReplayFidelity.describeStepFidelity = null as unknown as typeof Declared.describeStepFidelity;
const _replayFidelityWarnings: typeof ReplayFidelity.replayFidelityWarnings = null as unknown as typeof Declared.replayFidelityWarnings;
const _setLocatorTestIdAttribute: typeof LocatorBundle.setLocatorTestIdAttribute = null as unknown as typeof Declared.setLocatorTestIdAttribute;

void _mapActionsToBrowserSteps;
void _mapBrowserStepsToActions;
void _mapActionToBrowserStep;
void _mapBrowserStepToAction;
void _describeReplayFidelity;
void _describeStepFidelity;
void _replayFidelityWarnings;
void _setLocatorTestIdAttribute;
