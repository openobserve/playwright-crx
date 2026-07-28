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
 * Maps Playwright's ActionInContext[] to BrowserStep[] for the synthetics recorder.
 */

import type { ActionInContext, Action } from '@recorder/actions';
import { buildLocatorBundle } from './locatorBundle';
import type { StepLocator } from './locatorBundle';
import { generalizeUrlPattern } from './urlPattern';
import type { SettleResponsePattern } from './networkCapture';

export type SelectorType = 'css' | 'xpath' | 'text' | 'role' | 'data-test';

export type BrowserStepAction =
  'navigate' | 'openPage' | 'click' | 'type' | 'press' | 'select' |
  'check' | 'uncheck' |
  'setInputFiles' | 'waitFor' | 'assert' | 'screenshot';

/** The v2 assertion vocabulary, mirrored from the server-side closed set. */
export type AssertionKind =
  'element_visible' | 'element_not_visible' | 'element_text' |
  'url_matches' | 'page_title' | 'element_attribute';

export interface StepAssertion {
  kind: AssertionKind;
  expected?: string;
  attribute?: string;
}

/**
 * What the page demonstrably did after this step's action.
 *
 * Recorded as evidence, not as a contract: a signal that stops arriving
 * annotates the step rather than failing the run, which is what lets a recorded
 * journey outlive the endpoint names it was recorded against.
 */
export interface StepSettle {
  navigation?: { url_pattern: string };
  responses?: SettleResponsePattern[];
  /** How long settling took while recording. Reporting only — never a timeout. */
  observed_duration_ms?: number;
}

export interface BrowserStep {
  id: string;
  action: BrowserStepAction;
  selector?: string;
  selector_type?: SelectorType;
  /**
   * Every way the recorder could find this element, ordered most-stable-first.
   * Present on every element step; `selector` remains as the primary so a v1
   * consumer keeps working unchanged.
   */
  locator?: StepLocator;
  settle?: StepSettle;
  assertion?: StepAssertion;
  /**
   * Author-set flow control. Never emitted by the recorder — they come back from
   * the step editor on replay, and the player reports that it cannot honour
   * them rather than diverging silently (P5.S.3).
   */
  optional?: boolean;
  always_run?: boolean;
  name: string;
  /**
   * Absent by design. The recorder must never stamp a timeout — a recorded value
   * encodes the recording session's timing, not the application's contract, and
   * the previous hardcoded 10000 was the direct cause of the observed production
   * failures (`locator.waitFor: Timeout 10000ms exceeded`). The runner owns
   * defaults per action category; an author may still set one in the step editor.
   * See docs/synthetics/synthetics-recorded-test-reliability-spec.md P1.1.
   */
  timeout_ms?: number;
  // Action-specific fields
  url?: string;
  value?: string;
  key?: string;
  options?: string[];
  text?: string;
  checked?: boolean;
  snapshot?: string;
  files?: string[];
  modifiers?: number;
  button?: 'left' | 'middle' | 'right';
  position?: { x: number; y: number };
  // Metadata
  startTime: number;
  endTime?: number;
  pageAlias: string;
  framePath: string[];
  description?: string;
}

function getSelectorType(selector: string): SelectorType {
  if (selector.startsWith('data-testid=') || selector.startsWith('[data-test'))
    return 'data-test';
  if (selector.startsWith('xpath='))
    return 'xpath';
  if (selector.startsWith('text='))
    return 'text';
  if (selector.startsWith('role='))
    return 'role';
  return 'css';
}

