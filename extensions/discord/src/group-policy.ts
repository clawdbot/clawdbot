import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import {
  resolveToolsBySender,
  type GroupToolPolicyBySenderConfig,
  type GroupToolPolicyConfig,
} from "openclaw/plugin-sdk/channel-policy";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeAtHashSlug } from "openclaw/plugin-sdk/string-normalization-runtime";
import type { DiscordConfig } from "./runtime-api.js";

function normalizeDiscordSlug(value?: string | null) {
  return normalizeAtHashSlug(value);
}

type SenderScopedToolsEntry = {
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  requireMention?: boolean;
};

function resolveDiscordGuildEntry(guilds: DiscordConfig["guilds"], groupSpace?: string | null) {
  if (!guilds || Object.keys(guilds).length === 0) {
    return null;
  }
  const space = normalizeOptionalString(groupSpace) ?? "";
  if (space && guilds[space]) {
    return guilds[space];
  }
  const normalized = normalizeDiscordSlug(space);
  if (normalized && guilds[normalized]) {
    return guilds[normalized];
  }
  if (normalized) {
    const match = Object.values(guilds).find(
      (entry) => normalizeDiscordSlug(entry?.slug ?? undefined) === normalized,
    );
    if (match) {
      return match;
    }
  }
  return guilds["*"] ?? null;
}

function resolveDiscordChannelEntry<TEntry extends SenderScopedToolsEntry>(
  channelEntries: Record<string, TEntry> | undefined,
  params: { groupId?: string | null; groupChannel?: string | null },
): TEntry | undefined {
  if (!channelEntries || Object.keys(channelEntries).length === 0) {
    return undefined;
  }
  const groupChannel = params.groupChannel;
  const channelSlug = normalizeDiscordSlug(groupChannel);
  return (
    (params.groupId ? channelEntries[params.groupId] : undefined) ??
    (channelSlug
      ? (channelEntries[channelSlug] ?? channelEntries[`#${channelSlug}`])
      : undefined) ??
    (groupChannel ? channelEntries[normalizeDiscordSlug(groupChannel)] : undefined)
  );
}

function resolveSenderToolsEntry(
  entry: SenderScopedToolsEntry | undefined | null,
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  if (!entry) {
    return undefined;
  }
  const senderPolicy = resolveToolsBySender({
    toolsBySender: entry.toolsBySender,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  return senderPolicy ?? entry.tools;
}

function resolveDiscordPolicyContext(params: ChannelGroupContext) {
  const guilds =
    (params.accountId
      ? params.cfg.channels?.discord?.accounts?.[params.accountId]?.guilds
      : undefined) ?? params.cfg.channels?.discord?.guilds;
  const guildEntry = resolveDiscordGuildEntry(guilds, params.groupSpace);
  const channelEntries = guildEntry?.channels;
  const channelEntry =
    channelEntries && Object.keys(channelEntries).length > 0
      ? resolveDiscordChannelEntry(channelEntries, params)
      : undefined;
  return { guildEntry, channelEntry };
}

export function resolveDiscordGroupRequireMention(params: ChannelGroupContext): boolean {
  const context = resolveDiscordPolicyContext(params);
  if (typeof context.channelEntry?.requireMention === "boolean") {
    return context.channelEntry.requireMention;
  }
  if (typeof context.guildEntry?.requireMention === "boolean") {
    return context.guildEntry.requireMention;
  }
  return true;
}

export function resolveDiscordGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const context = resolveDiscordPolicyContext(params);
  const channelPolicy = resolveSenderToolsEntry(context.channelEntry, params);
  if (channelPolicy) {
    return channelPolicy;
  }
  return resolveSenderToolsEntry(context.guildEntry, params);
}
