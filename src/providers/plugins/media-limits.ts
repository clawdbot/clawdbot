import type { ClawdbotConfig } from "../../config/config.js";
import { normalizeAccountId } from "../../routing/session-key.js";

const MB = 1024 * 1024;

export function resolveProviderMediaMaxBytes(params: {
  cfg: ClawdbotConfig;
  provider: "signal" | "imessage";
  accountId?: string | null;
}): number | undefined {
  const accountId = normalizeAccountId(params.accountId);
  const providerLimit =
    params.provider === "signal"
      ? (params.cfg.signal?.accounts?.[accountId]?.mediaMaxMb ??
        params.cfg.signal?.mediaMaxMb)
      : (params.cfg.imessage?.accounts?.[accountId]?.mediaMaxMb ??
        params.cfg.imessage?.mediaMaxMb);
  if (providerLimit) return providerLimit * MB;
  if (params.cfg.agents?.defaults?.mediaMaxMb) {
    return params.cfg.agents.defaults.mediaMaxMb * MB;
  }
  return undefined;
}
