import type { EmbeddedAgentMeta } from "../types.js";

export function createEmbeddedRunContextRecoveryState() {
  return {
    autoCompactionCount: 0,
    lastCompactionTokensAfter: undefined as number | undefined,
    lastContextBudgetStatus: undefined as EmbeddedAgentMeta["contextBudgetStatus"],
    overflowCompactionAttempts: 0,
    timeoutCompactionAttempts: 0,
    toolResultTruncationAttempted: false,
  };
}

export type EmbeddedRunContextRecoveryState = ReturnType<
  typeof createEmbeddedRunContextRecoveryState
>;
