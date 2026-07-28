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
 * What the in-browser preview does NOT do, said out loud.
 *
 * The player and the probe are different engines (D-7). The player exists to let
 * an author sanity-check a journey in seconds; it does not implement locator
 * fallback, settling, advisory signals or step-level flow control, and it never
 * will — reimplementing them would create a second runner whose divergences
 * nobody could keep track of.
 *
 * The danger that creates is specific and worth stating: a green preview implies
 * a green run. Worse, a sleep-free journey can replay FASTER than the
 * application responds and fail the preview on a step the probe would pass
 * (P3.S.1). An author reading that as a step problem will re-add a sleep — which
 * is precisely the regression this whole design exists to remove, reintroduced
 * through the preview. So every gap is reported per step, and no skipped step
 * may ever render as a pass.
 */

import type { BrowserStep } from './actionMapper';
import { isUnsupportedReplayAction } from './actionMapper';

export type FidelityLevel = 'exact' | 'approximate' | 'not_simulated';

export type StepFidelity = {
  /** Aligned with the player's `actionIndex`. */
  stepIndex: number;
  stepId: string;
  level: FidelityLevel;
  notes: string[];
};

const SEVERITY: Record<FidelityLevel, number> = {
  exact: 0,
  approximate: 1,
  not_simulated: 2,
};

/**
 * Assertion kinds the player can evaluate with an `expect` it already has
 * (P5.S.1).
 *
 * Labelled `approximate` rather than `exact` because the two engines genuinely
 * disagree today: the player uses `to.have.text` with substring matching, the
 * probe uses filtered visibility. **The probe's definition is normative** — a
 * green here is encouraging, not authoritative.
 */
const NATIVELY_EVALUATED_ASSERTIONS = new Set(['element_visible', 'element_text']);

function worst(levels: FidelityLevel[]): FidelityLevel {
  return levels.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'exact' as FidelityLevel);
}

/**
 * Describe one step's replay fidelity.
 *
 * Exported separately so the reasoning for a single step can be unit-tested
 * without constructing a whole journey.
 */
export function describeStepFidelity(step: BrowserStep, stepIndex: number): StepFidelity {
  const notes: string[] = [];
  const levels: FidelityLevel[] = [];

  if (isUnsupportedReplayAction(step.action)) {
    notes.push(`"${step.action}" has no equivalent in the player and was skipped — this step was not simulated.`);
    levels.push('not_simulated');
  }

  // Both spellings: a stored v2 step says `upload` (X-9.1), the recorder's own
  // in-memory step says `setInputFiles`. Checking only the latter let a reloaded
  // journey's upload step through unreported (P2.S requires `not simulated`).
  if (step.action === 'setInputFiles' || step.action === 'upload') {
    // crxPlayer rejects setInputFiles outright; reporting the step as a pass
    // would be a false green about a file that was never uploaded.
    notes.push('File uploads are not simulated in the preview.');
    levels.push('not_simulated');
  }

  const candidates = step.locator?.candidates ?? [];
  if (candidates.length > 1) {
    notes.push(
        `Primary locator only: the preview used ${candidates[0].value} and did not try the ` +
        `${candidates.length - 1} fallback${candidates.length === 2 ? '' : 's'} the probe would.`);
    levels.push('approximate');
  }

  if (step.settle) {
    const required = (step.settle.responses ?? []).filter(r => r.required);
    notes.push('Settle not simulated: the preview does not wait for the navigation or API calls this step recorded.');
    levels.push('not_simulated');
    if (required.length) {
      // P4.S.1 — an author who deliberately escalated a signal must not be shown
      // a green preview that never evaluated it.
      notes.push(
          `${required.length} required signal${required.length === 1 ? ' was' : 's were'} not evaluated at all: ` +
          required.map(r => `${r.method ? `${r.method} ` : ''}${r.url_pattern}`).join(', '));
    }
  }

  if (step.assertion) {
    if (NATIVELY_EVALUATED_ASSERTIONS.has(step.assertion.kind)) {
      notes.push(`Assertion evaluated approximately — the probe's definition of "${step.assertion.kind}" is the normative one.`);
      levels.push('approximate');
    } else {
      notes.push(`Assertion "${step.assertion.kind}" is not simulated: the player has no equivalent check.`);
      levels.push('not_simulated');
    }
  }

  if (step.optional || step.always_run) {
    // P5.S.3 — the player rethrows and aborts on the first failing step, so it
    // cannot honour either flag. Saying so beats diverging silently.
    notes.push('Flow control not simulated: the preview stops at the first failure regardless of "optional" or "always run".');
    levels.push('not_simulated');
  }

  return { stepIndex, stepId: step.id, level: worst(levels), notes };
}

/** Fidelity for a whole journey, one entry per step, in replay order. */
export function describeReplayFidelity(steps: BrowserStep[]): StepFidelity[] {
  return steps.map((step, i) => describeStepFidelity(step, i));
}

/** Only the steps with something to say — what a UI actually renders. */
export function replayFidelityWarnings(steps: BrowserStep[]): StepFidelity[] {
  return describeReplayFidelity(steps).filter(f => f.notes.length > 0);
}
