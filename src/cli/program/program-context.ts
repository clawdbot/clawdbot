// Attaches ProgramContext metadata to Commander instances for lazy command helpers.
import type { Command } from "commander";
import type { ProgramContext } from "./context.js";

const PROGRAM_CONTEXT_SYMBOL: unique symbol = Symbol.for("openclaw.cli.programContext");

/** Attach the current root ProgramContext to a Commander program. */
export function setProgramContext(program: Command, ctx: ProgramContext): void {
  (program as Command & { [PROGRAM_CONTEXT_SYMBOL]?: ProgramContext })[PROGRAM_CONTEXT_SYMBOL] =
    ctx;
}

/** Read ProgramContext metadata from a Commander program when available. */
export function getProgramContext(program: Command): ProgramContext | undefined {
  return (program as Command & { [PROGRAM_CONTEXT_SYMBOL]?: ProgramContext })[
    PROGRAM_CONTEXT_SYMBOL
  ];
}
