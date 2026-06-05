/** Normalizes agent run wait/liveness/timeout metadata into sticky terminal outcomes. */
import { formatBlockedLivenessError, isBlockedLivenessState } from "../shared/agent-liveness.js";
import { AGENT_RUN_ABORTED_ERROR, isAbortedAgentStopReason } from "./run-termination.js";
import {
  normalizeAgentRunTimeoutPhase,
  normalizeProviderStarted,
  type AgentRunTimeoutPhase,
} from "./run-timeout-attribution.js";

/** Wait status reported by agent run terminal wait paths. */
export type AgentRunWaitStatus = "ok" | "error" | "timeout";

/** Normalized terminal reason for an agent run. */
export type AgentRunTerminalReason =
  | "completed"
  | "hard_timeout"
  | "timed_out"
  | "cancelled"
  | "aborted"
  | "blocked"
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

/** Raw terminal input collected from run wait/liveness/timeout paths. */
export type AgentRunTerminalInput = {
  status: AgentRunWaitStatus;
  error?: unknown;
  stopReason?: unknown;
  livenessState?: unknown;
  timeoutPhase?: unknown;
  providerStarted?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
};

/** Terminal wait input where pending/unknown status may still be present. */
export type AgentRunTerminalWaitInput = Omit<AgentRunTerminalInput, "status"> & {
  status?: unknown;
};

const HARD_TIMEOUT_PHASES = new Set<AgentRunTimeoutPhase>(["preflight", "provider", "post_turn"]);

function asFiniteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** True when a timeout phase should be treated as a hard agent-run timeout. */
export function isHardAgentRunTimeoutPhase(value: unknown): value is AgentRunTimeoutPhase {
  const phase = normalizeAgentRunTimeoutPhase(value);
  return phase !== undefined && HARD_TIMEOUT_PHASES.has(phase);
}

/** True when an existing outcome is a hard timeout. */
export function isHardAgentRunTimeoutOutcome(
  outcome: AgentRunTerminalOutcome | undefined | null,
): boolean {
  return outcome?.reason === "hard_timeout";
}

/** True when an outcome should not be overwritten by ordinary later status. */
export function isStickyAgentRunTerminalOutcome(
  outcome: AgentRunTerminalOutcome | undefined | null,
): boolean {
  return outcome?.reason === "hard_timeout" || outcome?.reason === "cancelled";
}

function isCancellationStopReason(value: string | undefined): boolean {
  return value === "rpc" || value === "stop";
}

function asAgentRunWaitStatus(value: unknown): AgentRunWaitStatus | "pending" | undefined {
  return value === "ok" || value === "timeout" || value === "error" || value === "pending"
    ? value
    : undefined;
}

/** Builds the normalized terminal outcome from raw run status metadata. */
export function buildAgentRunTerminalOutcome(
  input: AgentRunTerminalInput,
): AgentRunTerminalOutcome {
  const stopReason = asNonEmptyString(input.stopReason);
  const livenessState = asNonEmptyString(input.livenessState);
  const timeoutPhase = normalizeAgentRunTimeoutPhase(input.timeoutPhase);
  const providerStarted = normalizeProviderStarted(input.providerStarted);
  const rawError = asNonEmptyString(input.error);
  // Queue and gateway-draining timeouts are wait-layer uncertainty. Provider
  // errors need explicit timeout attribution; providerStarted only proves reach.
  const hardTimeout =
    isHardAgentRunTimeoutPhase(timeoutPhase) ||
    (input.status === "timeout" && providerStarted === true);
  const aborted = isAbortedAgentStopReason(stopReason);
  // ACP/model `stop` can be a normal successful finish. Treat rpc/stop as
  // cancellation only for non-success terminal payloads from abort paths.
  const cancelled = input.status !== "ok" && isCancellationStopReason(stopReason);
  const blocked = isBlockedLivenessState(livenessState);
  const error = hardTimeout
    ? rawError
    : blocked
      ? formatBlockedLivenessError(rawError)
      : aborted && !rawError
        ? AGENT_RUN_ABORTED_ERROR
        : rawError;
  const reason: AgentRunTerminalReason = hardTimeout
    ? "hard_timeout"
    : blocked
      ? "blocked"
      : aborted
        ? "aborted"
        : cancelled
          ? "cancelled"
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
        : reason === "hard_timeout" ||
            (input.status === "timeout" && (reason === "timed_out" || reason === "cancelled"))
          ? "timeout"
          : "error",
    ...(error ? { error } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(livenessState ? { livenessState } : {}),
    ...(timeoutPhase ? { timeoutPhase } : {}),
    ...(providerStarted !== undefined ? { providerStarted } : {}),
    ...(asFiniteTimestamp(input.startedAt) !== undefined
      ? { startedAt: asFiniteTimestamp(input.startedAt) }
      : {}),
    ...(asFiniteTimestamp(input.endedAt) !== undefined
      ? { endedAt: asFiniteTimestamp(input.endedAt) }
      : {}),
  };
}

/** Builds a terminal outcome from a wait result, ignoring pending/unknown status. */
/** Builds a terminal outcome from wait paths where status may still be pending/unknown. */
export function buildAgentRunTerminalOutcomeFromWaitResult(
  wait: AgentRunTerminalWaitInput | undefined,
): AgentRunTerminalOutcome | undefined {
  const status = asAgentRunWaitStatus(wait?.status);
  if (!status || status === "pending") {
    return undefined;
  }
  return buildAgentRunTerminalOutcome({
    status,
    error: wait?.error,
    stopReason: wait?.stopReason,
    livenessState: wait?.livenessState,
    timeoutPhase: wait?.timeoutPhase,
    providerStarted: wait?.providerStarted,
    startedAt: wait?.startedAt,
    endedAt: wait?.endedAt,
  });
}

function completedBeforeOrAtTimeout(params: {
  completed: AgentRunTerminalOutcome;
  timeout: AgentRunTerminalOutcome;
}): boolean {
  return (
    params.completed.reason === "completed" &&
    typeof params.completed.endedAt === "number" &&
    typeof params.timeout.endedAt === "number" &&
    params.completed.endedAt <= params.timeout.endedAt
  );
}

/** Merges terminal outcomes while preserving cancellation and hard-timeout ownership. */
/** Merges later terminal observations without overwriting sticky cancellation/hard-timeout state. */
export function mergeAgentRunTerminalOutcome(
  current: AgentRunTerminalOutcome | undefined,
  incoming: AgentRunTerminalOutcome,
): AgentRunTerminalOutcome {
  if (!current) {
    return incoming;
  }
  if (current.reason === "cancelled") {
    return current;
  }
  // A hard timeout owns the run unless later evidence proves completion ended
  // before that timeout; late abort/error cleanup must not downgrade it.
  if (isHardAgentRunTimeoutOutcome(current)) {
    return completedBeforeOrAtTimeout({ completed: incoming, timeout: current })
      ? incoming
      : current;
  }
  if (incoming.reason === "cancelled") {
    return incoming;
  }
  if (isHardAgentRunTimeoutOutcome(incoming)) {
    return completedBeforeOrAtTimeout({ completed: current, timeout: incoming })
      ? current
      : incoming;
  }
  return incoming;
}
