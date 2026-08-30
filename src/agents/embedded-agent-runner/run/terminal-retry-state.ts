export const MAX_BEFORE_AGENT_FINALIZE_REVISIONS = 3;

export type EmbeddedRunTerminalRetryState = {
  reasoningOnlyAttempts: number;
  emptyResponseAttempts: number;
  missingAssistantAttempts: number;
  compactionContinuationAttempts: number;
  compactionContinuationInstruction: string | null;
  beforeFinalizeRevisionAttempts: number;
  /** Tool isolation activated only after a source-local final revision is accepted. */
  disableToolsForBeforeFinalizeRevision: boolean;
  codeModeReconciliationAttempts: number;
  forceCodeModeReconciliationTools: boolean;
};

export function createEmbeddedRunTerminalRetryState(): EmbeddedRunTerminalRetryState {
  return {
    reasoningOnlyAttempts: 0,
    emptyResponseAttempts: 0,
    missingAssistantAttempts: 0,
    compactionContinuationAttempts: 0,
    compactionContinuationInstruction: null,
    beforeFinalizeRevisionAttempts: 0,
    disableToolsForBeforeFinalizeRevision: false,
    codeModeReconciliationAttempts: 0,
    forceCodeModeReconciliationTools: false,
  };
}
