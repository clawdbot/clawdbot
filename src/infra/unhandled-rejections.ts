import process from "node:process";

import { formatUncaughtError } from "./errors.js";

type UnhandledRejectionHandler = (reason: unknown) => boolean;

const handlers = new Set<UnhandledRejectionHandler>();

/**
 * Checks if an error is an AbortError.
 * These are typically intentional cancellations (e.g., during shutdown) and shouldn't crash.
 */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String(err.name) : "";
  if (name === "AbortError") return true;
  // Check for "This operation was aborted" message from Node's undici
  const message = "message" in err && typeof err.message === "string" ? err.message : "";
  if (message === "This operation was aborted") return true;
  return false;
}

// Network error codes that indicate transient failures (shouldn't crash the gateway)
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNABORTED",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function getErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function getErrorCause(err: unknown): unknown {
  if (!err || typeof err !== "object") return undefined;
  return (err as { cause?: unknown }).cause;
}

/**
 * Checks if an error is a transient network error that shouldn't crash the gateway.
 * These are typically temporary connectivity issues that will resolve on their own.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (!err) return false;

  // Check the error itself
  const code = getErrorCode(err);
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;

  // "fetch failed" TypeError from undici (Node's native fetch)
  if (err instanceof TypeError && err.message === "fetch failed") {
    const cause = getErrorCause(err);
    // The cause often contains the actual network error
    if (cause) return isTransientNetworkError(cause);
    // Even without a cause, "fetch failed" is typically a network issue
    return true;
  }

  // Check the cause chain recursively
  const cause = getErrorCause(err);
  if (cause && cause !== err) {
    return isTransientNetworkError(cause);
  }

  // AggregateError may wrap multiple causes
  if (err instanceof AggregateError && err.errors?.length) {
    return err.errors.some((e) => isTransientNetworkError(e));
  }

  return false;
}

export function registerUnhandledRejectionHandler(handler: UnhandledRejectionHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function isUnhandledRejectionHandled(reason: unknown): boolean {
  for (const handler of handlers) {
    try {
      if (handler(reason)) return true;
    } catch (err) {
      console.error(
        "[moltbot] Unhandled rejection handler failed:",
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
    }
  }
  return false;
}

export function installUnhandledRejectionHandler(): void {
  process.on("unhandledRejection", (reason, _promise) => {
    if (isUnhandledRejectionHandled(reason)) return;

    // AbortError is typically an intentional cancellation (e.g., during shutdown)
    // Log it but don't crash - these are expected during graceful shutdown
    if (isAbortError(reason)) {
      console.warn("[moltbot] Suppressed AbortError:", formatUncaughtError(reason));
      return;
    }

    // Transient network errors (fetch failed, connection reset, etc.) shouldn't crash
    // These are temporary connectivity issues that will resolve on their own
    if (isTransientNetworkError(reason)) {
      console.error("[moltbot] Network error (non-fatal):", formatUncaughtError(reason));
      return;
    }

    console.error("[moltbot] Unhandled promise rejection:", formatUncaughtError(reason));
    process.exit(1);
  });
}
