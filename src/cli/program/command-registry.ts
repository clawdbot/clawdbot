// Program command registry facade: exports core descriptors and registers core plus sub-CLIs.
import type { Command } from "commander";
import { registerCoreCliCommands } from "./command-registry-core.js";
import type { ProgramContext } from "./context.js";
import { registerSubCliCommands } from "./register.subclis.js";

export { registerCoreCliByName } from "./command-registry-core.js";

/** Register all root-program commands for the current argv shape. */
export function registerProgramCommands(
  program: Command,
  ctx: ProgramContext,
  argv: string[] = process.argv,
) {
  registerCoreCliCommands(program, ctx, argv);
  registerSubCliCommands(program, argv);
}
