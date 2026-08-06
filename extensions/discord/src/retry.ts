// Discord plugin module implements retry behavior.
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  readErrorName,
} from "openclaw/plugin-sdk/error-runtime";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  classifyTransientNetworkErrorCode,
  createChannelApiRetryRunner,
  resolveRetryConfig,
  retryAsync,
  type RetryConfig,
} from "openclaw/plugin-sdk/retry-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { RateLimitError } from "./internal/discord.js";

const DISCORD_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: 0.1,
} satisfies RetryConfig;
const DISCORD_GATEWAY_RECONNECT_EXTRA_ATTEMPTS = 2;

const DISCORD_TRANSIENT_MESSAGE_RE =
  /\b(?:bad gateway|fetch failed|network error|networkerror|service unavailable|socket hang up|temporarily unavailable|timed out|timeout)\b|connection (?:closed|reset|refused)/i;
const ambiguousDiscordMessageCreates = new WeakSet<object>();
type DiscordRetrySafety = "idempotent" | "nonce-protected-create" | "non-idempotent-create";
type DiscordDeliveryFailure = "rejected" | "pre-connect" | "ambiguous" | "unknown";

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

export function classifyDiscordDeliveryFailure(error: unknown): DiscordDeliveryFailure {
  const candidates = collectErrorGraphCandidates(error, (current) => [
    current.cause,
    current.error,
  ]);

  // An HTTP response proves the request reached Discord, even with a nested transport error.
  for (const candidate of candidates) {
    const status = readDiscordErrorStatus(candidate);
    if (status !== undefined) {
      if (status === 408 || status >= 500) {
        return "ambiguous";
      }
      if (status >= 400) {
        return "rejected";
      }
    }
  }

  if (
    candidates.some(
      (candidate) =>
        readErrorName(candidate) === "AbortError" ||
        classifyTransientNetworkErrorCode(extractErrorCode(candidate)) === "ambiguous",
    )
  ) {
    return "ambiguous";
  }
  // A confirmed connect/DNS failure is safer than generic outer "fetch failed" wording.
  if (
    candidates.some(
      (candidate) =>
        classifyTransientNetworkErrorCode(extractErrorCode(candidate)) === "pre-connect",
    )
  ) {
    return "pre-connect";
  }
  return candidates.some(
    (candidate) =>
      (candidate instanceof Error || (candidate !== null && typeof candidate === "object")) &&
      DISCORD_TRANSIENT_MESSAGE_RE.test(formatErrorMessage(candidate)),
  )
    ? "ambiguous"
    : "unknown";
}

export function recordDiscordMessageCreateAmbiguity(error: unknown): void {
  if (error !== null && typeof error === "object") {
    ambiguousDiscordMessageCreates.add(error);
  }
}

export function hasDiscordMessageCreateAmbiguity(error: unknown): boolean {
  return collectErrorGraphCandidates(error, (current) => [current.cause, current.error]).some(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      ambiguousDiscordMessageCreates.has(candidate),
  );
}

function hasDiscordRateLimitRejection(error: unknown): boolean {
  return (
    error instanceof RateLimitError ||
    collectErrorGraphCandidates(error, (current) => [current.cause, current.error]).some(
      (candidate) => readDiscordErrorStatus(candidate) === 429,
    )
  );
}

function isRetryableDiscordTransientError(error: unknown): boolean {
  const failure = classifyDiscordDeliveryFailure(error);
  return (
    failure === "ambiguous" || failure === "pre-connect" || hasDiscordRateLimitRejection(error)
  );
}

function isRetryableDiscordPreConnectError(error: unknown): boolean {
  const failure = classifyDiscordDeliveryFailure(error);
  return (
    failure === "pre-connect" || (failure === "rejected" && hasDiscordRateLimitRejection(error))
  );
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
  verbose?: boolean;
  isGatewayDisconnected?: () => boolean;
  signal?: AbortSignal;
}): DiscordRetryRunner {
  const retryConfig = resolveRetryConfig(DISCORD_RETRY_DEFAULTS, params.retry);
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
      if (params.signal?.aborted) {
        throw params.signal.reason instanceof Error
          ? params.signal.reason
          : new Error("Discord request aborted");
      }
      observedGatewayDisconnect ||= params.isGatewayDisconnected?.() === true;
      try {
        return await fn();
      } catch (err) {
        observedGatewayDisconnect ||= params.isGatewayDisconnected?.() === true;
        throw err;
      }
    };
    const shouldRetry = (err: unknown, attempt: number) =>
      isRetryable(err) &&
      (attempt < retryConfig.attempts ||
        (observedGatewayDisconnect && isRetryableDiscordGatewayTransportError(err)));
    const retryAfterMs = (err: unknown) =>
      err instanceof RateLimitError ? err.retryAfter * 1000 : undefined;
    const signal = params.signal;
    if (signal) {
      return retryAsync(runRequest, {
        ...retryConfig,
        attempts,
        label,
        shouldRetry,
        retryAfterMs,
        sleep: async (delayMs) => {
          try {
            await sleepWithAbort(delayMs, signal);
          } catch (error) {
            // Preserve the owner's timeout error and clear the pending retry timer
            // when a webhook deadline expires in the middle of Discord backoff.
            throw signal.aborted && signal.reason instanceof Error ? signal.reason : error;
          }
        },
      });
    }
    const runWithRetry = createChannelApiRetryRunner({
      retry: { ...retryConfig, attempts },
      shouldRetry,
      strictShouldRetry: true,
      retryAfterMs,
      verbose: params.verbose,
    });
    return runWithRetry(runRequest, label);
  };
}
