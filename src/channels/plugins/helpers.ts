import { formatCliCommand } from "../../cli/command-format.js";
import type { MoltbotConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import type { ChannelPlugin } from "./types.js";

// Channel docking helper: use this when selecting the default account for a plugin.
export function resolveChannelDefaultAccountId<ResolvedAccount>(params: {
  plugin: ChannelPlugin<ResolvedAccount>;
  cfg: MoltbotConfig;
  accountIds?: string[];
}): string {
  const accountIds = params.accountIds ?? params.plugin.config.listAccountIds(params.cfg);
  return params.plugin.config.defaultAccountId?.(params.cfg) ?? accountIds[0] ?? DEFAULT_ACCOUNT_ID;
}

export function formatPairingApproveHint(channelId: string): string {
  const listCmd = formatCliCommand(`moltbot pairing list ${channelId}`);
  const approveCmd = formatCliCommand(`moltbot pairing approve ${channelId} <code>`);
  return `Approve via: ${listCmd} / ${approveCmd}`;
}
