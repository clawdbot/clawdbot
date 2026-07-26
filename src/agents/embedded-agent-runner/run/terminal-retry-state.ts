export const MAX_BEFORE_AGENT_FINALIZE_REVISIONS = 5;

export function hasExhaustedBeforeAgentFinalizeRevisions(params: {
  revisionReason?: string;
  revisionAttempts: number;
  maxRevisionAttempts?: number;
}): boolean {
  const maxRevisionAttempts = params.maxRevisionAttempts ?? MAX_BEFORE_AGENT_FINALIZE_REVISIONS;
  return Boolean(
    params.revisionReason &&
    maxRevisionAttempts > 0 &&
    params.revisionAttempts >= maxRevisionAttempts,
  );
}

export type EmbeddedRunTerminalRetryState = {
  reasoningOnlyAttempts: number;
  emptyResponseAttempts: number;
  missingAssistantAttempts: number;
  compactionContinuationAttempts: number;
  compactionContinuationInstruction: string | null;
  beforeFinalizeRevisionAttempts: number;
  recoverableToolErrorContinuationAttempts: number;
  transientTransportContinuationAttempts: number;
};

export function createEmbeddedRunTerminalRetryState(): EmbeddedRunTerminalRetryState {
  return {
    reasoningOnlyAttempts: 0,
    emptyResponseAttempts: 0,
    missingAssistantAttempts: 0,
    compactionContinuationAttempts: 0,
    compactionContinuationInstruction: null,
    beforeFinalizeRevisionAttempts: 0,
    recoverableToolErrorContinuationAttempts: 0,
    transientTransportContinuationAttempts: 0,
  };
}
