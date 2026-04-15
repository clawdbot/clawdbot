import { RateLimitError } from "@buape/carbon";
import {
  createRateLimitRetryRunner,
  type RetryConfig,
  type RetryRunner,
} from "openclaw/plugin-sdk/retry-runtime";

export const DISCORD_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: 0.1,
} satisfies RetryConfig;

export function createDiscordRetryRunner(params: {
  retry?: RetryConfig;
  configRetry?: RetryConfig;
  verbose?: boolean;
}): RetryRunner {
  return createRateLimitRetryRunner({
    ...params,
    defaults: DISCORD_RETRY_DEFAULTS,
    logLabel: "discord",
    shouldRetry: (err) => err instanceof RateLimitError,
    retryAfterMs: (err) => (err instanceof RateLimitError ? err.retryAfter * 1000 : undefined),
  });
}
