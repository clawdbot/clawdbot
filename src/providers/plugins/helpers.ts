import type { ClawdbotConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import type { ProviderPlugin } from "./types.js";

// Provider docking helper: use this when selecting the default account for a plugin.
export function resolveProviderDefaultAccountId<ResolvedAccount>(params: {
  plugin: ProviderPlugin<ResolvedAccount>;
  cfg: ClawdbotConfig;
  accountIds?: string[];
}): string {
  const accountIds =
    params.accountIds ?? params.plugin.config.listAccountIds(params.cfg);
  return (
    params.plugin.config.defaultAccountId?.(params.cfg) ??
    accountIds[0] ??
    DEFAULT_ACCOUNT_ID
  );
}

export function formatPairingApproveHint(providerId: string): string {
  return `Approve via: clawdbot pairing list ${providerId} / clawdbot pairing approve ${providerId} <code>`;
}
