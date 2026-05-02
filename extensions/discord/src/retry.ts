import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  readErrorName,
} from "openclaw/plugin-sdk/error-runtime";
import {
  createRateLimitRetryRunner,
  type RetryConfig,
  type RetryRunner,
} from "openclaw/plugin-sdk/retry-runtime";
import { RateLimitError } from "./internal/discord.js";

const DISCORD_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: 0.1,
} satisfies RetryConfig;

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
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    return Number(raw);
  }
  return undefined;
}

export function isRetryableDiscordTransientError(err: unknown): boolean {
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

export function createDiscordRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
}): RetryRunner {
  return createRateLimitRetryRunner({
    ...params,
    defaults: DISCORD_RETRY_DEFAULTS,
    logLabel: "discord",
    shouldRetry: isRetryableDiscordTransientError,
    retryAfterMs: (err) => (err instanceof RateLimitError ? err.retryAfter * 1000 : undefined),
  });
}
