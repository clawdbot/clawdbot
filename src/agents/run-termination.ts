import { isFailoverError, isTimeoutError } from "./failover-error.js";
import type { AgentRunTimeoutPhase } from "./run-timeout-attribution.js";

/**
 * Shared agent run termination constants.
 *
 * Runtime and stream consumers use these stable literals to recognize user or
 * controller aborts without matching free-form error text.
 */
/** Stop reason emitted when an agent run is aborted. */
const AGENT_RUN_ABORTED_STOP_REASON = "aborted" as const;
/** Error text used for aborted agent runs. */
export const AGENT_RUN_ABORTED_ERROR = "agent run aborted" as const;
export const AGENT_RUN_RESTART_ABORT_STOP_REASON = "restart" as const;

const AGENT_RUN_RESTART_ABORT_ERROR_CODE = "OPENCLAW_RESTART_ABORT";
const AGENT_RUN_DIRECT_ABORT_ERROR_CODE = "OPENCLAW_DIRECT_ABORT";

export function createAgentRunDirectAbortError(): Error {
  const error = new Error(AGENT_RUN_ABORTED_ERROR) as Error & { code: string };
  error.name = "AbortError";
  error.code = AGENT_RUN_DIRECT_ABORT_ERROR_CODE;
  return error;
}

export function isAgentRunDirectAbortReason(value: unknown): boolean {
  return (
    value instanceof Error && "code" in value && value.code === AGENT_RUN_DIRECT_ABORT_ERROR_CODE
  );
}

export function createAgentRunRestartAbortError(): Error {
  const error = new Error("agent run aborted for restart") as Error & { code: string };
  error.name = "AbortError";
  error.code = AGENT_RUN_RESTART_ABORT_ERROR_CODE;
  return error;
}

export function isAgentRunRestartAbortReason(value: unknown): boolean {
  try {
    return (
      value instanceof Error && "code" in value && value.code === AGENT_RUN_RESTART_ABORT_ERROR_CODE
    );
  } catch {
    return false;
  }
}

export function throwAgentRunRestartAbortReason(value: unknown): void {
  if (isAgentRunRestartAbortReason(value)) {
    throw value;
  }
}

function isAgentRunTimeoutAbortReason(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  try {
    return "name" in value && value.name === "TimeoutError";
  } catch {
    return false;
  }
}

export function resolveAgentRunAbortLifecycleFields(signal: AbortSignal | undefined): {
  aborted?: true;
  stopReason?:
    | typeof AGENT_RUN_ABORTED_STOP_REASON
    | typeof AGENT_RUN_RESTART_ABORT_STOP_REASON
    | "timeout";
} {
  if (!signal?.aborted) {
    return {};
  }
  const stopReason = isAgentRunRestartAbortReason(signal.reason)
    ? AGENT_RUN_RESTART_ABORT_STOP_REASON
    : isAgentRunTimeoutAbortReason(signal.reason)
      ? "timeout"
      : AGENT_RUN_ABORTED_STOP_REASON;
  return {
    aborted: true,
    stopReason,
  };
}

function isProviderTimeoutError(error: unknown): boolean {
  try {
    const candidate = isFailoverError(error)
      ? error
      : error instanceof Error
        ? error.cause
        : undefined;
    return isFailoverError(candidate) && candidate.reason === "timeout";
  } catch {
    // Provider/runtime errors may expose hostile getters. Classification must
    // not replace the original failure or suppress its terminal event.
    return false;
  }
}

/** Preserve structured provider watchdog timeouts when no abort signal was raised. */
export function resolveAgentRunErrorLifecycleFields(
  error: unknown,
  signal: AbortSignal | undefined,
): {
  aborted?: true;
  stopReason?:
    | typeof AGENT_RUN_ABORTED_STOP_REASON
    | typeof AGENT_RUN_RESTART_ABORT_STOP_REASON
    | "timeout";
  timeoutPhase?: AgentRunTimeoutPhase;
} {
  const abortFields = resolveAgentRunAbortLifecycleFields(signal);
  if (abortFields.aborted) {
    return abortFields;
  }
  if (!isProviderTimeoutError(error)) {
    return {};
  }
  return {
    stopReason: "timeout",
    timeoutPhase: "provider",
  };
}

/** Returns whether a stop reason is the stable aborted-run reason. */
export function isAbortedAgentStopReason(
  value: unknown,
): value is typeof AGENT_RUN_ABORTED_STOP_REASON | typeof AGENT_RUN_RESTART_ABORT_STOP_REASON {
  return value === AGENT_RUN_ABORTED_STOP_REASON || value === AGENT_RUN_RESTART_ABORT_STOP_REASON;
}

/**
 * CLI tool terminal reason for one-shot and live runners.
 * Abort-signal lifecycle is authoritative so a timeout abort stays timed_out
 * even when the delivered error is a generic AbortError.
 */
export function resolveCliToolTerminalReason(params: {
  error?: unknown;
  abortSignal?: AbortSignal;
}): "timed_out" | "cancelled" | "failed" {
  const abortFields = resolveAgentRunAbortLifecycleFields(params.abortSignal);
  if (abortFields.aborted) {
    return abortFields.stopReason === "timeout" ? "timed_out" : "cancelled";
  }
  const { error } = params;
  try {
    if (isTimeoutError(error) || (isFailoverError(error) && error.reason === "timeout")) {
      return "timed_out";
    }
    if (error instanceof Error && error.name === "AbortError") {
      return "cancelled";
    }
  } catch {
    // Run errors may expose hostile getters. Classification must not replace
    // the original failure or suppress its terminal event.
  }
  return "failed";
}
