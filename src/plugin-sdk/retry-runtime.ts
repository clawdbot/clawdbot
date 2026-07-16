// Public retry helpers for plugins that need retry config or policy runners.

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
