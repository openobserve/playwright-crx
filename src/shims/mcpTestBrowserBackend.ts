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
 * Stands in for `playwright/src/mcp/test/browserBackend`, which Playwright 1.56 added to
 * `playwright/src/index.ts`.
 *
 * Upstream calls this at the end of a test to hand the browser to an MCP agent when the
 * run was started with --pause-on-error or --pause-at-end. There is no MCP agent in a
 * Chrome extension and no way to start one, so the real implementation can only ever
 * early-return here — but reaching it drags the whole MCP tree into the service-worker
 * bundle: the SDK, zod, zod-to-json-schema, and `devices` from a `playwright-core` that
 * in this build is our own entry point and does not export it.
 *
 * Shimmed rather than bundled deliberately. Bundling resolves too, but it ships a server
 * we cannot run and pulls node built-ins into an extension, for a code path whose only
 * possible behaviour here is to do nothing.
 */
export async function runBrowserBackendAtEnd(_context: unknown, _errorMessage?: string): Promise<void> {
}

/**
 * Added to the same module in 1.57 and installed as `TestInfo._onCustomMessageCallback`.
 * It answers MCP requests from a connected agent — initialize, listTools, callTool. In an
 * extension there is no channel those requests could arrive on, so the handler is never
 * invoked; it throws rather than returning a plausible-looking empty answer, because a
 * silent no-op here would be indistinguishable from a working MCP backend that does
 * nothing.
 */
export function createCustomMessageHandler(_testInfo: unknown, _context: unknown) {
  return async (_data: unknown): Promise<never> => {
    throw new Error('playwright-crx does not host an MCP backend');
  };
}
