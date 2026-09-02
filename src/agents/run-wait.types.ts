import type { AgentRunTerminalReplySnapshot } from "./agent-run-terminal-reply.js";
import type { AgentRunTimeoutPhase } from "./run-timeout-attribution.js";

/** Normalized terminal or pending state returned by `agent.wait`. */
export type AgentWaitResult = {
  status: "ok" | "timeout" | "error" | "pending";
  error?: string;
  /** Set locally when the wait RPC fails; terminal run text is never retry evidence. */
  retryableTransportError?: true;
  startedAt?: number;
  endedAt?: number;
  stopReason?: string;
  livenessState?: string;
  yielded?: boolean;
  pendingError?: boolean;
  timeoutPhase?: AgentRunTimeoutPhase;
  providerStarted?: boolean;
  terminalReply?: AgentRunTerminalReplySnapshot;
};
