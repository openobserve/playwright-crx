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

import type { ActionInContext, Action } from '@isomorphic/codegen/actions';
import { buildLocatorBundle, effectiveSelector } from './locatorBundle';
import type { StepLocator } from './locatorBundle';
import { generalizeUrlPattern } from './urlPattern';
import type { SettleResponsePattern } from './networkCapture';

export type BrowserStepAction =
  'navigate' | 'openPage' | 'click' | 'hover' | 'type' | 'press' | 'select' |
  'check' | 'uncheck' |
  'setInputFiles' | 'waitFor' | 'assert' | 'screenshot';

/**
 * The stored spellings that only ever arrive, never leave.
 *
 * A journey saved and reloaded comes back in the version-2 vocabulary (X-9.1), where
 * `fill` is the name for `type` and `upload` for `setInputFiles`. The recorder emits the
 * internal names and O2 stores the v2 ones, so `BrowserStep.action` legitimately carries
 * either — see V2_ACTION_ALIASES, which has always accepted both by keying on `string`.
 *
 * They were missing from the type, which made `step.action === 'upload'` in
 * describeStepFidelity a comparison TypeScript called impossible. It was not impossible;
 * it was the check that keeps a reloaded upload from replaying as a false green. The
 * tests covering both spellings had to cast through `as any` to say so.
 */
export type StoredStepAction = 'fill' | 'upload';

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
  action: BrowserStepAction | StoredStepAction;
  /**
   * Every way the recorder could find this element. This IS the step's identity:
   * the bare `selector` and `selector_type` pair beside it was the version-1
   * channel, and went with version 1 (Phase 2c). `selector_type` was also a
   * second, older classifier — `data-test`/`xpath`/`text`/`role`/`css` — sitting
   * beside classifySelector's weakest-link rule and disagreeing with it.
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
  /**
   * How many clicks the recorded interaction was. Absent means one.
   *
   * Carried because 1.56's action picker offers "Double click" as an explicit
   * choice, and the reverse mapper used to hardcode 1 — so a deliberately
   * recorded double click replayed as a single one and still reported green.
   * `toClickOptions` has always forwarded clickCount > 1; only the mapping
   * starved it.
   */
  clickCount?: number;
  position?: { x: number; y: number };
  // Metadata
  startTime: number;
  endTime?: number;
  pageAlias: string;
  framePath: string[];
  description?: string;
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

  // The LAST one, not the first. An action now carries one navigation signal per hop of a
  // redirect chain or SPA route change, because they are absorbed onto the action that
  // caused them rather than each becoming a step. The first names an intermediate URL the
  // page did not stay on; the last is where it came to rest, which is the only one worth
  // waiting for.
  const navigation = action.signals?.findLast(s => s.name === 'navigation');
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

/**
 * Names pages the way a journey reads: the first page is `page`, the next `page1`, and so
 * on in the order they were opened.
 *
 * 1.62 removed `frame` from ActionInContext — an action now carries only an opaque
 * `pageGuid`. A guid is stable but meaningless in a stored step and to anyone reading one,
 * so it is turned back into an alias here, with the same first-seen scheme upstream's own
 * code generator uses. The map is per call to mapActionsToBrowserSteps, so a journey's
 * names do not depend on anything outside it.
 */
function aliasAssigner(): (pageGuid: string) => string {
  const aliases = new Map<string, string>();
  return pageGuid => {
    let alias = aliases.get(pageGuid);
    if (!alias) {
      alias = 'page' + (aliases.size || '');
      aliases.set(pageGuid, alias);
    }
    return alias;
  };
}

