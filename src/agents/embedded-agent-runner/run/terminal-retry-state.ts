import type { FileTarget } from "../../tool-mutation.js";

export const MAX_BEFORE_AGENT_FINALIZE_REVISIONS = 3;

export type CodeModeMutationVerificationState = {
  pendingTargets: FileTarget[];
};

export type EmbeddedRunTerminalRetryState = {
  reasoningOnlyAttempts: number;
  emptyResponseAttempts: number;
  codeModeErrorContinuationAttempts: number;
  codeModeCompletionContinuationAttempts: number;
  codeModeVerificationContinuationAttempts: number;
  missingAssistantAttempts: number;
  compactionContinuationAttempts: number;
  compactionContinuationInstruction: string | null;
  beforeFinalizeRevisionAttempts: number;
  forceRestartSafeToolsForNextAttempt: boolean;
  forceReadOnlyToolsUntilVerification: boolean;
  forceReadOnlyToolsForRun: boolean;
  codeModeMutationVerification: CodeModeMutationVerificationState;
};

export function createEmbeddedRunTerminalRetryState(): EmbeddedRunTerminalRetryState {
  return {
    reasoningOnlyAttempts: 0,
    emptyResponseAttempts: 0,
    codeModeErrorContinuationAttempts: 0,
    codeModeCompletionContinuationAttempts: 0,
    codeModeVerificationContinuationAttempts: 0,
    missingAssistantAttempts: 0,
    compactionContinuationAttempts: 0,
    compactionContinuationInstruction: null,
    beforeFinalizeRevisionAttempts: 0,
    forceRestartSafeToolsForNextAttempt: false,
    forceReadOnlyToolsUntilVerification: false,
    forceReadOnlyToolsForRun: false,
    codeModeMutationVerification: { pendingTargets: [] },
  };
}

/** Read the run-latched tool restriction armed by terminal recovery. */
export function consumeForceRestartSafeToolsForNextAttempt(
  state: EmbeddedRunTerminalRetryState,
  runAlreadyForcesRestartSafeTools: boolean,
): boolean {
  return runAlreadyForcesRestartSafeTools || state.forceRestartSafeToolsForNextAttempt;
}

/** Resolve read-only policy without releasing verification state at dispatch time. */
export function resolveForceReadOnlyToolsForAttempt(
  state: EmbeddedRunTerminalRetryState,
  runAlreadyForcesReadOnlyTools: boolean,
): boolean {
  return (
    runAlreadyForcesReadOnlyTools ||
    state.forceReadOnlyToolsForRun ||
    state.forceReadOnlyToolsUntilVerification
  );
}
