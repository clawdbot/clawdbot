import type { Guild, User } from "@buape/carbon";

import { formatDiscordUserTag } from "./format.js";

export type DiscordAllowList = {
  allowAll: boolean;
  ids: Set<string>;
  names: Set<string>;
};

export type DiscordGuildEntryResolved = {
  id?: string;
  slug?: string;
  requireMention?: boolean;
  reactionNotifications?: "off" | "own" | "all" | "allowlist";
  users?: Array<string | number>;
  channels?: Record<
    string,
    {
      allow?: boolean;
      requireMention?: boolean;
      skills?: string[];
      enabled?: boolean;
      users?: Array<string | number>;
      systemPrompt?: string;
      autoThread?: boolean;
    }
  >;
};

export type DiscordChannelConfigResolved = {
  allowed: boolean;
  requireMention?: boolean;
  skills?: string[];
  enabled?: boolean;
  users?: Array<string | number>;
  systemPrompt?: string;
  autoThread?: boolean;
};

export function normalizeDiscordAllowList(
  raw: Array<string | number> | undefined,
  prefixes: string[],
) {
  if (!raw || raw.length === 0) return null;
  const ids = new Set<string>();
  const names = new Set<string>();
  const allowAll = raw.some((entry) => String(entry).trim() === "*");
  for (const entry of raw) {
    const text = String(entry).trim();
    if (!text || text === "*") continue;
    const normalized = normalizeDiscordSlug(text);
    const maybeId = text.replace(/^<@!?/, "").replace(/>$/, "");
    if (/^\d+$/.test(maybeId)) {
      ids.add(maybeId);
      continue;
    }
    const prefix = prefixes.find((entry) => text.startsWith(entry));
    if (prefix) {
      const candidate = text.slice(prefix.length);
      if (candidate) ids.add(candidate);
      continue;
    }
    if (normalized) {
      names.add(normalized);
    }
  }
  return { allowAll, ids, names } satisfies DiscordAllowList;
}

export function normalizeDiscordSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function allowListMatches(
  list: DiscordAllowList,
  candidate: { id?: string; name?: string; tag?: string },
) {
  if (list.allowAll) return true;
  if (candidate.id && list.ids.has(candidate.id)) return true;
  const slug = candidate.name ? normalizeDiscordSlug(candidate.name) : "";
  if (slug && list.names.has(slug)) return true;
  if (candidate.tag && list.names.has(normalizeDiscordSlug(candidate.tag)))
    return true;
  return false;
}

export function resolveDiscordUserAllowed(params: {
  allowList?: Array<string | number>;
  userId: string;
  userName?: string;
  userTag?: string;
}) {
  const allowList = normalizeDiscordAllowList(params.allowList, [
    "discord:",
    "user:",
  ]);
  if (!allowList) return true;
  return allowListMatches(allowList, {
    id: params.userId,
    name: params.userName,
    tag: params.userTag,
  });
}

export function resolveDiscordCommandAuthorized(params: {
  isDirectMessage: boolean;
  allowFrom?: Array<string | number>;
  guildInfo?: DiscordGuildEntryResolved | null;
  author: User;
}) {
  if (!params.isDirectMessage) return true;
  const allowList = normalizeDiscordAllowList(params.allowFrom, [
    "discord:",
    "user:",
  ]);
  if (!allowList) return true;
  return allowListMatches(allowList, {
    id: params.author.id,
    name: params.author.username,
    tag: formatDiscordUserTag(params.author),
  });
}

export function resolveDiscordGuildEntry(params: {
  guild?: Guild<true> | Guild<false> | null;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
}): DiscordGuildEntryResolved | null {
  const guild = params.guild;
  const entries = params.guildEntries;
  if (!guild || !entries) return null;
  const byId = entries[guild.id];
  if (byId) return { ...byId, id: guild.id };
  const slug = normalizeDiscordSlug(guild.name ?? "");
  const bySlug = entries[slug];
  if (bySlug) return { ...bySlug, id: guild.id, slug: slug || bySlug.slug };
  const wildcard = entries["*"];
  if (wildcard)
    return { ...wildcard, id: guild.id, slug: slug || wildcard.slug };
  return null;
}

