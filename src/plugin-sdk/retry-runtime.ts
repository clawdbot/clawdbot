// Public retry helpers for plugins that need retry config or policy runners.

/** Transient failures that prove the request did not reach the remote server. */
const PRE_CONNECT_NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Network failures that are transient for idempotent or deduplicated requests. */
const TRANSIENT_NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  ...PRE_CONNECT_NETWORK_ERROR_CODES,
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Classifies a normalized transport code without imposing a plugin-specific error shape. */
export function classifyTransientNetworkErrorCode(code: string | undefined) {
  const normalized = code?.trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }
  if (PRE_CONNECT_NETWORK_ERROR_CODES.has(normalized)) {
    return "pre-connect";
  }
  return TRANSIENT_NETWORK_ERROR_CODES.has(normalized) ? "ambiguous" : undefined;
}

export {
  resolveRetryConfig,
  retryAsync,
  type RetryConfig,
  type RetryInfo,
  type RetryOptions,
} from "../infra/retry.js";
export {
  createChannelApiRetryRunner,
  createRateLimitRetryRunner,
  /** @deprecated Use createChannelApiRetryRunner. */
  createChannelApiRetryRunner as createTelegramRetryRunner,
  CHANNEL_API_RETRY_DEFAULTS as TELEGRAM_RETRY_DEFAULTS,
  type RetryRunner,
} from "../infra/retry-policy.js";
export { parseRetryAfterHeaderSeconds } from "../infra/retry-after.js";
