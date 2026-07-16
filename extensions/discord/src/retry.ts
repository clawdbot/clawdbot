// Discord plugin module implements retry behavior.
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  readErrorName,
} from "openclaw/plugin-sdk/error-runtime";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  createChannelApiRetryRunner,
  resolveRetryConfig,
  type RetryConfig,
} from "openclaw/plugin-sdk/retry-runtime";
import { RateLimitError } from "./internal/discord.js";

const DISCORD_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: 0.1,
} satisfies RetryConfig;
const DISCORD_GATEWAY_RECONNECT_EXTRA_ATTEMPTS = 2;

const DISCORD_RETRYABLE_STATUS_CODES = new Set([408, 429]);
const DISCORD_RETRYABLE_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const DISCORD_TRANSIENT_MESSAGE_RE =
  /\b(?:bad gateway|fetch failed|network error|networkerror|service unavailable|socket hang up|temporarily unavailable|timed out|timeout)\b|connection (?:closed|reset|refused)/i;
const DISCORD_PRECONNECT_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
]);
type DiscordRetrySafety = "idempotent" | "nonce-protected-create" | "non-idempotent-create";

export type DiscordRetryRunner = <T>(
  fn: () => Promise<T>,
  label?: string,
  options?: { safety: DiscordRetrySafety },
) => Promise<T>;

function readDiscordErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const raw =
    "status" in err && err.status !== undefined
      ? err.status
      : "statusCode" in err && err.statusCode !== undefined
        ? err.statusCode
        : undefined;
  return parseStrictNonNegativeInteger(raw);
}

function isRetryableDiscordTransientError(err: unknown): boolean {
  if (err instanceof RateLimitError) {
    return true;
  }
  for (const candidate of collectErrorGraphCandidates(err, (current) => [
    current.cause,
    current.error,
  ])) {
    const status = readDiscordErrorStatus(candidate);
    if (status !== undefined && (DISCORD_RETRYABLE_STATUS_CODES.has(status) || status >= 500)) {
      return true;
    }
    const code = extractErrorCode(candidate);
    if (code && DISCORD_RETRYABLE_ERROR_CODES.has(code.toUpperCase())) {
      return true;
    }
    if (readErrorName(candidate) === "AbortError") {
      return true;
    }
    if (
      (candidate instanceof Error || (candidate !== null && typeof candidate === "object")) &&
      DISCORD_TRANSIENT_MESSAGE_RE.test(formatErrorMessage(candidate))
    ) {
      return true;
    }
  }
  return false;
}

function isRetryableDiscordPreConnectError(err: unknown): boolean {
  if (err instanceof RateLimitError) {
    return true;
  }
  for (const candidate of collectErrorGraphCandidates(err, (current) => [
    current.cause,
    current.error,
  ])) {
    if (readDiscordErrorStatus(candidate) === 429) {
      return true;
    }
    const code = extractErrorCode(candidate);
    if (code && DISCORD_PRECONNECT_ERROR_CODES.has(code.toUpperCase())) {
      return true;
    }
  }
  return false;
}

function resolveDiscordRetryPredicate(safety: DiscordRetrySafety) {
  return safety === "non-idempotent-create"
    ? isRetryableDiscordPreConnectError
    : isRetryableDiscordTransientError;
}

function isRetryableDiscordGatewayTransportError(err: unknown): boolean {
  if (!isRetryableDiscordTransientError(err) || err instanceof RateLimitError) {
    return false;
  }
  return !collectErrorGraphCandidates(err, (current) => [current.cause, current.error]).some(
    (candidate) => readDiscordErrorStatus(candidate) !== undefined,
  );
}

export function createDiscordRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
  isGatewayDisconnected?: () => boolean;
}): DiscordRetryRunner {
  const retryConfig = resolveRetryConfig(DISCORD_RETRY_DEFAULTS, {
    ...params.configRetry,
    ...params.retry,
  });
  // Extend only the per-request runner. A delivery may contain several REST
  // writes, so replaying its outer adapter can duplicate already-sent chunks.
  const attempts =
    retryConfig.attempts > 1
      ? retryConfig.attempts + DISCORD_GATEWAY_RECONNECT_EXTRA_ATTEMPTS
      : retryConfig.attempts;

  return <T>(fn: () => Promise<T>, label?: string, options?: { safety: DiscordRetrySafety }) => {
    const isRetryable = resolveDiscordRetryPredicate(options?.safety ?? "idempotent");
    let observedGatewayDisconnect = false;
    const runRequest = async () => {
      observedGatewayDisconnect ||= params.isGatewayDisconnected?.() === true;
      try {
        return await fn();
      } catch (err) {
        observedGatewayDisconnect ||= params.isGatewayDisconnected?.() === true;
        throw err;
      }
    };
    const runWithRetry = createChannelApiRetryRunner({
      retry: { ...retryConfig, attempts },
      shouldRetry: (err, attempt) =>
        isRetryable(err) &&
        (attempt < retryConfig.attempts ||
          (observedGatewayDisconnect && isRetryableDiscordGatewayTransportError(err))),
      strictShouldRetry: true,
      retryAfterMs: (err) => (err instanceof RateLimitError ? err.retryAfter * 1000 : undefined),
      verbose: params.verbose,
    });
    return runWithRetry(runRequest, label);
  };
}
