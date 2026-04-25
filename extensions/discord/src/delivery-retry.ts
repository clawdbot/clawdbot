import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveRetryConfig,
  retryAsync,
  type RetryConfig,
} from "openclaw/plugin-sdk/retry-runtime";
import { resolveDiscordAccount } from "./accounts.js";

const DISCORD_DELIVERY_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 1000,
  maxDelayMs: 30_000,
  jitter: 0,
} satisfies Required<RetryConfig>;

function isRetryableDiscordDeliveryError(err: unknown): boolean {
  const status = (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;
  return status === 429 || (status !== undefined && status >= 500);
}

function getDiscordDeliveryRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  if (
    "retryAfter" in err &&
    typeof err.retryAfter === "number" &&
    Number.isFinite(err.retryAfter)
  ) {
    return err.retryAfter * 1000;
  }
  const retryAfterRaw = (err as { headers?: Record<string, string> }).headers?.["retry-after"];
  if (!retryAfterRaw) {
    return undefined;
  }
  const retryAfterMs = Number(retryAfterRaw) * 1000;
  return Number.isFinite(retryAfterMs) ? retryAfterMs : undefined;
}

export async function withDiscordDeliveryRetry<T>(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  fn: () => Promise<T>;
}): Promise<T> {
  const account = resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
  const retryConfig = resolveRetryConfig(DISCORD_DELIVERY_RETRY_DEFAULTS, account.config.retry);
  return await retryAsync(params.fn, {
    ...retryConfig,
    shouldRetry: (err) => isRetryableDiscordDeliveryError(err),
    retryAfterMs: getDiscordDeliveryRetryAfterMs,
  });
}
