import { RateLimitError } from "@buape/carbon";

import { formatErrorMessage } from "./errors.js";
import { type RetryConfig, resolveRetryConfig, retryAsync } from "./retry.js";

export type RetryRunner = <T>(fn: () => Promise<T>, label?: string) => Promise<T>;

export const DISCORD_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: 0.1,
};

export const TELEGRAM_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 400,
  maxDelayMs: 30_000,
  jitter: 0.1,
};

const TELEGRAM_RETRY_RE = /429|timeout|connect|reset|closed|unavailable|temporarily/i;

function getTelegramRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const candidate =
    "parameters" in err && err.parameters && typeof err.parameters === "object"
      ? (err.parameters as { retry_after?: unknown }).retry_after
      : "response" in err &&
          err.response &&
          typeof err.response === "object" &&
          "parameters" in err.response
        ? (
            err.response as {
              parameters?: { retry_after?: unknown };
            }
          ).parameters?.retry_after
        : "error" in err && err.error && typeof err.error === "object" && "parameters" in err.error
          ? (err.error as { parameters?: { retry_after?: unknown } }).parameters?.retry_after
          : undefined;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate * 1000 : undefined;
}

export function createDiscordRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
}): RetryRunner {
  const retryConfig = resolveRetryConfig(DISCORD_RETRY_DEFAULTS, {
    ...params.configRetry,
    ...params.retry,
  });
  return <T>(fn: () => Promise<T>, label?: string) =>
    retryAsync(fn, {
      ...retryConfig,
      label,
      shouldRetry: (err) => err instanceof RateLimitError,
      retryAfterMs: (err) => (err instanceof RateLimitError ? err.retryAfter * 1000 : undefined),
      onRetry: params.verbose
        ? (info) => {
            const labelText = info.label ?? "request";
            const maxRetries = Math.max(1, info.maxAttempts - 1);
            console.warn(
              `discord ${labelText} rate limited, retry ${info.attempt}/${maxRetries} in ${info.delayMs}ms`,
            );
          }
        : undefined,
    });
}

export function createTelegramRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
  shouldRetry?: (err: unknown) => boolean;
}): RetryRunner {
  const retryConfig = resolveRetryConfig(TELEGRAM_RETRY_DEFAULTS, {
    ...params.configRetry,
    ...params.retry,
  });
  const shouldRetry = params.shouldRetry
    ? (err: unknown) => params.shouldRetry?.(err) || TELEGRAM_RETRY_RE.test(formatErrorMessage(err))
    : (err: unknown) => TELEGRAM_RETRY_RE.test(formatErrorMessage(err));

  return <T>(fn: () => Promise<T>, label?: string) =>
    retryAsync(fn, {
      ...retryConfig,
      label,
      shouldRetry,
      retryAfterMs: getTelegramRetryAfterMs,
      onRetry: params.verbose
        ? (info) => {
            const maxRetries = Math.max(1, info.maxAttempts - 1);
            console.warn(
              `telegram send retry ${info.attempt}/${maxRetries} for ${info.label ?? label ?? "request"} in ${info.delayMs}ms: ${formatErrorMessage(info.err)}`,
            );
          }
        : undefined,
    });
}
