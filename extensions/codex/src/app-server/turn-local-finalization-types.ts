export type CodexTurnLocalBeforeAgentFinalize = (event: {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  provider: string;
  model: string;
  lastAssistantMessage: string;
  revisionAttempt: number;
}) => Promise<CodexTurnLocalBeforeAgentFinalizeResult> | CodexTurnLocalBeforeAgentFinalizeResult;

type CodexTurnLocalBeforeAgentFinalizeResult =
  | { action: "continue" }
  | {
      action: "revise";
      instruction: string;
      disableTools: true;
      onAccepted?: () => Promise<void> | void;
    }
  | {
      action: "discard";
      onAccepted?: () => Promise<void> | void;
    };

/** Bundled-only attempt fields; these are intentionally absent from the public harness API. */
export type CodexSourceFinalizationAttemptOptions = {
  onBeforeAgentFinalize?: CodexTurnLocalBeforeAgentFinalize;
};
