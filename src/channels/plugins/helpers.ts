import type { ClawdbotConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import type { ChannelPlugin } from "./types.js";

// Channel docking helper: use this when selecting the default account for a plugin.
export function resolveChannelDefaultAccountId<ResolvedAccount>(params: {
  plugin: ChannelPlugin<ResolvedAccount>;
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

export function formatPairingApproveHint(channelId: string): string {
  return `Approve via: clawdbot pairing list ${channelId} / clawdbot pairing approve ${channelId} <code>`;
}
