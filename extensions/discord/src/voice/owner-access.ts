import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveDiscordAccountAllowFrom } from "../accounts.js";
import { resolveDiscordCommandOwnerAllowFrom } from "../command-owners.js";
import type { Client } from "../internal/discord.js";
import { resolveFetchedDiscordThreadLikeChannelContext } from "../monitor/thread-channel-context.js";

export async function resolveDiscordVoiceAccessTarget(params: {
  client: Client;
  guildId: string;
  channelId: string;
}) {
  const [guild, channel] = await Promise.all([
    params.client.fetchGuild(params.guildId).catch(() => null),
    params.client.fetchChannel(params.channelId).catch(() => null),
  ]);
  if (!guild || !channel) {
    return undefined;
  }
  const context = await resolveFetchedDiscordThreadLikeChannelContext({
    client: params.client,
    channel,
    channelIdFallback: params.channelId,
  });
  return {
    guild,
    ...(context.channelName ? { channelName: context.channelName } : {}),
    channelSlug: context.channelSlug,
    ...(context.parentId ? { parentId: context.parentId } : {}),
    ...(context.threadParentName ? { parentName: context.threadParentName } : {}),
    ...(context.threadParentSlug ? { parentSlug: context.threadParentSlug } : {}),
    scope: context.isThreadChannel ? ("thread" as const) : ("channel" as const),
  };
}

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
