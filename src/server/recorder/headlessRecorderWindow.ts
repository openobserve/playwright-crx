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
 * Headless RecorderWindow — no-op UI that forwards recorder messages
 * to a callback instead of rendering a Playwright code editor.
 */

import type { RecorderEventData, RecorderMessage, RecorderWindow } from './crxRecorderApp';

export type ForwardCallback = (msg: RecorderMessage) => void;

export class HeadlessRecorderWindow implements RecorderWindow {
  onMessage?: ({ type, event, params }: RecorderEventData) => void;
  hideApp?: () => any;

  private _onForward?: ForwardCallback;

  constructor(onForward?: ForwardCallback) {
    this._onForward = onForward;
  }

  setForwardCallback(cb: ForwardCallback) {
    this._onForward = cb;
  }

  isClosed(): boolean {
    return false;
  }

  async open(): Promise<void> {
    // no-op: no UI window to open
  }

  async focus(): Promise<void> {
    // no-op: no UI window to focus
  }

  async close(): Promise<void> {
    // no-op: cannot be closed
  }

  postMessage(msg: RecorderMessage): void {
    this._onForward?.(msg);
  }
}
