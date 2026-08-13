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
 * Stands in for `commander`, the argument parser behind the `playwright` CLI.
 *
 * `utilsBundle.ts` re-exports `program` and `Option` from it. An extension has no argv and
 * never builds a command line, so nothing here is reachable — but the re-export alone puts
 * the package in the bundle, and 1.62's version imports `stripVTControlCharacters` from
 * `node:util`, which Vite externalises to an empty stub. Same shape as the `open` shim:
 * cut the unreachable package rather than widen a Node shim for code that must not run.
 *
 * The methods chain and do nothing rather than throwing. Commander's API is declarative —
 * a CLI is *described* at module scope and only executed by `parse()` — so a module that
 * registers commands on import must survive being loaded even though it will never run.
 */

class Command {
  command(): this { return this; }
  addCommand(): this { return this; }
  argument(): this { return this; }
  option(): this { return this; }
  addOption(): this { return this; }
  requiredOption(): this { return this; }
  description(): this { return this; }
  action(): this { return this; }
  name(): this { return this; }
  usage(): this { return this; }
  version(): this { return this; }
  alias(): this { return this; }
  allowUnknownOption(): this { return this; }
  configureHelp(): this { return this; }
  addHelpText(): this { return this; }
  showHelpAfterError(): this { return this; }
  exitOverride(): this { return this; }
  opts(): Record<string, unknown> { return {}; }

  parse(): never {
    throw new Error('There is no command line to parse in a browser extension');
  }

  parseAsync(): never {
    throw new Error('There is no command line to parse in a browser extension');
  }
}

class Option {
  constructor(public flags?: string, public description?: string) {}
  default(): this { return this; }
  choices(): this { return this; }
  argParser(): this { return this; }
  hideHelp(): this { return this; }
  makeOptionMandatory(): this { return this; }
}

const program = new Command();

export { Command, Option, program };
export default { Command, Option, program };