function buildStepName(action: Action, index: number): string {
  switch (action.name) {
    case 'navigate':
      return `Navigate to ${action.url}`;
    case 'openPage':
      return `Open page ${action.url}`;
    case 'click':
      return `Click on ${action.selector}`;
    case 'fill':
      return `Fill ${action.selector}`;
    case 'press':
      return `Press ${action.key} on ${action.selector}`;
    case 'select':
      return `Select in ${action.selector}`;
    case 'check':
      return `Check ${action.selector}`;
    case 'uncheck':
      return `Uncheck ${action.selector}`;
    case 'setInputFiles':
      return `Upload to ${action.selector}`;
    case 'assertText':
      return `Assert text "${action.text}" on ${action.selector}`;
    case 'assertValue':
      return `Assert value "${action.value}" on ${action.selector}`;
    case 'assertChecked':
      return `Assert ${action.checked ? 'checked' : 'unchecked'} on ${action.selector}`;
    case 'assertVisible':
      return `Assert visible ${action.selector}`;
    case 'assertSnapshot':
      return `Assert snapshot on ${action.selector}`;
    case 'closePage':
      return 'Close page';
    default:
      return action.name;
  }
}

/**
 * The settle block for one action, built from evidence Playwright already
 * collects and the recorder used to discard.
 *
 * `action.signals` carries the navigation the action caused — attached by
 * `recorderCollection` and, until now, never read. That single field is the
 * difference between a journey that sleeps for a fixed 30s and one that
 * continues the moment the page is ready.
 */
function buildSettle(
  actionInContext: ActionInContext,
  responses?: SettleResponsePattern[],
): StepSettle | undefined {
  const { action, startTime, endTime } = actionInContext;
  const settle: StepSettle = {};

  const navigation = action.signals?.find(s => s.name === 'navigation');
  if (navigation) {
    const url_pattern = generalizeUrlPattern(navigation.url);
    if (url_pattern)
      settle.navigation = { url_pattern };
  }

  if (responses?.length)
    settle.responses = responses;

  // Reporting only (P5.4 item 5): "this step normally settles in about 2s;
  // today it took 40s". Never read as a timeout by any component — a recording
  // session's timings are not the application's contract.
  if (endTime !== undefined && endTime > startTime)
    settle.observed_duration_ms = Math.round(endTime - startTime);

  return Object.keys(settle).length ? settle : undefined;
}

/**
 * The typed assertion for a recorded assert action.
 *
 * `assertValue` and `assertChecked` have no dedicated kind in the v2 set, so
 * they map onto `element_attribute`. That is exact rather than approximate: the
 * probe reads a form control's CURRENT value and checked state for those two
 * attribute names, which is what an author means by "assert this field's value"
 * and what the recorder observed when it captured them.
 */
function buildAssertion(action: Action): StepAssertion | undefined {
  switch (action.name) {
    case 'assertVisible':
      return { kind: 'element_visible' };
    case 'assertText':
      return { kind: 'element_text', expected: action.text };
    case 'assertValue':
      return { kind: 'element_attribute', attribute: 'value', expected: action.value };
    case 'assertChecked':
      return { kind: 'element_attribute', attribute: 'checked', expected: String(action.checked) };
    case 'assertSnapshot':
      // An aria snapshot is a whole subtree, not a value — there is no v2 kind
      // that means it, and inventing one that compared a snapshot loosely would
      // be a monitor that passes when the page has changed. Falls back to the
      // honest weaker claim: the element is on screen.
      return { kind: 'element_visible' };
    default:
      return undefined;
  }
}

