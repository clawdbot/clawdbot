import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../infra/errors.js";

const TOOL_TIMEOUT_ERROR_CODES = new Set([
  "ERR_TIMEOUT",
  "ESOCKETTIMEDOUT",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

const TOOL_TIMEOUT_RESULT_STATUSES = new Set(["timeout", "timed_out"]);
const TOOL_BLOCKED_RESULT_STATUSES = new Set([
  "blocked",
  "denied",
  "forbidden",
  "disabled",
  "approval-unavailable",
]);
const TOOL_CANCELLED_RESULT_STATUSES = new Set(["aborted", "cancelled", "canceled", "killed"]);
const TOOL_FAILURE_RESULT_STATUSES = new Set([
  "error",
  "failed",
  "failure",
  ...TOOL_TIMEOUT_RESULT_STATUSES,
  ...TOOL_BLOCKED_RESULT_STATUSES,
  "unavailable",
  ...TOOL_CANCELLED_RESULT_STATUSES,
  "invalid",
]);

function hasToolResultStatus(status: string | undefined, statuses: ReadonlySet<string>): boolean {
  return status !== undefined && statuses.has(status);
}

function readToolErrorField(error: object, key: string): unknown {
  try {
    return key in error ? (error as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

function hasStructuredToolTimeoutIdentity(error: unknown): boolean {
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0 && seen.size < 8) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const name = readToolErrorField(current, "name");
    if (name === "TimeoutError") {
      return true;
    }
    const code = readToolErrorField(current, "code");
    if (typeof code === "string" && TOOL_TIMEOUT_ERROR_CODES.has(code.trim().toUpperCase())) {
      return true;
    }
    for (const key of ["reason", "status"] as const) {
      const value = readToolErrorField(current, key);
      const normalized = normalizeOptionalLowercaseString(value);
      if (hasToolResultStatus(normalized, TOOL_TIMEOUT_RESULT_STATUSES)) {
        return true;
      }
      if (value && typeof value === "object") {
        pending.push(value);
      }
    }
    const cause = readToolErrorField(current, "cause");
    if (cause && typeof cause === "object") {
      pending.push(cause);
    }
  }
  return false;
}

export function readToolResultDetails(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  try {
    const details = readToolErrorField(result, "details");
    return details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function readToolResultStatus(result: unknown): string | undefined {
  const details = readToolResultDetails(result);
  return normalizeOptionalLowercaseString(
    details ? readToolErrorField(details, "status") : undefined,
  );
}

export function isToolResultError(result: unknown): boolean {
  const details = readToolResultDetails(result);
  const normalized = readToolResultStatus(result);
  const ok = details ? readToolErrorField(details, "ok") : undefined;
  const success = details ? readToolErrorField(details, "success") : undefined;
  const explicitlySuccessful = ok === true || success === true;
  if (ok === false || success === false) {
    return true;
  }
  const hasFailureStatus = hasToolResultStatus(normalized, TOOL_FAILURE_RESULT_STATUSES);
  if (hasFailureStatus && !explicitlySuccessful) {
    return true;
  }
  const timedOut = details ? readToolErrorField(details, "timedOut") : undefined;
  const error = details ? readToolErrorField(details, "error") : undefined;
  if (timedOut === true || Boolean(error)) {
    return true;
  }
  if (normalized === "completed") {
    return false;
  }
  const exitCode = details ? readToolErrorField(details, "exitCode") : undefined;
  return typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0;
}

export type ToolResultFailureKind = "blocked" | "cancelled" | "failed" | "timed_out";

/** Classify a thrown tool error without inferring cancellation from message text. */
export function resolveToolExecutionErrorKind(error: unknown): "failed" | "timed_out" {
  try {
    return hasStructuredToolTimeoutIdentity(error) ? "timed_out" : "failed";
  } catch {
    return "failed";
  }
}

/** Format a redacted tool error without allowing hostile getters to escape observability. */
export function formatToolExecutionErrorMessage(error: unknown, fallback: string): string {
  try {
    return formatErrorMessage(error) || fallback;
  } catch {
    return fallback;
  }
}

/** Classify a resolved structured tool result through the shared terminal contract. */
export function resolveToolResultFailureKind(result: unknown): ToolResultFailureKind | undefined {
  if (!isToolResultError(result)) {
    return undefined;
  }
  const status = readToolResultStatus(result);
  if (hasToolResultStatus(status, TOOL_BLOCKED_RESULT_STATUSES)) {
    return "blocked";
  }
  const details = readToolResultDetails(result);
  const timedOut = details ? readToolErrorField(details, "timedOut") : undefined;
  if (timedOut === true || hasToolResultStatus(status, TOOL_TIMEOUT_RESULT_STATUSES)) {
    return "timed_out";
  }
  if (hasToolResultStatus(status, TOOL_CANCELLED_RESULT_STATUSES)) {
    return "cancelled";
  }
  return "failed";
}
