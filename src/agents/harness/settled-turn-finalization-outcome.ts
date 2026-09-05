import type { AgentHarnessSettledTurnFinalizationResult } from "./types.js";

/** A normally stopped finalizer exhausted its visible answer without failing or using tools. */
export class EmptySettledTurnFinalizationError extends Error {
  constructor(readonly result: AgentHarnessSettledTurnFinalizationResult) {
    super("Settled-turn finalization completed without a visible answer");
    this.name = "EmptySettledTurnFinalizationError";
  }
}
