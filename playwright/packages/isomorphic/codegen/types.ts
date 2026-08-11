/**
 * Copyright (c) Microsoft Corporation.
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

import type { BrowserContextOptions, LaunchOptions } from 'playwright-core';
import type * as actions from './actions';
import type { Language } from '../locatorGenerators';
import type { Point } from '../types';
export type { Language };

export type SmartKeyboardModifier = 'Alt' | 'Control' | 'Meta' | 'Shift' | 'ControlOrMeta';

export type MouseClickOptions = {
  modifiers?: SmartKeyboardModifier[];
  position?: Point;
  delay?: number;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
};

export type LanguageGeneratorOptions = {
  browserName: string;
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
  deviceName?: string;
  saveStorage?: string;
  generateExpectSignal?: boolean;
};

export interface LanguageGenerator {
  id: string;
  groupName: string;
  name: string;
  highlighter: Language;
  reset(): void;
  // patch(playwright-crx): see generateCode — the header may need `context` in its
  // fixtures, and only the generator knows whether it named more than one page.
  generateHeader(options: LanguageGeneratorOptions, includeContext?: boolean): string;
  usesContext?(): boolean;
  generateAction(actionInContext: actions.ActionInContext, options: LanguageGeneratorOptions): string;
  generateFooter(saveStorage: string | undefined): string;
}
