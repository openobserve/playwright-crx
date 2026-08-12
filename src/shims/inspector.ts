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
 * Stands in for Node's built-in `inspector` module.
 *
 * 1.62 added `import * as inspector from 'inspector'` to `client/page.ts`, used by
 * `page.pause()` to ask whether a JS debugger is attached before deciding how to block.
 * Two things then went wrong at once:
 *
 * 1. There is no Node inspector in a service worker, so there is nothing to import.
 * 2. `inspector` is also the name of an unrelated npm package (a WebKit inspector client
 *    from 2015) that sits in our devDependencies, and bare-specifier resolution found
 *    *that*. It does `require('ws')` at module scope, and ws's browser build exports a
 *    function that throws — so the import blew up while the service worker was still
 *    evaluating, and the extension never started.
 *
 * Until 1.62 the only reference was a lazy `require('inspector')` inside a function in
 * `utils/profiler.ts`, which never ran. A static import does run.
 *
 * `url()` returning undefined is the honest answer: no debugger is attached, and none can
 * be, so `page.pause()` takes the non-debugger path — which is the one crx wants.
 */

/** The inspector's WebSocket URL, or undefined when no debugger is attached. */
export function url(): string | undefined {
  return undefined;
}

/** Node's inspector session. Nothing in the extension can open one. */
export class Session {
  connect(): void {
    throw new Error('The Node inspector is not available in a browser extension');
  }
}

export function open(): void {
}

export function close(): void {
}
