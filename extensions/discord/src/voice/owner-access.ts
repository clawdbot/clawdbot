// Discord plugin module implements voice owner resolution.
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveDiscordAccountAllowFrom } from "../accounts.js";
import { resolveDiscordCommandOwnerAllowFrom } from "../monitor/allow-list.js";

export function resolveDiscordVoiceAccess(params: {
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  accountId: string;
}): {
  admissionAllowFrom: string[];
  ownerAllowFrom: string[];
} {
  const commandOwnerAllowFrom = resolveDiscordCommandOwnerAllowFrom(params.cfg);
  if (commandOwnerAllowFrom) {
    return {
      admissionAllowFrom: commandOwnerAllowFrom,
      ownerAllowFrom: commandOwnerAllowFrom,
    };
  }
  const admissionAllowFrom =
    resolveDiscordAccountAllowFrom({ cfg: params.cfg, accountId: params.accountId }) ??
    params.discordConfig.allowFrom ??
    [];
  return {
    admissionAllowFrom,
    ownerAllowFrom: [],
  };
}
