/**
 * Channel media limit resolver.
 *
 * Combines account-scoped channel media limits with agent default limits.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAccountId } from "../../routing/session-key.js";

const MB = 1024 * 1024;

function resolvePositiveLimitBytes(limitMb: number | undefined): number | undefined {
  return typeof limitMb === "number" && Number.isFinite(limitMb) && limitMb > 0
    ? Math.floor(limitMb * MB)
    : undefined;
}

/** Resolves channel media limit bytes from account-specific config or agent defaults. */
export function resolveChannelMediaMaxBytes(params: {
  cfg: OpenClawConfig;
  // Channel-specific config lives under different keys; keep this helper generic
  // so shared plugin helpers don't need channel-id branching.
  resolveChannelLimitMb: (params: { cfg: OpenClawConfig; accountId: string }) => number | undefined;
  accountId?: string | null;
}): number | undefined {
  const accountId = normalizeAccountId(params.accountId);
  const channelLimit = params.resolveChannelLimitMb({
    cfg: params.cfg,
    accountId,
  });
  const channelLimitBytes = resolvePositiveLimitBytes(channelLimit);
  if (channelLimitBytes !== undefined) {
    return channelLimitBytes;
  }
  return resolvePositiveLimitBytes(params.cfg.agents?.defaults?.mediaMaxMb);
}
