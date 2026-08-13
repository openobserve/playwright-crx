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
 * Stands in for `playwright-core/lib/bootstrap`, whose entire job is Node process setup:
 * a minimum-Node-version gate and an optional module-load profiler.
 *
 * Both are meaningless in a service worker, and the first is actively fatal there. It
 * runs at module scope and reads `process.versions.node`, which our browser `process`
 * shim leaves empty — so the version parses as 0, fails the `>= 20` check that 1.62
 * raised (playwright#41497), and calls `process.exit(1)`. That shim has no `exit`, so the
 * worker died on "process.exit is not a function" before it could activate, taking the
 * whole extension with it.
 *
 * Imported for side effects only, so an empty module is the whole shim.
 */
export {};
