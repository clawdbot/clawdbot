export const MAX_BEFORE_AGENT_FINALIZE_REVISIONS = 3;

export type CodeModeRecoveryCandidate = {
  blockedActionKeys?: readonly string[];
};

export type CodeModeRecoveryState =
  | { kind: "idle" }
  | {
      kind: "inspect";
      phase: "read-required" | "ready";
      blockedActionKeys?: readonly string[];
    }
  | {
      kind: "resume";
      blockedActionKeys: ReadonlySet<string>;
      mutationAttempt: "available" | "reserved" | "consumed";
    };

export type EmbeddedRunTerminalRetryState = {
  reasoningOnlyAttempts: number;
  emptyResponseAttempts: number;
  missingAssistantAttempts: number;
  compactionContinuationAttempts: number;
  compactionContinuationInstruction: string | null;
  beforeFinalizeRevisionAttempts: number;
  codeModeRecovery: CodeModeRecoveryState;
};

export function createEmbeddedRunTerminalRetryState(): EmbeddedRunTerminalRetryState {
  return {
    reasoningOnlyAttempts: 0,
    emptyResponseAttempts: 0,
    missingAssistantAttempts: 0,
    compactionContinuationAttempts: 0,
    compactionContinuationInstruction: null,
    beforeFinalizeRevisionAttempts: 0,
    codeModeRecovery: { kind: "idle" },
  };
}
