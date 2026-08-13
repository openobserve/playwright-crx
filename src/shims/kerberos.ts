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
 * Stands in for `kerberos`, a native addon.
 *
 * 1.62 added `proxy-agent-negotiate` (Negotiate/Kerberos proxy authentication), which
 * declares `kerberos` as an *optional* peer dependency. It is not installed, so Vite
 * resolved it to a generated stub module of its own — named, unavoidably,
 * `__vite-optional-peer-dep_kerberos_proxy-agent-negotiate`.
 *
 * That name is the problem. Chrome reserves a leading underscore in extension filenames,
 * so the emitted chunk made the extension refuse to load outright:
 *
 *     Cannot load extension with file or directory name
 *     __vite-optional-peer-dep_kerberos_proxy-agent-negotiate-CZnvc9qa.js.map.
 *     Filenames starting with "_" are reserved for use by the system.
 *
 * It is emitted once by the root `lib/` build and copied into every extension, so all four
 * were unloadable — a build that reported success and produced nothing that runs.
 *
 * Resolving the specifier ourselves means Vite never generates the stub. A native addon
 * could not have loaded in a service worker regardless, and Negotiate proxy auth is not
 * something an extension performs: Chrome owns the proxy connection.
 */

export {};
