// Discord plugin module implements delivery retry behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveRetryConfig,
  retryAsync,
  type RetryConfig,
} from "openclaw/plugin-sdk/retry-runtime";
import { resolveDiscordAccount } from "./accounts.js";
import { DiscordError } from "./internal/discord.js";
import { parseDiscordRetryAfterBodySeconds } from "./retry-after.js";

const DISCORD_DELIVERY_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 1000,
  maxDelayMs: 30_000,
  jitter: 0,
} satisfies Required<RetryConfig>;

export function isRetryableDiscordDeliveryError(err: unknown): boolean {
  if (err instanceof DiscordError) {
    return false;
  }
  const status = (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;
  return status === 429 || (status !== undefined && status >= 500);
}

export function getDiscordDeliveryRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const retryAfterSeconds =
    "retryAfter" in err ? parseDiscordRetryAfterBodySeconds(err.retryAfter) : undefined;
  if (retryAfterSeconds !== undefined) {
    return retryAfterSeconds * 1000;
  }
  const retryAfterRaw = (err as { headers?: Record<string, string> }).headers?.["retry-after"];
  if (!retryAfterRaw) {
    return undefined;
  }
  const headerSeconds = parseDiscordRetryAfterBodySeconds(retryAfterRaw);
  return headerSeconds === undefined ? undefined : headerSeconds * 1000;
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
