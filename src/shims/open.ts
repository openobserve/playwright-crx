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
 * Stands in for the `open` package, which launches a URL in the user's desktop browser.
 *
 * `utilsBundle.ts` re-exports it (`export const open = openLibrary`) for the CLI paths —
 * opening the trace viewer, the HTML report, the codegen window. None of those exist in an
 * extension, and there is no desktop shell to ask.
 *
 * It only became a problem at 1.62. Before 1.60 `open` lived behind a pre-built bundle, so
 * its dependencies were never in our graph; 1.60 flattened the bundles into direct imports
 * (playwright#40074), and 1.62's lockfile then moved `open` to a version that reaches for
 * `powershell-utils` and `wsl-utils` — which import `node:util`'s `promisify` at module
 * scope, from a module Vite externalises to an empty stub. Rollup failed the build rather
 * than emit a binding that does not exist.
 *
 * Shimming the package is better than widening the `node:util` shim: the dependency is
 * genuinely unreachable here, so the honest fix is to cut it at the top rather than to
 * satisfy the imports of code that must never run.
 */

type OpenOptions = { wait?: boolean, app?: unknown, [key: string]: unknown };

/** Opens a target in the desktop browser. There is no desktop browser to open it in. */
export default async function open(target: string, _options?: OpenOptions): Promise<never> {
  throw new Error(`Cannot open ${target}: a browser extension has no desktop shell`);
}

export async function openApp(_name: unknown, _options?: OpenOptions): Promise<never> {
  throw new Error('Cannot open an application from a browser extension');
}

export const apps = {};