export function mapActionToBrowserStep(
  actionInContext: ActionInContext,
  actionIndex: number,
  responses?: SettleResponsePattern[],
): BrowserStep {
  const { action, frame, startTime, endTime, description } = actionInContext;
  const selectors = (action as { selectors?: string[] }).selectors;
  const selector = (action as { selector?: string }).selector;

  const base: BrowserStep = {
    id: `s${actionIndex + 1}`,
    action: 'click', // placeholder, overridden below
    name: description ?? buildStepName(action, actionIndex),
    // No timeout_ms — see the field's doc comment. The runner decides.
    startTime,
    endTime,
    pageAlias: frame.pageAlias,
    framePath: frame.framePath,
    description,
  };

  const settle = buildSettle(actionInContext, responses);
  if (settle)
    base.settle = settle;

  const locator = buildLocatorBundle(selectors, selector);
  if (locator)
    base.locator = locator;

  switch (action.name) {
    case 'navigate':
      return { ...base, action: 'navigate', url: action.url };
    case 'openPage':
      return { ...base, action: 'navigate', url: action.url };
    case 'click':
      return {
        ...base,
        action: 'click',
        selector: action.selector,
        selector_type: getSelectorType(action.selector),
        button: action.button,
        modifiers: action.modifiers,
        position: action.position,
      };
    case 'fill':
      return {
        ...base,
        action: 'type',
        selector: action.selector,
        selector_type: getSelectorType(action.selector),
        value: action.text,
      };
    case 'press':
      return {
        ...base,
        action: 'press',
        selector: action.selector,
        selector_type: getSelectorType(action.selector),
        key: action.key,
        modifiers: action.modifiers,
      };
    case 'select':
      return {
        ...base,
        action: 'select',
        selector: action.selector,
        selector_type: getSelectorType(action.selector),
        options: [...action.options],
      };
    // X-9.3 — no longer collapsed to `click`. A click toggles a checkbox, which
    // makes the replayed journey depend on the box's starting state; `check`
    // and `uncheck` assert the state they want, so a page that starts a box
    // pre-ticked no longer silently inverts the journey.
    case 'check':
      return {
        ...base,
        action: 'check',
        selector: action.selector,
        selector_type: getSelectorType(action.selector),
      };
    case 'uncheck':
      return {
        ...base,
        action: 'uncheck',
        selector: action.selector,
        selector_type: getSelectorType(action.selector),
      };
    case 'setInputFiles':
      return {
        ...base,
        action: 'setInputFiles',
        selector: action.selector,
        selector_type: getSelectorType(action.selector),
        files: [...action.files],
      };
    case 'assertText':
      return {
        ...base,
        action: 'assert',
        selector: action.selector,
        selector_type: getSelectorType(action.selector),
        assertion: buildAssertion(action),
        text: action.text,
      };
    case 'assertValue':
      return {
        ...base,
        action: 'assert',
        selector: action.selector,
        selector_type: getSelectorType(action.selector),
        assertion: buildAssertion(action),
        value: action.value,
      };
    case 'assertChecked':
      return {
        ...base,
        action: 'assert',
        selector: action.selector,
        selector_type: getSelectorType(action.selector),
        assertion: buildAssertion(action),
        checked: action.checked,
      };
    case 'assertVisible':
      return {
        ...base,
        action: 'assert',
        selector: action.selector,
        selector_type: getSelectorType(action.selector),
        assertion: buildAssertion(action),
      };
    case 'assertSnapshot':
      return {
        ...base,
        action: 'assert',
        selector: action.selector,
        selector_type: getSelectorType(action.selector),
        assertion: buildAssertion(action),
        snapshot: action.snapshot,
      };
    case 'closePage':
      // Skip closePage — no user-facing step
      return { ...base, action: 'navigate' } as BrowserStep;
    default:
      return base;
  }
}

/**
 * Map a whole recording.
 *
 * `responsesFor` is how network evidence reaches a step: the recorder observes
 * responses on the browser context, and only this mapper knows which action's
 * window each one fell into. Absent, steps simply carry no response signals —
 * which is the correct behaviour when network capture is off, since every
 * settle signal is advisory anyway.
 */
export function mapActionsToBrowserSteps(
  actions: ActionInContext[],
  responsesFor?: (action: ActionInContext) => SettleResponsePattern[] | undefined,
): BrowserStep[] {
  return actions
      .filter(a => a.action.name !== 'closePage')
      .map((a, i) => mapActionToBrowserStep(a, i, responsesFor?.(a)));
}

