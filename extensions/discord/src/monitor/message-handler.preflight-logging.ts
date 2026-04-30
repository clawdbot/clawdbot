import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { logDebug } from "openclaw/plugin-sdk/text-runtime";
import type { DiscordChannelConfigResolved } from "./allow-list.js";

export function logDiscordPreflightChannelConfig(params: {
  channelConfig: DiscordChannelConfigResolved | null;
  channelMatchMeta: string;
  channelId: string;
}) {
  if (!shouldLogVerbose()) {
    return;
  }
  const channelConfigSummary = params.channelConfig
    ? `allowed=${params.channelConfig.allowed} enabled=${params.channelConfig.enabled ?? "unset"} requireMention=${params.channelConfig.requireMention ?? "unset"} ignoreOtherMentions=${params.channelConfig.ignoreOtherMentions ?? "unset"} matchKey=${params.channelConfig.matchKey ?? "none"} matchSource=${params.channelConfig.matchSource ?? "none"} users=${params.channelConfig.users?.length ?? 0} roles=${params.channelConfig.roles?.length ?? 0} skills=${params.channelConfig.skills?.length ?? 0}`
    : "none";
  logDebug(
    `[discord-preflight] channelConfig=${channelConfigSummary} channelMatchMeta=${params.channelMatchMeta} channelId=${params.channelId}`,
  );
}

export function logDiscordPreflightInboundSummary(params: {
  messageId: string;
  guildId?: string;
  channelId: string;
  wasMentioned: boolean;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  hasContent: boolean;
}) {
  if (!shouldLogVerbose()) {
    return;
  }
  logVerbose(
    `discord: inbound id=${params.messageId} guild=${params.guildId ?? "dm"} channel=${params.channelId} mention=${params.wasMentioned ? "yes" : "no"} type=${params.isDirectMessage ? "dm" : params.isGroupDm ? "group-dm" : "guild"} content=${params.hasContent ? "yes" : "no"}`,
  );
}
