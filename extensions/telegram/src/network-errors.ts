import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  PlatformMessageNotDispatchedError,
  readErrorName,
} from "openclaw/plugin-sdk/error-runtime";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { classifyTransientNetworkErrorCode } from "openclaw/plugin-sdk/retry-runtime";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const TELEGRAM_SUPERGROUP_MIGRATION_DESCRIPTION =
  "Bad Request: group chat was upgraded to a supergroup chat";

export class TelegramRequestNotStartedError extends Error {
  constructor(message = "Telegram request did not start", options?: ErrorOptions) {
    super(message, options);
    this.name = "TelegramRequestNotStartedError";
  }
}

function isTelegramRequestNotStartedError(err: unknown): boolean {
  return (
    err instanceof TelegramRequestNotStartedError ||
    (readErrorName(err) === "HttpError" &&
      (err as { error?: unknown }).error instanceof TelegramRequestNotStartedError)
  );
}

export function rethrowTelegramSendError(err: unknown): never {
  if (isTelegramRequestNotStartedError(err)) {
    throw new PlatformMessageNotDispatchedError("Telegram request not started", { cause: err });
  }
  const migrationRejection = describeTelegramSupergroupMigration(err);
  if (migrationRejection === undefined) {
    throw err;
  }
  throw new PlatformMessageNotDispatchedError(migrationRejection, { cause: err, retryable: false });
}

const TELEGRAM_ADDITIONAL_TRANSIENT_ERROR_CODES = new Set([
  "ENETDOWN",
  "ESOCKETTIMEDOUT",
  "EHOSTUNREACH",
  "UND_ERR_ABORTED",
  "ECONNABORTED",
  "ERR_NETWORK",
]);

// These exact local codes fail before request publication and are safe for
// non-idempotent sends. Resets and timeouts can occur after delivery, so
// retrying them could duplicate a visible message.
const TELEGRAM_ADDITIONAL_PRE_CONNECT_ERROR_CODES = new Set([
  "ENETDOWN", // Local network interface is down before connect completes (never sent)
  "EHOSTUNREACH", // Host unreachable (never sent)
]);

const RECOVERABLE_ERROR_NAMES = new Set([
  "AbortError",
  "TimeoutError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
]);

const ALWAYS_RECOVERABLE_MESSAGES = new Set(["fetch failed", "typeerror: fetch failed"]);
const GRAMMY_NETWORK_REQUEST_FAILED_AFTER_RE =
  /^network request(?:\s+for\s+["']?[^"']+["']?)?\s+failed\s+after\b.*[!.]?$/i;

const RECOVERABLE_MESSAGE_SNIPPETS = [
  "undici",
  "network error",
  "network request",
  "client network socket disconnected",
  "socket hang up",
  "getaddrinfo",
  "timeout", // catch timeout messages not covered by error codes/names
  "timed out", // grammY getUpdates returns "timed out after X seconds" (not matched by "timeout")
];

function collectTelegramErrorCandidates(err: unknown) {
  return collectErrorGraphCandidates(err, (current) => {
    const nested: Array<unknown> = [current.cause, current.reason];
    if (Array.isArray(current.errors)) {
      nested.push(...current.errors);
    }
    if (readErrorName(current) === "HttpError") {
      nested.push(current.error);
    }
    return nested;
  });
}

function normalizeCode(code?: string): string {
  return code?.trim().toUpperCase() ?? "";
}

function getErrorCode(err: unknown): string | undefined {
  const direct = extractErrorCode(err);
  if (direct) {
    return direct;
  }
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const errno = (err as { errno?: unknown }).errno;
  if (typeof errno === "string") {
    return errno;
  }
  if (typeof errno === "number") {
    return String(errno);
  }
  return undefined;
}

function classifyTelegramTransientNetworkError(err: unknown) {
  const code = normalizeCode(getErrorCode(err));
  return (
    classifyTransientNetworkErrorCode(code) ??
    (TELEGRAM_ADDITIONAL_PRE_CONNECT_ERROR_CODES.has(code)
      ? "pre-connect"
      : TELEGRAM_ADDITIONAL_TRANSIENT_ERROR_CODES.has(code)
        ? "ambiguous"
        : undefined)
  );
}

function getNumericHttpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const candidate = err as { error_code?: unknown; status?: unknown; statusCode?: unknown };
  for (const value of [candidate.error_code, candidate.status, candidate.statusCode]) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (/^\d+$/.test(trimmed)) {
        return parseStrictNonNegativeInteger(trimmed);
      }
    }
  }
  return undefined;
}

// Once a basic group is upgraded, its old id answers every send with this exact Bot API
// 400 (https://core.telegram.org/bots/api#making-requests). Matching the description
// literally keeps every other 400 retryable; `migrate_to_chat_id` is bounded at 52
// significant bits, so a non-safe integer is not the documented id and stays unreported.
function describeTelegramSupergroupMigration(err: unknown): string | undefined {
  for (const candidate of collectTelegramErrorCandidates(err)) {
    if (!isRecord(candidate) || candidate.error_code !== 400) {
      continue;
    }
    if (candidate.description !== TELEGRAM_SUPERGROUP_MIGRATION_DESCRIPTION) {
      continue;
    }
    const migratedChatId = isRecord(candidate.parameters)
      ? candidate.parameters.migrate_to_chat_id
      : undefined;
    return typeof migratedChatId === "number" && Number.isSafeInteger(migratedChatId)
      ? `Telegram rejected send: group migrated to supergroup ${migratedChatId}`
      : "Telegram rejected send: group migrated to a supergroup";
  }
  return undefined;
}

export function isTelegramMisdirectedRequestError(err: unknown): boolean {
  for (const candidate of collectTelegramErrorCandidates(err)) {
    const code = normalizeCode(getErrorCode(candidate));
    if (code === "421" || getNumericHttpStatus(candidate) === 421) {
      return true;
    }

    const message = normalizeLowercaseStringOrEmpty(formatErrorMessage(candidate));
    if (/\b421\b/.test(message) && message.includes("misdirected request")) {
      return true;
    }
  }
  return false;
}

type TelegramNetworkErrorContext =
  | "polling"
  | "send"
  | "webhook"
  | "delete"
  | "react"
  | "edit"
  | "action"
  | "unknown";
/** True only for channel-owned no-send proof or proven pre-connect failures. */
export function isSafeToRetrySendError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  if (err instanceof PlatformMessageNotDispatchedError) {
    return err.retryable;
  }
  if (isTelegramRequestNotStartedError(err)) {
    return true;
  }
  for (const candidate of collectTelegramErrorCandidates(err)) {
    if (classifyTelegramTransientNetworkError(candidate) === "pre-connect") {
      return true;
    }
  }
  return false;
}

export function shouldRetryTelegramSendError(err: unknown): boolean {
  return isSafeToRetrySendError(err) || isTelegramRateLimitError(err);
}

function hasTelegramErrorCode(err: unknown, matches: (code: number) => boolean): boolean {
  for (const candidate of collectTelegramErrorCandidates(err)) {
    if (!candidate || typeof candidate !== "object" || !("error_code" in candidate)) {
      continue;
    }
    const code = (candidate as { error_code: unknown }).error_code;
    if (typeof code === "number" && matches(code)) {
      return true;
    }
  }
  return false;
}

export function isTelegramAuthenticationError(err: unknown): boolean {
  return hasTelegramErrorCode(err, (code) => code === 401 || code === 404);
}

/** Reads Telegram's flood-control retry_after hint (in ms) from any error nesting shape. */
export function readTelegramRetryAfterMs(err: unknown): number | undefined {
  for (const candidate of collectTelegramErrorCandidates(err)) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const retryAfter =
      "parameters" in candidate && candidate.parameters && typeof candidate.parameters === "object"
        ? (candidate.parameters as { retry_after?: unknown }).retry_after
        : "response" in candidate &&
            candidate.response &&
            typeof candidate.response === "object" &&
            "parameters" in candidate.response
          ? (
              candidate.response as {
                parameters?: { retry_after?: unknown };
              }
            ).parameters?.retry_after
          : "error" in candidate &&
              candidate.error &&
              typeof candidate.error === "object" &&
              "parameters" in candidate.error
            ? (candidate.error as { parameters?: { retry_after?: unknown } }).parameters
                ?.retry_after
            : undefined;
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
      return retryAfter * 1000;
    }
  }
  return undefined;
}