export function mapActionToBrowserStep(
  actionInContext: ActionInContext,
  actionIndex: number,
  responses?: SettleResponsePattern[],
  aliasFor: (pageGuid: string) => string = aliasAssigner(),
): BrowserStep {
  const { action, startTime, endTime } = actionInContext;
  // 1.62 dropped `description` from ActionInContext too. Nothing in the crx flow ever
  // set it — the step name is derived from the action — so the fallback is all there is.
  const description = undefined as string | undefined;
  const frame = {
    pageAlias: aliasFor(actionInContext.pageGuid),
    // 1.62 folds the frame path into action.selector at capture time, so a step no longer
    // carries one and the player must not prepend anything. O2 already sends [] on its
    // storage path, so both directions now agree.
    framePath: [] as string[],
  };
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
        button: action.button,
        modifiers: action.modifiers,
        position: action.position,
        clickCount: action.clickCount,
      };
    // 1.56 added hover to the recorder model, offered as "Hover" in the action
    // picker. It carries no payload beyond where on the element the pointer went.
    case 'hover':
      return {
        ...base,
        action: 'hover',
        position: action.position,
      };
    case 'fill':
      return {
        ...base,
        action: 'type',
        value: action.text,
      };
    case 'press':
      return {
        ...base,
        action: 'press',
        key: action.key,
        modifiers: action.modifiers,
      };
    case 'select':
      return {
        ...base,
        action: 'select',
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
      };
    case 'uncheck':
      return {
        ...base,
        action: 'uncheck',
      };
    case 'setInputFiles':
      return {
        ...base,
        action: 'setInputFiles',
        files: [...action.files],
      };
    case 'assertText':
      return {
        ...base,
        action: 'assert',
        assertion: buildAssertion(action),
        text: action.text,
      };
    case 'assertValue':
      return {
        ...base,
        action: 'assert',
        assertion: buildAssertion(action),
        value: action.value,
      };
    case 'assertChecked':
      return {
        ...base,
        action: 'assert',
        assertion: buildAssertion(action),
        checked: action.checked,
      };
    case 'assertVisible':
      return {
        ...base,
        action: 'assert',
        assertion: buildAssertion(action),
      };
    case 'assertSnapshot':
      return {
        ...base,
        action: 'assert',
        assertion: buildAssertion(action),
        snapshot: action.ariaSnapshot,
      };
    case 'closePage':
      // Skip closePage — no user-facing step
      return { ...base, action: 'navigate' } as BrowserStep;
    default:
      // `base` is seeded with action:'click' as a placeholder for every case above
      // to overwrite. Returning it here turned any action this switch does not know
      // into a click the user never performed — which is how 1.56's `hover` reached
      // storage as a click, past all three of the guards meant to catch it.
      //
      // Failing makes a new upstream ActionName a deliberate decision rather than a
      // silent downgrade. Upstream added one action in nine minors; it will add more.
      throw new Error(`unmapped recorder action: '${(action as { name: string }).name}'`);
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
  // One assigner for the whole journey: page names have to be consistent across steps,
  // not per step.
  const aliasFor = aliasAssigner();
  return actions
      .filter(a => a.action.name !== 'closePage')
      .map((a, i) => mapActionToBrowserStep(a, i, responsesFor?.(a), aliasFor));
}

// Reconstructs the Playwright Action for a BrowserStep. The forward mapper
// collapses several action names into a coarser BrowserStepAction, so we
// reconstruct the exact action.name from the step's action + which fields are
// present. Assert subtypes are fully recoverable, and check/uncheck now survive
// the round trip intact (X-9.3) rather than degrading to a click.
/**
 * The stored version-2 vocabulary (X-9.1), mapped onto the recorder's internal
 * action names.
 *
 * A journey that has been saved and reloaded arrives with the v2 names, because
 * that is what the schema stores: `fill` replaces the `type` alias and `upload`
 * is the v2 name for `setInputFiles` (P2.2.5 rejects `type` outright). The
 * recorder's own in-memory steps still use the internal names, so both spellings
 * must reach the same action.
 *
 * Without this a reloaded `fill` fell through to the `noop` default and was
 * skipped silently — reported as a pass for a step that never typed anything,
 * which is precisely the false green X-8.2 exists to prevent.
 */
const V2_ACTION_ALIASES: Record<string, BrowserStepAction> = {
  fill: 'type',
  upload: 'setInputFiles',
};

