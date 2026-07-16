// Discord plugin module implements group policy behavior.
import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import {
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
  scopeKey,
  type GroupToolPolicyConfig,
  type ScopeTree,
} from "openclaw/plugin-sdk/channel-policy";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeAtHashSlug } from "openclaw/plugin-sdk/string-normalization-runtime";
import type { DiscordConfig } from "./runtime-api.js";

function normalizeDiscordSlug(value?: string | null) {
  return normalizeAtHashSlug(value);
}

// Length-prefixed segments keep arbitrary config keys, including slashes, collision-free.
const guildScopeKey = (guildKey: string) => scopeKey(["guild", guildKey]);
const channelScopeKey = (guildKey: string, channelKey: string) =>
  scopeKey(["guild", guildKey], ["channel", channelKey]);

function resolveDiscordGuildKey(
  guilds: DiscordConfig["guilds"],
  groupSpace?: string | null,
): string | undefined {
  if (!guilds || Object.keys(guilds).length === 0) {
    return undefined;
  }
  const space = normalizeOptionalString(groupSpace) ?? "";
  if (space && guilds[space]) {
    return space;
  }
  const normalized = normalizeDiscordSlug(space);
  if (normalized && guilds[normalized]) {
    return normalized;
  }
  if (normalized) {
    const match = Object.entries(guilds).find(
      ([, entry]) => normalizeDiscordSlug(entry?.slug ?? undefined) === normalized,
    );
    if (match) {
      return match[0];
    }
  }
  return guilds["*"] ? "*" : undefined;
}

function resolveDiscordChannelKey(
  channelEntries: NonNullable<DiscordConfig["guilds"]>[string]["channels"],
  params: { groupId?: string | null; groupChannel?: string | null },
): string | undefined {
  if (!channelEntries || Object.keys(channelEntries).length === 0) {
    return undefined;
  }
  const groupChannel = params.groupChannel;
  const channelSlug = normalizeDiscordSlug(groupChannel);
  if (params.groupId && channelEntries[params.groupId]) {
    return params.groupId;
  }
  if (channelSlug && channelEntries[channelSlug]) {
    return channelSlug;
  }
  if (channelSlug && channelEntries[`#${channelSlug}`]) {
    return `#${channelSlug}`;
  }
  const normalizedGroupChannel = groupChannel ? normalizeDiscordSlug(groupChannel) : undefined;
  return normalizedGroupChannel !== undefined && channelEntries[normalizedGroupChannel]
    ? normalizedGroupChannel
    : undefined;
}

function buildDiscordPolicyTree(guilds: DiscordConfig["guilds"]): ScopeTree {
  const scopes: ScopeTree["scopes"] = {};
  for (const [guildKey, guild] of Object.entries(guilds ?? {})) {
    scopes[guildScopeKey(guildKey)] = {
      requireMention: guild.requireMention,
      tools: guild.tools,
      toolsBySender: guild.toolsBySender,
    };
    for (const [channelKey, channel] of Object.entries(guild.channels ?? {})) {
      scopes[channelScopeKey(guildKey, channelKey)] = {
        requireMention: channel.requireMention,
        tools: channel.tools,
        toolsBySender: channel.toolsBySender,
      };
    }
  }
  return { scopes };
}

function resolveDiscordPolicyScope(params: ChannelGroupContext) {
  const guilds =
    (params.accountId
      ? params.cfg.channels?.discord?.accounts?.[params.accountId]?.guilds
      : undefined) ?? params.cfg.channels?.discord?.guilds;
  const tree = buildDiscordPolicyTree(guilds);
  // Guild "*" is selected only after every guild candidate misses; matched guilds hide it.
  // Within the selected guild, channel fields still cascade to guild fields.
  const guildKey = resolveDiscordGuildKey(guilds, params.groupSpace);
  if (!guildKey) {
    return { tree, path: [] };
  }
  const channelKey = resolveDiscordChannelKey(guilds?.[guildKey]?.channels, params);
  return {
    tree,
    path: [
      guildScopeKey(guildKey),
      ...(channelKey !== undefined ? [channelScopeKey(guildKey, channelKey)] : []),
    ],
  };
}

export function resolveDiscordGroupRequireMention(params: ChannelGroupContext): boolean {
  return resolveScopeRequireMention(resolveDiscordPolicyScope(params));
}

export function resolveDiscordGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const scope = resolveDiscordPolicyScope(params);
  // No messageProvider: channel-prefixed sender keys were historically dead here.
  return resolveScopeToolsPolicy({
    ...scope,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
}
