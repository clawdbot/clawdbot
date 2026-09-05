export const MAX_BEFORE_AGENT_FINALIZE_REVISIONS = 3;

export type EmbeddedRunTerminalRetryState = {
  reasoningOnlyAttempts: number;
  emptyResponseAttempts: number;
  missingAssistantAttempts: number;
  compactionContinuationAttempts: number;
  beforeFinalizeRevisionAttempts: number;
};

export function createEmbeddedRunTerminalRetryState(): EmbeddedRunTerminalRetryState {
  return {
    reasoningOnlyAttempts: 0,
    emptyResponseAttempts: 0,
    missingAssistantAttempts: 0,
    compactionContinuationAttempts: 0,
    beforeFinalizeRevisionAttempts: 0,
  };
}
