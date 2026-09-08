import { readNonBlankString } from "./string-coerce.js";

export const AGENT_RUN_ABORTED_STOP_REASON = "aborted" as const;
export const AGENT_RUN_RESTART_ABORT_STOP_REASON = "restart" as const;
export const AGENT_RUN_SUPERSEDED_STOP_REASON = "superseded" as const;

const AGENT_RUN_TIMEOUT_PHASES = [
  "queue",
  "preflight",
  "provider",
  "post_turn",
  "gateway_draining",
] as const;

export type AgentRunTimeoutPhase = (typeof AGENT_RUN_TIMEOUT_PHASES)[number];
type AgentRunWaitStatus = "ok" | "error" | "timeout";
type AgentRunTerminalReason =
  | "completed"
  | "hard_timeout"
  | "timed_out"
  | "superseded"
  | "cancelled"
  | "aborted"
  | "blocked"
  | "abandoned"
  | "failed";

export type AgentRunTerminalFacts = {
  reason: AgentRunTerminalReason;
  status: AgentRunWaitStatus;
  stopReason?: string;
  livenessState?: string;
  timeoutPhase?: AgentRunTimeoutPhase;
  providerStarted?: boolean;
};

export type AgentRunTerminalFactInput = {
  status: AgentRunWaitStatus;
  stopReason?: unknown;
  livenessState?: unknown;
  timeoutPhase?: unknown;
  providerStarted?: unknown;
};

type AgentRunWaitTerminalFactInput = Omit<AgentRunTerminalFactInput, "status"> & {
  status?: unknown;
};

type AgentRunLifecycleTerminalFactInput = AgentRunWaitTerminalFactInput & {
  aborted?: unknown;
};

const HARD_TIMEOUT_PHASES = new Set<AgentRunTimeoutPhase>(["preflight", "provider", "post_turn"]);
const AGENT_RUN_TERMINAL_CLASSIFICATION = {
  completed: "success",
  hard_timeout: "timeout",
  timed_out: "timeout",
  superseded: "cancellation",
  cancelled: "cancellation",
  aborted: "cancellation",
  blocked: "failure",
  abandoned: "failure",
  failed: "failure",
} as const satisfies Record<
  AgentRunTerminalReason,
  "success" | "timeout" | "cancellation" | "failure"
>;

export function normalizeAgentRunTimeoutPhase(value: unknown): AgentRunTimeoutPhase | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return AGENT_RUN_TIMEOUT_PHASES.find((phase) => phase === normalized);
}