function buildActionFromStep(step: BrowserStep): Action {
  // A step's identity is its locator bundle, and nothing else. The mapper used
  // to read a bare `step.selector` first, which built every element action with
  // an empty selector on a stored step, and Playwright failed parsing it before
  // the step ran:
  //   Unexpected token "" while parsing css selector "".
  // The `?? step.selector` fallback that replaced it outlived the field it read
  // and went with version 1 (Phase 2c).
  const selector = effectiveSelector(step.locator) ?? '';
  switch (V2_ACTION_ALIASES[step.action] ?? step.action) {
    case 'openPage':
      return { name: 'openPage', url: step.url ?? '', signals: [] };
    case 'navigate':
      return { name: 'navigate', url: step.url ?? '', signals: [] };
    case 'hover':
      return { name: 'hover', selector, position: step.position, signals: [] };
    case 'click':
      return {
        name: 'click',
        selector,
        button: step.button ?? 'left',
        modifiers: step.modifiers ?? 0,
        clickCount: step.clickCount ?? 1,
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
    case 'assert': {
      // A stored v2 assert is typed (`assertion.kind`, P5.1) and carries none of
      // the legacy fields below. Reading only those made every reloaded
      // assertion degrade to assertVisible — including `element_text`, which
      // replayFidelity then labelled "evaluated approximately". A visibility
      // check reported as a text check is the false claim X-8.2 exists to stop.
      const kind = step.assertion?.kind;
      if (kind === 'element_text')
        return { name: 'assertText', selector, text: step.assertion?.expected ?? '', substring: true, signals: [] };
      if (kind === 'element_visible')
        return { name: 'assertVisible', selector, signals: [] };
      if (kind) {
        // P5.S.2 — the other four kinds have no player equivalent. A noop keeps
        // the action list index-aligned and lets replayFidelity report
        // "assertion not simulated", instead of the player quietly running a
        // different, weaker check. The page-level kinds (url_matches,
        // page_title) legitimately carry no locator at all, so executing
        // anything here would fail on an empty selector.
        return { name: 'noop', signals: [] } as unknown as Action;
      }
      // v1 / recorder-internal asserts: the subtype is recovered from whichever
      // field is set.
      if (step.snapshot !== undefined)
        return { name: 'assertSnapshot', selector, ariaSnapshot: step.snapshot, signals: [] };
      if (step.text !== undefined)
        return { name: 'assertText', selector, text: step.text, substring: true, signals: [] };
      if (step.value !== undefined)
        return { name: 'assertValue', selector, value: step.value, signals: [] };
      if (step.checked !== undefined)
        return { name: 'assertChecked', selector, checked: step.checked, signals: [] };
      return { name: 'assertVisible', selector, signals: [] };
    }
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
 * Step actions the player cannot execute. They enter journeys from O2's manual step
 * editor or from legacy monitors, and are retired from the v2 vocabulary; this list
 * exists so existing journeys still replay, with the step reported honestly rather
 * than as a pass. See spec X-9 and P1.R.2a.
 *
 * `hover` was on this list because upstream's recorder model had no such action at all.
 * Playwright 1.56 added one, reachable from the action picker, so a hover can now be
 * captured, mapped by this file, and executed by `Frame.hover`. It is a supported
 * action rather than an unsimulated one, and reporting it as "not simulated" would
 * under-claim a capability we have.
 */
export const UNSUPPORTED_REPLAY_ACTIONS: readonly string[] = [
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
    // The alias IS the page key on the way back in. A journey replayed from storage has no
    // live guid to refer to, and O2 sends `pageAlias: 'page'` for every stored step, so
    // using it as the guid keeps one identity for both directions — live capture uses the
    // real guid, replay uses the name it was stored under.
    pageGuid: step.pageAlias ?? 'page',
    action: buildActionFromStep(step),
    startTime: step.startTime ?? 0,
    endTime: step.endTime,
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


/**
 * The page key of the journey's primary page — the one the recording started on.
 *
 * Needed because that key is not a constant. 1.62 replaced the action's FrameDescription
 * with a bare page key, and which string that is depends on where the actions came from:
 * a journey parsed from code or rebuilt from storage carries aliases (`page`, `page1`, …),
 * while one captured live carries real page guids. Comparing against the literal 'page'
 * is therefore right for the first and silently wrong for the second — which is exactly
 * how the primary page's openPage stopped being skipped and replayed as a stray
 * `newPage` step.
 *
 * First-mentioned is the definition, matching how aliases are assigned in the first place.
 */
export function primaryPageGuid(actions: { pageGuid: string }[]): string | undefined {
  return actions[0]?.pageGuid;
}
