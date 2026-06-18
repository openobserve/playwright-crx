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

export type SelectorType = 'css' | 'xpath' | 'text' | 'role' | 'data-test';

export type BrowserStepAction =
  'navigate' | 'click' | 'type' | 'press' | 'select' |
  'setInputFiles' | 'waitFor' | 'assert' | 'screenshot';

export interface BrowserStep {
  id: string;
  action: BrowserStepAction;
  selector?: string;
  selector_type?: SelectorType;
  name: string;
  timeout_ms: number;
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
  // Generated code snippet
  code?: string;
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

export function mapActionToBrowserStep(
  actionInContext: ActionInContext,
  actionIndex: number,
  code?: string
): BrowserStep {
  const { action, frame, startTime, endTime, description } = actionInContext;

  const base: BrowserStep = {
    id: `s${actionIndex + 1}`,
    action: 'click', // placeholder, overridden below
    name: description ?? buildStepName(action, actionIndex),
    timeout_ms: 10000,
    startTime,
    endTime,
    pageAlias: frame.pageAlias,
    framePath: frame.framePath,
    description,
    code,
  };

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
    case 'check':
      return {
        ...base,
        action: 'click',
        selector: action.selector,
        selector_type: getSelectorType(action.selector),
      };
    case 'uncheck':
      return {
        ...base,
        action: 'click',
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
        text: action.text,
      };
    case 'assertValue':
      return {
        ...base,
        action: 'assert',
        selector: action.selector,
        selector_type: getSelectorType(action.selector),
        value: action.value,
      };
    case 'assertChecked':
      return {
        ...base,
        action: 'assert',
        selector: action.selector,
        selector_type: getSelectorType(action.selector),
        checked: action.checked,
      };
    case 'assertVisible':
      return {
        ...base,
        action: 'assert',
        selector: action.selector,
        selector_type: getSelectorType(action.selector),
      };
    case 'assertSnapshot':
      return {
        ...base,
        action: 'assert',
        selector: action.selector,
        selector_type: getSelectorType(action.selector),
        snapshot: action.snapshot,
      };
    case 'closePage':
      // Skip closePage — no user-facing step
      return { ...base, action: 'navigate' } as BrowserStep;
    default:
      return base;
  }
}

export function mapActionsToBrowserSteps(
  actions: ActionInContext[],
  codes?: string[]
): BrowserStep[] {
  return actions
      .filter(a => a.action.name !== 'closePage')
      .map((a, i) => mapActionToBrowserStep(a, i, codes?.[i]));
}
