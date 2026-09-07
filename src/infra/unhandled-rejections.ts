// Installs fatal and transient unhandled rejection/exception handlers.
import process from "node:process";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { restoreRuntimeTerminalState } from "../runtime.js";
import { isAbortError } from "./abort-signal.js";
import { collectNestedErrorCandidates, extractErrorCodeOrErrno } from "./error-graph-internal.js";
import { extractErrorCode, formatUncaughtError, readErrorCause, readErrorName } from "./errors.js";
import { runFatalErrorHooks } from "./fatal-error-hooks.js";
import { isTransientNetworkError } from "./retryable-network-errors.js";

export { isTransientNetworkError } from "./retryable-network-errors.js";

type UnhandledRejectionHandler = (reason: unknown) => boolean;
type UncaughtExceptionHandler = (error: unknown) => boolean;

// Plugins resolve `openclaw/plugin-sdk/runtime` through their own staged
// `node_modules`, which loads a separate copy of this module. To keep registry
// state shared across instances, anchor the handlers Set on globalThis.
const HANDLERS_GLOBAL_KEY = Symbol.for("openclaw.unhandledRejection.handlers");
const EXCEPTION_HANDLERS_GLOBAL_KEY = Symbol.for("openclaw.uncaughtException.handlers");
const handlers: Set<UnhandledRejectionHandler> = (() => {
  const g = globalThis as unknown as Record<symbol, Set<UnhandledRejectionHandler>>;
  const existing = g[HANDLERS_GLOBAL_KEY];
  if (existing instanceof Set) {
    return existing;
  }
  const created = new Set<UnhandledRejectionHandler>();
  g[HANDLERS_GLOBAL_KEY] = created;
  return created;
})();
const exceptionHandlers: Set<UncaughtExceptionHandler> = (() => {
  const g = globalThis as unknown as Record<symbol, Set<UncaughtExceptionHandler>>;
  const existing = g[EXCEPTION_HANDLERS_GLOBAL_KEY];
  if (existing instanceof Set) {
    return existing;
  }
  const created = new Set<UncaughtExceptionHandler>();
  g[EXCEPTION_HANDLERS_GLOBAL_KEY] = created;
  return created;
})();

const FATAL_ERROR_CODES = new Set([
  "ERR_OUT_OF_MEMORY",
  "ERR_SCRIPT_EXECUTION_TIMEOUT",
  "ERR_WORKER_OUT_OF_MEMORY",
  "ERR_WORKER_UNCAUGHT_EXCEPTION",
  "ERR_WORKER_INITIALIZATION_FAILED",
]);

const INVALID_CONFIG_ERROR_CODE = "INVALID_CONFIG";
const CONFIG_ERROR_CODES = new Set([
  INVALID_CONFIG_ERROR_CODE,
  "MISSING_API_KEY",
  "MISSING_CREDENTIALS",
]);
const EXIT_CONFIG_ERROR = 78;

const TRANSIENT_SQLITE_CODES = new Set([
  "SQLITE_BUSY",
  "SQLITE_CANTOPEN",
  "SQLITE_IOERR",
  "SQLITE_LOCKED",
]);

const TRANSIENT_SQLITE_ERRCODES = new Set([5, 6, 10, 14]);

const BENIGN_UNCAUGHT_EXCEPTION_CODES = new Set(["EPIPE", "EIO"]);
const BENIGN_UNCAUGHT_EXCEPTION_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENETDOWN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_DNS_RESOLVE_FAILED",
  "UND_ERR_CONNECT",
  "ERR_HTTP2_INVALID_SESSION",
]);

const BENIGN_UNCAUGHT_EXCEPTION_NETWORK_MESSAGE_CODE_RE =
  /\b(ECONNREFUSED|ENETDOWN|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_DNS_RESOLVE_FAILED|UND_ERR_CONNECT|ERR_HTTP2_INVALID_SESSION)\b/i;
const WS_PRE_HANDSHAKE_CLOSE_MESSAGE = "websocket was closed before the connection was established";
const UNDICI_TERMINATED_TYPE_ERROR_MESSAGE = "terminated";

const TRANSIENT_SQLITE_MESSAGE_CODE_RE =
  /\b(SQLITE_BUSY|SQLITE_CANTOPEN|SQLITE_IOERR|SQLITE_LOCKED)\b/i;

const TRANSIENT_SQLITE_MESSAGE_SNIPPETS = [
  "unable to open database file",
  "database is locked",
  "database table is locked",
  "disk i/o error",
];

