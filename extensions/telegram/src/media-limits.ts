import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/account-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

const DEFAULT_TELEGRAM_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

export function resolveTelegramMediaMaxBytes(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  maxBytes?: number;
  mediaMaxMb?: number;
  fallbackMediaMaxMb?: number;
}): number {
  const mediaMaxMb =
    typeof params.mediaMaxMb === "number" &&
    Number.isFinite(params.mediaMaxMb) &&
    params.mediaMaxMb >= 0
      ? params.mediaMaxMb
      : params.fallbackMediaMaxMb;
  return (
    resolveChannelMediaMaxBytes({
      cfg: params.cfg,
      accountId: params.accountId,
      overrideMaxBytes: params.maxBytes,
      resolveChannelLimitMb: () => mediaMaxMb,
    }) ?? DEFAULT_TELEGRAM_MEDIA_MAX_BYTES
  );
}
