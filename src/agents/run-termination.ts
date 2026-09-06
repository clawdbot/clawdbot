import {
  AGENT_RUN_ABORTED_STOP_REASON,
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  normalizeAgentRunTimeoutPhase,
  normalizeProviderStarted,
  type AgentRunTimeoutPhase,
} from "@openclaw/normalization-core/agent-run-terminal-outcome";
import {
  type FailoverError,
  findErrorProperty,
  isFailoverError,
  isSignalTimeoutReason,
} from "./failover/error.js";

/**
 * Shared agent run termination constants.
 *
 * Runtime and stream consumers use these stable literals to recognize user or
 * controller aborts without matching free-form error text.
 */
/** Error text used for aborted agent runs. */
export const AGENT_RUN_ABORTED_ERROR = "agent run aborted" as const;
export {
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  AGENT_RUN_SUPERSEDED_STOP_REASON,
  isAbortedAgentStopReason,
} from "@openclaw/normalization-core/agent-run-terminal-outcome";
/** Error text used for agent runs aborted by a gateway restart. */
export const AGENT_RUN_RESTART_ABORT_ERROR = "agent run aborted for restart" as const;
export const AGENT_RUN_SUPERSEDED_ERROR = "agent run superseded by a newer session writer" as const;

/**
 * Transports copy this code onto the persisted assistant message via
 * `errorCode`, so restart recovery can recognize its own abort without matching
 * free-form provider error text.
 */
export const AGENT_RUN_RESTART_ABORT_ERROR_CODE = "OPENCLAW_RESTART_ABORT";
const AGENT_RUN_SUPERSEDED_ABORT_ERROR_CODE = "AGENT_RUN_SUPERSEDED_ABORT";
const AGENT_RUN_DIRECT_ABORT_ERROR_CODE = "OPENCLAW_DIRECT_ABORT";

export function createAgentRunDirectAbortError(): Error {
  const error = new Error(AGENT_RUN_ABORTED_ERROR) as Error & { code: string };
  error.name = "AbortError";
  error.code = AGENT_RUN_DIRECT_ABORT_ERROR_CODE;
  return error;
}

function hasAgentRunAbortCode(value: unknown, code: string): boolean {
  try {
    return value instanceof Error && "code" in value && value.code === code;
  } catch {
    return false;
  }
}

export function isAgentRunDirectAbortReason(value: unknown): boolean {
  return hasAgentRunAbortCode(value, AGENT_RUN_DIRECT_ABORT_ERROR_CODE);
}

export function createAgentRunRestartAbortError(): Error {
  const error = new Error(AGENT_RUN_RESTART_ABORT_ERROR) as Error & { code: string };
  error.name = "AbortError";
  error.code = AGENT_RUN_RESTART_ABORT_ERROR_CODE;
  return error;
}

export function createAgentRunSupersededAbortError(): Error {
  const error = new Error(AGENT_RUN_SUPERSEDED_ERROR) as Error & { code: string };
  error.name = "AbortError";
  error.code = AGENT_RUN_SUPERSEDED_ABORT_ERROR_CODE;
  return error;
}

export function isAgentRunRestartAbortReason(value: unknown): boolean {
  return hasAgentRunAbortCode(value, AGENT_RUN_RESTART_ABORT_ERROR_CODE);
}

export function isAgentRunSupersededAbortReason(value: unknown): boolean {
  return hasAgentRunAbortCode(value, AGENT_RUN_SUPERSEDED_ABORT_ERROR_CODE);
}

export function throwAgentRunRestartAbortReason(value: unknown): void {
  if (isAgentRunRestartAbortReason(value)) {
    throw value;
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
    : isSignalTimeoutReason(signal.reason)
      ? "timeout"
      : AGENT_RUN_ABORTED_STOP_REASON;
  return {
    aborted: true,
    stopReason,
  };
}

function resolveRunErrorTimeout(error: unknown): FailoverError["timeout"] {
  try {
    // Retry categories include connection failures and HTTP 5xx. Only recorded
    // watchdog facts or an intentional TimeoutError establish a deadline.
    const timeout = findErrorProperty(error, (candidate) =>
      isFailoverError(candidate)
        ? candidate.timeout
        : isSignalTimeoutReason(candidate)
          ? { timeoutPhase: "provider" as const }
          : undefined,
    );
    if (!timeout) {
      return undefined;
    }
    const timeoutPhase = normalizeAgentRunTimeoutPhase(timeout.timeoutPhase);
    const providerStarted = normalizeProviderStarted(timeout.providerStarted);
    return {
      ...(timeoutPhase ? { timeoutPhase } : {}),
      ...(providerStarted !== undefined ? { providerStarted } : {}),
    };
  } catch {
    // Provider/runtime errors may expose hostile getters. Classification must
    // not replace the original failure or suppress its terminal event.
    return undefined;
  }
}

/** Preserve recorded run timeouts when no caller abort signal was raised. */
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
  providerStarted?: boolean;
} {
  const abortFields = resolveAgentRunAbortLifecycleFields(signal);
  if (abortFields.aborted) {
    return abortFields;
  }
  // A run-owned controller can stop work without aborting its caller's signal.
  if (isAgentRunDirectAbortReason(error)) {
    return { aborted: true, stopReason: "aborted" };
  }
  if (isAgentRunRestartAbortReason(error)) {
    return { aborted: true, stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON };
  }
  const timeout = resolveRunErrorTimeout(error);
  return timeout ? { stopReason: "timeout", ...timeout } : {};
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
  const terminal = resolveAgentRunErrorLifecycleFields(params.error, params.abortSignal);
  if (terminal.stopReason === "timeout") {
    return "timed_out";
  }
  if (terminal.aborted) {
    return "cancelled";
  }
  const { error } = params;
  try {
    if (error instanceof Error && error.name === "AbortError") {
      return "cancelled";
    }
  } catch {
    // Run errors may expose hostile getters. Classification must not replace
    // the original failure or suppress its terminal event.
  }
  return "failed";
}
