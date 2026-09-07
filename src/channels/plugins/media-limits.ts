/**
 * Channel media limit resolver.
 *
 * Combines account-scoped channel media limits with agent default limits.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAccountId } from "../../routing/session-key.js";

const MB = 1024 * 1024;

/** Resolves channel media limit bytes from account-specific config or agent defaults. */
export function resolveChannelMediaMaxBytes(params: {
  cfg: OpenClawConfig;
  // Channel-specific config lives under different keys; keep this helper generic
  // so shared plugin helpers don't need channel-id branching.
  resolveChannelLimitMb: (params: { cfg: OpenClawConfig; accountId: string }) => number | undefined;
  accountId?: string | null;
  overrideMaxBytes?: number;
}): number | undefined {
  const overrideMaxBytes = params.overrideMaxBytes;
  if (
    typeof overrideMaxBytes === "number" &&
    Number.isFinite(overrideMaxBytes) &&
    overrideMaxBytes >= 0
  ) {
    return Math.floor(overrideMaxBytes);
  }
  const accountId = normalizeAccountId(params.accountId);
  const channelLimit = params.resolveChannelLimitMb({
    cfg: params.cfg,
    accountId,
  });
  const limitBytes = [channelLimit, params.cfg.agents?.defaults?.mediaMaxMb]
    .map((limitMb) => (limitMb ?? 0) * MB)
    .find((value) => Number.isFinite(value) && value > 0);
  return limitBytes === undefined ? undefined : Math.floor(limitBytes);
}
