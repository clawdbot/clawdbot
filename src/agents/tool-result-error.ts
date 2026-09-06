import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { isTrustedSecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import {
  truncateSanitizedExternalContent,
  wrapExternalContent,
} from "../security/external-content.js";
import {
  consumeToolExecutionNotStarted,
  markToolExecutionNotStarted,
} from "./tool-effect-receipt.js";
import { isTrustedToolInputError } from "./tool-input-error.js";

const TOOL_TIMEOUT_ERROR_CODES = new Set([
  "ERR_TIMEOUT",
  "ESOCKETTIMEDOUT",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);
const NETWORK_TOOL_ERROR_MAX_CHARS = 4_000;
const protectedNetworkToolErrors = new WeakSet<object>();
const protectedNetworkToolTimeoutErrors = new WeakSet<object>();

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
      if (normalized === "timeout" || normalized === "timed_out") {
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
  const hasFailureStatus =
    normalized === "error" ||
    normalized === "failed" ||
    normalized === "failure" ||
    normalized === "timeout" ||
    normalized === "timed_out" ||
    normalized === "blocked" ||
    normalized === "denied" ||
    normalized === "forbidden" ||
    normalized === "unavailable" ||
    normalized === "approval-unavailable" ||
    normalized === "disabled" ||
    normalized === "aborted" ||
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "killed" ||
    normalized === "invalid";
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
    return (typeof error === "object" &&
      error !== null &&
      protectedNetworkToolTimeoutErrors.has(error)) ||
      hasStructuredToolTimeoutIdentity(error)
      ? "timed_out"
      : "failed";
  } catch {
    return "failed";
  }
}

/** Authenticates host-owned preflight failures before a tool reaches untrusted network data. */
export function isTrustedToolExecutionPreflightError(error: unknown): boolean {
  return isTrustedSecretSurfaceUnavailableError(error) || isTrustedToolInputError(error);
}

/** Record host-owned proof that the protected operation never started, even if hooks ran. */
export function registerTrustedToolNoStartError<T>(error: T): T {
  return markToolExecutionNotStarted(error);
}

/** Consume one private no-start fact at the next authoritative lifecycle boundary. */
export function consumeTrustedToolNoStartError(error: unknown): boolean {
  return consumeToolExecutionNotStarted(error);
}

/** Format a redacted tool error without allowing hostile getters to escape observability. */
export function formatToolExecutionErrorMessage(error: unknown, fallback: string): string {
  try {
    return formatErrorMessage(error) || fallback;
  } catch {
    return fallback;
  }
}

/** Protect network-controlled failures once while preserving trusted cancellation and identity. */
export function protectNetworkToolExecutionError(
  error: unknown,
  fallback: string,
  signal?: AbortSignal,
): unknown {
  if (
    (signal?.aborted && error === signal.reason) ||
    isTrustedToolExecutionPreflightError(error) ||
    (typeof error === "object" && error !== null && protectedNetworkToolErrors.has(error))
  ) {
    return error;
  }
  const timedOut = resolveToolExecutionErrorKind(error) === "timed_out";
  const { text: message } = truncateSanitizedExternalContent(
    formatToolExecutionErrorMessage(error, fallback),
    NETWORK_TOOL_ERROR_MAX_CHARS,
  );
  // Error coercion traverses inherited causes; shadow them before preserving safe identity.
  const protectedError = new Error(wrapExternalContent(message, { source: "api" }));
  Object.defineProperty(protectedError, "cause", { value: undefined });
  try {
    if (error instanceof Error) {
      const prototype = Object.getPrototypeOf(error) as object;
      const safeTypes = [TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError];
      if (safeTypes.some((kind) => prototype === kind.prototype)) {
        Object.setPrototypeOf(protectedError, prototype);
      }
      for (const key of ["name", "code", "status"] as const) {
        const value: unknown = Object.getOwnPropertyDescriptor(error, key)?.value;
        const valid =
          key === "status"
            ? typeof value === "number" && Number.isSafeInteger(value)
            : typeof value === "string" &&
              /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) &&
              (key === "name" || value === value.toUpperCase());
        if (valid) {
          Object.defineProperty(protectedError, key, { configurable: true, value });
        }
      }
    }
  } catch {
    // Hostile reflection must never replace the already-protected network error.
  }
  protectedNetworkToolErrors.add(protectedError);
  if (timedOut) {
    protectedNetworkToolTimeoutErrors.add(protectedError);
  }
  return protectedError;
}

/** Classify a resolved structured tool result through the shared terminal contract. */
export function resolveToolResultFailureKind(result: unknown): ToolResultFailureKind | undefined {
  if (!isToolResultError(result)) {
    return undefined;
  }
  const status = readToolResultStatus(result);
  if (
    status === "blocked" ||
    status === "denied" ||
    status === "forbidden" ||
    status === "disabled" ||
    status === "approval-unavailable"
  ) {
    return "blocked";
  }
  const details = readToolResultDetails(result);
  const timedOut = details ? readToolErrorField(details, "timedOut") : undefined;
  if (timedOut === true || status === "timeout" || status === "timed_out") {
    return "timed_out";
  }
  if (
    status === "aborted" ||
    status === "cancelled" ||
    status === "canceled" ||
    status === "killed"
  ) {
    return "cancelled";
  }
  return "failed";
}
