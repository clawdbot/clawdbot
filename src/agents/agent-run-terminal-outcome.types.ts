import type { AgentRunTimeoutPhase } from "./run-timeout-attribution.js";

/** Wait status reported by agent run terminal wait paths. */
export type AgentRunWaitStatus = "ok" | "error" | "timeout";

/** Normalized terminal reason for an agent run. */
export type AgentRunTerminalReason =
  | "completed"
  | "hard_timeout"
  | "timed_out"
  | "superseded"
  | "cancelled"
  | "aborted"
  | "blocked"
  | "abandoned"
  | "failed";

/** Normalized terminal outcome for an agent run. */
export type AgentRunTerminalOutcome = {
  reason: AgentRunTerminalReason;
  status: AgentRunWaitStatus;
  error?: string;
  stopReason?: string;
  livenessState?: string;
  timeoutPhase?: AgentRunTimeoutPhase;
  providerStarted?: boolean;
  startedAt?: number;
  endedAt?: number;
};