/** Returns true for HTTP 5xx server errors (error may have been processed). */
export function isTelegramServerError(err: unknown): boolean {
  return hasTelegramErrorCode(err, (code) => code >= 500);
}

export function isTelegramRateLimitError(err: unknown): boolean {
  return (
    hasTelegramErrorCode(err, (code) => code === 429) ||
    (readTelegramRetryAfterMs(err) !== undefined &&
      /(?:^|\b)429\b|too many requests/i.test(formatErrorMessage(err)))
  );
}

const MESSAGE_NOT_MODIFIED_RE =
  /400:\s*Bad Request:\s*message is not modified|MESSAGE_NOT_MODIFIED/i;
const MESSAGE_HAS_NO_TEXT_RE = /400:\s*Bad Request:\s*there is no text in the message to edit/i;
const EDIT_TARGET_MISSING_RE =
  /400:\s*Bad Request:\s*message to edit not found|400:\s*Bad Request:\s*message can't be edited|MESSAGE_ID_INVALID/i;

/** True when Telegram rejected an edit because the content is unchanged; the message already shows the requested text. */
export function isTelegramMessageNotModifiedError(err: unknown): boolean {
  return MESSAGE_NOT_MODIFIED_RE.test(formatErrorMessage(err));
}

/** True when the edit target has no text body (e.g. media message needing a caption edit). */
export function isTelegramMessageHasNoTextError(err: unknown): boolean {
  return MESSAGE_HAS_NO_TEXT_RE.test(formatErrorMessage(err));
}

/** True when the edit target is gone or locked (deleted message, invalid id); retrying the same edit cannot succeed. */
export function isTelegramEditTargetMissingError(err: unknown): boolean {
  return EDIT_TARGET_MISSING_RE.test(formatErrorMessage(err));
}

/** Returns true for HTTP 4xx client errors (Telegram explicitly rejected, not applied). */
export function isTelegramClientRejection(err: unknown): boolean {
  return hasTelegramErrorCode(err, (code) => code >= 400 && code < 500);
}

export function isTelegramBadRequestError(err: unknown): boolean {
  return hasTelegramErrorCode(err, (code) => code === 400);
}

export function isRecoverableTelegramNetworkError(
  err: unknown,
  options: { context?: TelegramNetworkErrorContext; allowMessageMatch?: boolean } = {},
): boolean {
  if (!err) {
    return false;
  }
  if (isTelegramRequestNotStartedError(err)) {
    return true;
  }
  const allowMessageMatch =
    typeof options.allowMessageMatch === "boolean"
      ? options.allowMessageMatch
      : options.context !== "send";

  for (const candidate of collectTelegramErrorCandidates(err)) {
    if (classifyTelegramTransientNetworkError(candidate)) {
      return true;
    }

    const name = readErrorName(candidate);
    if (name && RECOVERABLE_ERROR_NAMES.has(name)) {
      return true;
    }

    const message = normalizeLowercaseStringOrEmpty(formatErrorMessage(candidate));
    if (message && ALWAYS_RECOVERABLE_MESSAGES.has(message)) {
      return true;
    }
    if (message && GRAMMY_NETWORK_REQUEST_FAILED_AFTER_RE.test(message)) {
      return true;
    }
    if (allowMessageMatch && message) {
      if (RECOVERABLE_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) {
        return true;
      }
    }
  }

  return false;
}

export function isRetryableTelegramApiError(
  err: unknown,
  options: { context?: TelegramNetworkErrorContext; allowMessageMatch?: boolean } = {},
): boolean {
  return (
    isRecoverableTelegramNetworkError(err, options) ||
    isTelegramServerError(err) ||
    isTelegramRateLimitError(err)
  );
}
