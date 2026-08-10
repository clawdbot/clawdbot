export type AgentRunAttemptFailureSource =
  | "prompt"
  | "compaction"
  | "precheck"
  | "hook:before_agent_run";

export type LegacyAgentRunAttemptTerminalInput = {
  aborted?: boolean;
  externalAbort?: boolean;
  failed?: boolean;
  idleTimedOut?: boolean;
  promptError?: unknown;
  promptErrorSource?: AgentRunAttemptFailureSource | null;
  timedOut?: boolean;
  timedOutByRunBudget?: boolean;
  timedOutDuringCompaction?: boolean;
  timedOutDuringToolExecution?: boolean;
};