export function normalizeProviderStarted(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function isAbortedAgentStopReason(
  value: unknown,
): value is typeof AGENT_RUN_ABORTED_STOP_REASON | typeof AGENT_RUN_RESTART_ABORT_STOP_REASON {
  return value === AGENT_RUN_ABORTED_STOP_REASON || value === AGENT_RUN_RESTART_ABORT_STOP_REASON;
}

export function classifyAgentRunTerminalOutcome(outcome: Pick<AgentRunTerminalFacts, "reason">) {
  return AGENT_RUN_TERMINAL_CLASSIFICATION[outcome.reason];
}

function isCancellationStopReason(value: string | undefined): boolean {
  return value === "rpc" || value === "stop";
}

/** Interprets terminal metadata without runtime abort, error formatting, or storage ownership. */
export function resolveAgentRunTerminalFacts(
  input: AgentRunTerminalFactInput,
): AgentRunTerminalFacts {
  const stopReason = readNonBlankString(input.stopReason);
  const livenessState = readNonBlankString(input.livenessState);
  const timeoutPhase = normalizeAgentRunTimeoutPhase(input.timeoutPhase);
  const providerStarted = normalizeProviderStarted(input.providerStarted);
  const restartCancelled = stopReason === AGENT_RUN_RESTART_ABORT_STOP_REASON;
  // Provider reach alone does not establish a timeout; an attributed phase or
  // timeout status is required. Restart cancellation retains its own precedence.
  const hardTimeout =
    (timeoutPhase !== undefined && HARD_TIMEOUT_PHASES.has(timeoutPhase)) ||
    (!restartCancelled && input.status === "timeout" && providerStarted === true);
  // Model/ACP "stop" is successful; only a non-success status makes it cancellation.
  const cancelled =
    restartCancelled || (input.status !== "ok" && isCancellationStopReason(stopReason));
  const normalizedLiveness = livenessState?.trim().toLowerCase();
  const reason: AgentRunTerminalReason = hardTimeout
    ? "hard_timeout"
    : stopReason === AGENT_RUN_SUPERSEDED_STOP_REASON
      ? "superseded"
      : normalizedLiveness === "blocked"
        ? "blocked"
        : isAbortedAgentStopReason(stopReason) && !restartCancelled
          ? "aborted"
          : cancelled
            ? "cancelled"
            : normalizedLiveness === "abandoned"
              ? "abandoned"
              : input.status === "timeout"
                ? "timed_out"
                : input.status === "error"
                  ? "failed"
                  : "completed";
  return {
    reason,
    status:
      reason === "completed"
        ? "ok"
        : reason === "hard_timeout" || reason === "timed_out"
          ? "timeout"
          : "error",
    ...(stopReason ? { stopReason } : {}),
    ...(livenessState ? { livenessState } : {}),
    ...(timeoutPhase ? { timeoutPhase } : {}),
    ...(providerStarted !== undefined ? { providerStarted } : {}),
  };
}

/** Applies lifecycle flags before interpreting the same canonical terminal metadata. */
export function resolveAgentRunLifecycleTerminalFacts(input: {
  phase: "end" | "error";
  data?: AgentRunLifecycleTerminalFactInput;
  abortFields?: { aborted?: true; stopReason?: string };
}): AgentRunTerminalFacts {
  const { data, abortFields } = input;
  const stopReason = readNonBlankString(data?.stopReason) ?? abortFields?.stopReason;
  const timeoutPhase = normalizeAgentRunTimeoutPhase(data?.timeoutPhase);
  const lifecycleStatus = readNonBlankString(data?.status)?.toLowerCase();
  // A mechanical abort is cancellation unless the producer records a timeout.
  const timedOut =
    stopReason === "timeout" ||
    timeoutPhase !== undefined ||
    lifecycleStatus === "timeout" ||
    lifecycleStatus === "timed_out";
  const aborted =
    data?.aborted === true || abortFields?.aborted === true || lifecycleStatus === "aborted";
  const cancellationStatus =
    lifecycleStatus === "cancelled" ||
    lifecycleStatus === "canceled" ||
    lifecycleStatus === "aborted" ||
    lifecycleStatus === "superseded";
  const cancelled = cancellationStatus || aborted;
  const failed =
    input.phase === "error" ||
    lifecycleStatus === "error" ||
    lifecycleStatus === "failed" ||
    stopReason === "error";
  const normalizedStopReason =
    !timedOut &&
    cancelled &&
    !isAbortedAgentStopReason(stopReason) &&
    !isCancellationStopReason(stopReason) &&
    stopReason !== AGENT_RUN_SUPERSEDED_STOP_REASON &&
    (stopReason === undefined || cancellationStatus)
      ? aborted
        ? AGENT_RUN_ABORTED_STOP_REASON
        : "stop"
      : stopReason;
  const facts = resolveAgentRunTerminalFacts({
    status: timedOut ? "timeout" : cancelled || failed ? "error" : "ok",
    stopReason: normalizedStopReason,
    livenessState: data?.livenessState,
    timeoutPhase,
    providerStarted: data?.providerStarted,
  });
  return stopReason && facts.stopReason !== stopReason ? { ...facts, stopReason } : facts;
}

/** Reads reduced terminal wait snapshots; pending/deadline admission belongs to the caller. */
export function resolveAgentRunWaitTerminalFacts(
  input: AgentRunWaitTerminalFactInput,
): AgentRunTerminalFacts | undefined {
  const status = input.status;
  if (status !== "ok" && status !== "error" && status !== "timeout") {
    return undefined;
  }
  const facts = resolveAgentRunTerminalFacts({ ...input, status });
  // Auth logout emits an aborted cancellation, but agent.wait preserves only
  // its original reason. Retain "aborted" so this does not become a sticky cancellation.
  return status !== "ok" &&
    facts.stopReason === "auth-revoked" &&
    (facts.reason === "failed" || facts.reason === "timed_out" || facts.reason === "abandoned")
    ? { ...facts, reason: "aborted", status: "error" }
    : facts;
}

/** Reads the execution owner's publication fact; it grants no runtime authority. */
export function hasExecutionSettlement(data?: Record<string, unknown>): boolean {
  return data?.executionSettled === true;
}

/** Distinguishes terminal outcomes from errors that can still be followed by a retry. */
export function isDefinitiveRunLifecycle(input: {
  phase?: unknown;
  data?: Record<string, unknown>;
}): boolean {
  if (input.phase === "end") {
    return true;
  }
  if (input.phase !== "error") {
    return false;
  }
  const facts = resolveAgentRunLifecycleTerminalFacts({ phase: "error", data: input.data });
  return (
    hasExecutionSettlement(input.data) ||
    input.data?.fallbackExhaustedFailure === true ||
    facts.reason !== "failed"
  );
}