// Reconstructs the Playwright Action for a BrowserStep. The forward mapper
// collapses several action names into a coarser BrowserStepAction, so we
// reconstruct the exact action.name from the step's action + which fields are
// present. Assert subtypes are fully recoverable, and check/uncheck now survive
// the round trip intact (X-9.3) rather than degrading to a click.
function buildActionFromStep(step: BrowserStep): Action {
  const selector = step.selector ?? '';
  switch (step.action) {
    case 'openPage':
      return { name: 'openPage', url: step.url ?? '', signals: [] };
    case 'navigate':
      return { name: 'navigate', url: step.url ?? '', signals: [] };
    case 'click':
      return {
        name: 'click',
        selector,
        button: step.button ?? 'left',
        modifiers: step.modifiers ?? 0,
        clickCount: 1,
        position: step.position,
        signals: [],
      };
    case 'type':
      return { name: 'fill', selector, text: step.value ?? '', signals: [] };
    case 'press':
      return { name: 'press', selector, key: step.key ?? '', modifiers: step.modifiers ?? 0, signals: [] };
    case 'select':
      return { name: 'select', selector, options: step.options ?? [], signals: [] };
    case 'check':
      return { name: 'check', selector, signals: [] };
    case 'uncheck':
      return { name: 'uncheck', selector, signals: [] };
    case 'setInputFiles':
      return { name: 'setInputFiles', selector, files: step.files ?? [], signals: [] };
    case 'assert':
      if (step.snapshot !== undefined)
        return { name: 'assertSnapshot', selector, snapshot: step.snapshot, signals: [] };
      if (step.text !== undefined)
        return { name: 'assertText', selector, text: step.text, substring: true, signals: [] };
      if (step.value !== undefined)
        return { name: 'assertValue', selector, value: step.value, signals: [] };
      if (step.checked !== undefined)
        return { name: 'assertChecked', selector, checked: step.checked, signals: [] };
      return { name: 'assertVisible', selector, signals: [] };
    default:
      // Unreplayable step (see UNSUPPORTED_REPLAY_ACTIONS). Substitute a no-op
      // rather than throwing: the throw aborted the ENTIRE replay before step 1,
      // which is why none of the production monitors — every one of which carries
      // a legacy `wait` step — could be test-replayed at all.
      //
      // 'noop' is an internal marker the player returns from immediately
      // (see CrxPlayer._performAction). It keeps the action list index-aligned
      // with the step list, which background.ts relies on to map results back to
      // step ids.
      //
      // Deliberately NOT 'pause': that action carries apiName 'page.pause' into
      // the recorder instrumentation, which puts the session into a paused state
      // and hangs the replay instead of skipping the step.
      //
      // The consumer is responsible for reporting these as "not simulated"
      // rather than as a pass — a silent green here would reproduce the
      // false-green the probe already gives `scroll`.
      return { name: 'noop', signals: [] } as unknown as Action;
  }
}

/**
 * Step actions the player cannot execute. Upstream Playwright's recorder action
 * model (ActionName in @recorder/actions) has no hover/scroll/wait/screenshot, so
 * these have never been replayable — they enter journeys only from O2's manual
 * step editor or from legacy monitors. They are retired from the v2 vocabulary;
 * this list exists so existing journeys still replay, with the step reported
 * honestly. See spec X-9 and P1.R.2a.
 */
export const UNSUPPORTED_REPLAY_ACTIONS: readonly string[] = [
  'hover',
  'scroll',
  'wait',
  'waitFor',
  'screenshot',
];

export function isUnsupportedReplayAction(action: string): boolean {
  return UNSUPPORTED_REPLAY_ACTIONS.includes(action);
}

export function mapBrowserStepToAction(step: BrowserStep): ActionInContext {
  return {
    frame: {
      pageAlias: step.pageAlias ?? 'page',
      framePath: step.framePath ?? [],
    },
    action: buildActionFromStep(step),
    startTime: step.startTime ?? 0,
    endTime: step.endTime,
    description: step.description,
  };
}

export function mapBrowserStepsToActions(steps: BrowserStep[]): ActionInContext[] {
  return steps.map((step, i) => {
    // Backward compat: the first 'navigate' step was originally an 'openPage' during
    // recording, but mapActionToBrowserStep collapses openPage → 'navigate'.
    // Restore it here so the Player creates a new page in its pageAliases before
    // navigating, rather than failing with "Internal error: page not found".
    if (i === 0 && step.action === 'navigate' && step.url)
      return mapBrowserStepToAction({ ...step, action: 'openPage' as BrowserStepAction });
    return mapBrowserStepToAction(step);
  });
}
