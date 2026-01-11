import type { ClawdbotConfig } from "../../config/config.js";
import { normalizeAccountId } from "../../routing/session-key.js";

const MB = 1024 * 1024;

export function resolveProviderMediaMaxBytes(params: {
  cfg: ClawdbotConfig;
  // Provider-specific config lives under different keys; keep this helper generic
  // so shared plugin helpers don't need provider-id branching.
  resolveProviderLimitMb: (params: {
    cfg: ClawdbotConfig;
    accountId: string;
  }) => number | undefined;
  accountId?: string | null;
}): number | undefined {
  const accountId = normalizeAccountId(params.accountId);
  const providerLimit = params.resolveProviderLimitMb({
    cfg: params.cfg,
    accountId,
  });
  if (providerLimit) return providerLimit * MB;
  if (params.cfg.agents?.defaults?.mediaMaxMb) {
    return params.cfg.agents.defaults.mediaMaxMb * MB;
  }
  return undefined;
}