export function resolveDiscordChannelConfig(params: {
  guildInfo?: DiscordGuildEntryResolved | null;
  channelId: string;
  channelName?: string;
  channelSlug: string;
}): DiscordChannelConfigResolved | null {
  const { guildInfo, channelId, channelName, channelSlug } = params;
  const channels = guildInfo?.channels;
  if (!channels) return null;
  const byId = channels[channelId];
  if (byId)
    return {
      allowed: byId.allow !== false,
      requireMention: byId.requireMention,
      skills: byId.skills,
      enabled: byId.enabled,
      users: byId.users,
      systemPrompt: byId.systemPrompt,
      autoThread: byId.autoThread,
    };
  if (channelSlug && channels[channelSlug]) {
    const entry = channels[channelSlug];
    return {
      allowed: entry.allow !== false,
      requireMention: entry.requireMention,
      skills: entry.skills,
      enabled: entry.enabled,
      users: entry.users,
      systemPrompt: entry.systemPrompt,
      autoThread: entry.autoThread,
    };
  }
  if (channelName && channels[channelName]) {
    const entry = channels[channelName];
    return {
      allowed: entry.allow !== false,
      requireMention: entry.requireMention,
      skills: entry.skills,
      enabled: entry.enabled,
      users: entry.users,
      systemPrompt: entry.systemPrompt,
      autoThread: entry.autoThread,
    };
  }
  return { allowed: false };
}

export function resolveDiscordShouldRequireMention(params: {
  isGuildMessage: boolean;
  isThread: boolean;
  channelConfig?: DiscordChannelConfigResolved | null;
  guildInfo?: DiscordGuildEntryResolved | null;
}): boolean {
  if (!params.isGuildMessage) return false;
  if (params.isThread && params.channelConfig?.autoThread) return false;
  return (
    params.channelConfig?.requireMention ??
    params.guildInfo?.requireMention ??
    true
  );
}

export function isDiscordGroupAllowedByPolicy(params: {
  groupPolicy: "open" | "disabled" | "allowlist";
  channelAllowlistConfigured: boolean;
  channelAllowed: boolean;
}): boolean {
  const { groupPolicy, channelAllowlistConfigured, channelAllowed } = params;
  if (groupPolicy === "disabled") return false;
  if (groupPolicy === "open") return true;
  if (!channelAllowlistConfigured) return false;
  return channelAllowed;
}

export function resolveGroupDmAllow(params: {
  channels?: Array<string | number>;
  channelId: string;
  channelName?: string;
  channelSlug: string;
}) {
  const { channels, channelId, channelName, channelSlug } = params;
  if (!channels || channels.length === 0) return true;
  const allowList = channels.map((entry) =>
    normalizeDiscordSlug(String(entry)),
  );
  const candidates = [
    normalizeDiscordSlug(channelId),
    channelSlug,
    channelName ? normalizeDiscordSlug(channelName) : "",
  ].filter(Boolean);
  return (
    allowList.includes("*") ||
    candidates.some((candidate) => allowList.includes(candidate))
  );
}

export function shouldEmitDiscordReactionNotification(params: {
  mode?: "off" | "own" | "all" | "allowlist";
  botId?: string;
  messageAuthorId?: string;
  userId: string;
  userName?: string;
  userTag?: string;
  allowlist?: Array<string | number>;
}) {
  const mode = params.mode ?? "own";
  if (mode === "off") return false;
  if (mode === "all") return true;
  if (mode === "own") {
    return Boolean(params.botId && params.messageAuthorId === params.botId);
  }
  if (mode === "allowlist") {
    const list = normalizeDiscordAllowList(params.allowlist, [
      "discord:",
      "user:",
    ]);
    if (!list) return false;
    return allowListMatches(list, {
      id: params.userId,
      name: params.userName,
      tag: params.userTag,
    });
  }
  return false;
}