function hasSqliteSignal(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }

  const code = extractErrorCode(err);
  if (typeof code === "string") {
    const normalizedCode = code.trim().toUpperCase();
    if (normalizedCode === "ERR_SQLITE_ERROR" || normalizedCode.startsWith("SQLITE_")) {
      return true;
    }
  }

  const name = normalizeLowercaseStringOrEmpty(readErrorName(err));
  if (name.includes("sqlite")) {
    return true;
  }

  const message =
    "message" in err && typeof err.message === "string"
      ? normalizeLowercaseStringOrEmpty(err.message)
      : "";
  if (message.includes("sqlite")) {
    return true;
  }

  return false;
}

function isBenignUncaughtNetworkMessage(message: string): boolean {
  if (BENIGN_UNCAUGHT_EXCEPTION_NETWORK_MESSAGE_CODE_RE.test(message)) {
    return true;
  }

  // `ws` emits this exact Error when close()/terminate() aborts a CONNECTING socket.
  // Keep exact matching so arbitrary WebSocket errors still take the fatal path.
  return message === WS_PRE_HANDSHAKE_CLOSE_MESSAGE;
}

function extractNumericErrorCode(err: unknown, key: "errno" | "errcode"): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const value = (err as Record<"errno" | "errcode", unknown>)[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function extractErrorCodeWithCause(err: unknown): string | undefined {
  const direct = extractErrorCode(err);
  if (direct) {
    return direct;
  }
  return extractErrorCode(readErrorCause(err));
}

function isFatalError(err: unknown): boolean {
  const code = extractErrorCodeWithCause(err);
  return code !== undefined && FATAL_ERROR_CODES.has(code);
}

function isConfigError(err: unknown): boolean {
  const code = extractErrorCodeWithCause(err);
  return code !== undefined && CONFIG_ERROR_CODES.has(code);
}

export function isTransientSqliteError(err: unknown): boolean {
  if (!err) {
    return false;
  }

  for (const candidate of collectNestedErrorCandidates(err)) {
    const code = extractErrorCodeOrErrno(candidate);
    if (code && TRANSIENT_SQLITE_CODES.has(code)) {
      return true;
    }

    if (!hasSqliteSignal(candidate)) {
      continue;
    }

    const sqliteErrcode = extractNumericErrorCode(candidate, "errcode");
    if (sqliteErrcode !== undefined && TRANSIENT_SQLITE_ERRCODES.has(sqliteErrcode)) {
      return true;
    }

    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const messageParts = [
      (candidate as { message?: unknown }).message,
      (candidate as { errstr?: unknown }).errstr,
    ];
    for (const rawMessage of messageParts) {
      const message = normalizeLowercaseStringOrEmpty(rawMessage);
      if (!message) {
        continue;
      }
      if (TRANSIENT_SQLITE_MESSAGE_CODE_RE.test(message)) {
        return true;
      }
      if (TRANSIENT_SQLITE_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Checks if an error is a transient file watcher error that shouldn't crash the gateway.
 * These are typically resource exhaustion issues (e.g., inotify watches exhausted) that
 * can be recovered from by degrading to manual sync mode.
 *
 * Note: ENOSPC is a general POSIX error code (disk full, write failures, etc.).
 * To avoid misclassifying unrelated storage failures, we require both the ENOSPC code
 * AND a watch/inotify-related message indicator, similar to how hasSqliteSignal gates
 * SQLite errors.
 */
export function isTransientFileWatchError(err: unknown): boolean {
  if (!err) {
    return false;
  }

  const hasFileWatchSignal = (message: string) =>
    message.includes("inotify") ||
    message.includes("watcher") ||
    message.includes("file watcher") ||
    message.includes("watch limit") ||
    message.includes("max watches");
  const hasFileWatchExhaustionSignal = (message: string) =>
    message.includes("inotify watches") ||
    message.includes("inotify watch") ||
    message.includes("system limit for number of file watchers") ||
    message.includes("watch limit") ||
    message.includes("max watches");

  for (const candidate of collectNestedErrorCandidates(err)) {
    // Skip non-object candidates early
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const code = extractErrorCodeOrErrno(candidate);
    const rawMessage =
      "message" in candidate && typeof candidate.message === "string" ? candidate.message : "";
    const message = normalizeLowercaseStringOrEmpty(rawMessage);

    // ENOSPC requires both the code AND a watch/inotify message indicator
    // to avoid misclassifying general disk-full errors as transient watcher errors.
    if (code === "ENOSPC") {
      if (hasFileWatchSignal(message)) {
        return true;
      }
      // ENOSPC without watch indicator is not classified here
      continue;
    }

    // Without an ENOSPC code, only classify explicit watcher resource exhaustion.
    // Generic "file watcher failed" labels can wrap permission/config/runtime failures.
    if (!message) {
      continue;
    }
    if (
      (message.includes("no space left on device") && hasFileWatchSignal(message)) ||
      hasFileWatchExhaustionSignal(message)
    ) {
      return true;
    }
  }

  return false;
}

export function isTransientUnhandledRejectionError(err: unknown): boolean {
  return (
    isTransientNetworkError(err) || isTransientSqliteError(err) || isTransientFileWatchError(err)
  );
}

function isBenignUncaughtNetworkException(err: unknown): boolean {
  for (const candidate of collectNestedErrorCandidates(err)) {
    // Undici emits this bare TypeError when a response body aborts after request start.
    // Keep the shape exact so unrelated "terminated" errors still take the fatal path.
    if (
      candidate instanceof TypeError &&
      normalizeLowercaseStringOrEmpty(candidate.message) === UNDICI_TERMINATED_TYPE_ERROR_MESSAGE
    ) {
      return true;
    }

    const code = extractErrorCodeOrErrno(candidate);
    if (code && BENIGN_UNCAUGHT_EXCEPTION_NETWORK_CODES.has(code)) {
      return true;
    }
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const message = normalizeLowercaseStringOrEmpty((candidate as { message?: unknown }).message);
    if (message && isBenignUncaughtNetworkMessage(message)) {
      return true;
    }
  }
  return false;
}

export function isBenignUncaughtExceptionError(err: unknown): boolean {
  if (isBenignUncaughtNetworkException(err)) {
    return true;
  }
  for (const candidate of collectNestedErrorCandidates(err)) {
    const code = extractErrorCodeOrErrno(candidate);
    if (code && BENIGN_UNCAUGHT_EXCEPTION_CODES.has(code)) {
      return true;
    }
  }
  return false;
}

export function registerUnhandledRejectionHandler(handler: UnhandledRejectionHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

function isUnhandledRejectionHandled(reason: unknown): boolean {
  for (const handler of handlers) {
    try {
      if (handler(reason)) {
        return true;
      }
    } catch (err) {
      console.error(
        "[openclaw] Unhandled rejection handler failed:",
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
    }
  }
  return false;
}

export function registerUncaughtExceptionHandler(handler: UncaughtExceptionHandler): () => void {
  exceptionHandlers.add(handler);
  return () => {
    exceptionHandlers.delete(handler);
  };
}

export function isUncaughtExceptionHandled(error: unknown): boolean {
  for (const handler of exceptionHandlers) {
    try {
      if (handler(error)) {
        return true;
      }
    } catch (err) {
      console.error(
        "[openclaw] Uncaught exception handler failed:",
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
    }
  }
  return false;
}

export function installUnhandledRejectionHandler(): void {
  const exitWithTerminalRestore = (
    reason: string,
    error?: unknown,
    hookReason = reason,
    exitCode = 1,
  ) => {
    for (const message of runFatalErrorHooks({ reason: hookReason, error })) {
      console.error("[openclaw]", message);
    }
    restoreRuntimeTerminalState(reason, { resumeStdinIfPaused: false });
    process.exit(exitCode);
  };

  process.on("unhandledRejection", (reason, _promise) => {
    if (isUnhandledRejectionHandled(reason)) {
      return;
    }

    // AbortError is typically an intentional cancellation (e.g., during shutdown)
    // Log it but don't crash - these are expected during graceful shutdown
    if (isAbortError(reason)) {
      console.warn("[openclaw] Suppressed AbortError:", formatUncaughtError(reason));
      return;
    }

    if (isFatalError(reason)) {
      console.error("[openclaw] FATAL unhandled rejection:", formatUncaughtError(reason));
      exitWithTerminalRestore("fatal unhandled rejection", reason, "fatal_unhandled_rejection");
      return;
    }

    if (isConfigError(reason)) {
      console.error("[openclaw] CONFIGURATION ERROR - requires fix:", formatUncaughtError(reason));
      const exitCode =
        extractErrorCodeWithCause(reason) === INVALID_CONFIG_ERROR_CODE ? EXIT_CONFIG_ERROR : 1;
      exitWithTerminalRestore("configuration error", reason, "configuration_error", exitCode);
      return;
    }

    if (isTransientUnhandledRejectionError(reason)) {
      console.warn(
        "[openclaw] Non-fatal unhandled rejection (continuing):",
        formatUncaughtError(reason),
      );
      return;
    }

    console.error("[openclaw] Unhandled promise rejection:", formatUncaughtError(reason));
    exitWithTerminalRestore("unhandled rejection", reason, "unhandled_rejection");
  });
}
