// Discord plugin module implements voice owner resolution.
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveDiscordAccountAllowFrom } from "../accounts.js";
import { resolveDiscordCommandOwnerAllowFrom } from "../monitor/allow-list.js";

export function resolveDiscordVoiceOwnerAccess(params: {
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  accountId: string;
}): { ownerAllowFrom: string[]; ownerAllowAll: boolean } {
  const commandOwnerAllowFrom = resolveDiscordCommandOwnerAllowFrom(params.cfg);
  if (commandOwnerAllowFrom) {
    return {
      ownerAllowFrom: commandOwnerAllowFrom,
      ownerAllowAll: commandOwnerAllowFrom.includes("*"),
    };
  }
  return {
    ownerAllowFrom:
      resolveDiscordAccountAllowFrom({ cfg: params.cfg, accountId: params.accountId }) ??
      params.discordConfig.allowFrom ??
      params.discordConfig.dm?.allowFrom ??
      [],
    // Legacy Discord wildcards grant transport access, not owner authority.
    ownerAllowAll: false,
  };
}
