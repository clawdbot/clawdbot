import type {
  ExecApprovalCommandSpan,
  ExecApprovalDecision,
  ExecApprovalUnavailableDecision,
  ExecAsk,
  ExecSecurity,
  SystemRunApprovalPlan,
} from "../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";

export type AgentRunExecApprovalRequest = {
  id: string;
  command?: string;
  commandArgv?: string[];
  systemRunPlan?: SystemRunApprovalPlan;
  env?: Record<string, string>;
  cwd?: string;
  nodeId?: string;
  host: "gateway" | "node";
  security: ExecSecurity;
  ask: ExecAsk;
  warningText?: string;
  commandSpans?: ExecApprovalCommandSpan[];
  unavailableDecisions?: readonly ExecApprovalUnavailableDecision[];
  agentId?: string;
  resolvedPath?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  requireDeliveryRoute?: boolean;
  suppressDelivery?: boolean;
};

export type AgentRunExecApprovalLease = {
  id: string;
  expiresAtMs: number;
  finalDecision?: ExecApprovalDecision | null;
  wait: (params?: { signal?: AbortSignal }) => Promise<ExecApprovalDecision | null>;
  resolveAutoReview: () => Promise<void>;
  cancel: () => Promise<void>;
};

export class AgentRunExecApprovalRunAbortedError extends Error {
  constructor() {
    super("Exec approval cancelled because its run was aborted");
    this.name = "AgentRunExecApprovalRunAbortedError";
  }
}

export type AgentRunExecApprovalHost = {
  /** Gateway hosts may detach execution and deliver its result asynchronously. */
  supportsDetachedExecution?: boolean;
  request: (params: {
    request: AgentRunExecApprovalRequest;
    timeoutMs: number;
    signal?: AbortSignal;
  }) => Promise<AgentRunExecApprovalLease>;
};

export type AgentRunPluginApprovalResult =
  | { outcome: "resolved"; decision: ExecApprovalDecision }
  | { outcome: "timed-out"; deliveryRoute?: "turn-source" }
  | { outcome: "unavailable"; reason: string };

export type AgentRunPluginApprovalHost = {
  request: (params: {
    request: PluginApprovalRequestPayload;
    timeoutMs: number;
    signal?: AbortSignal;
    onRegistered?: (registration: { id: string }) => void;
  }) => Promise<AgentRunPluginApprovalResult>;
};

/**
 * Immutable operator-approval capabilities supplied by the runtime adapter.
 * Missing capabilities fail closed; they never fall through to another host.
 */
export type AgentRunApprovalHost = {
  /** Serializable fail-closed marker; live capability hosts omit this field. */
  mode?: "none";
  exec?: AgentRunExecApprovalHost;
  plugin?: AgentRunPluginApprovalHost;
};

/** Explicit process-local marker for runs that own no approval capabilities. */
export const noAgentRunApprovalHost: AgentRunApprovalHost = Object.freeze({ mode: "none" });

export function isNoAgentRunApprovalHost(
  host: AgentRunApprovalHost | undefined,
): host is AgentRunApprovalHost & { mode: "none" } {
  return host?.mode === "none";
}
