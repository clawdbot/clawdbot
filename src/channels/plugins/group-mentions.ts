import type { ClawdbotConfig } from "../../config/config.js";
import { resolveChannelGroupRequireMention } from "../../config/group-policy.js";
import type { DiscordConfig } from "../../config/types.js";
import { resolveSlackAccount } from "../../slack/accounts.js";

type GroupMentionParams = {
  cfg: ClawdbotConfig;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  accountId?: string | null;
};

function normalizeDiscordSlug(value?: string | null) {
  if (!value) return "";
  let text = value.trim().toLowerCase();
  if (!text) return "";
  text = text.replace(/^[@#]+/, "");
  text = text.replace(/[\s_]+/g, "-");
  text = text.replace(/[^a-z0-9-]+/g, "-");
  text = text.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return text;
}

function normalizeSlackSlug(raw?: string | null) {
  const trimmed = raw?.trim().toLowerCase() ?? "";
  if (!trimmed) return "";
  const dashed = trimmed.replace(/\s+/g, "-");
  const cleaned = dashed.replace(/[^a-z0-9#@._+-]+/g, "-");
  return cleaned.replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

function parseTelegramGroupId(value?: string | null) {
  const raw = value?.trim() ?? "";
  if (!raw) return { chatId: undefined, topicId: undefined };
  const parts = raw.split(":").filter(Boolean);
  if (
    parts.length >= 3 &&
    parts[1] === "topic" &&
    /^-?\d+$/.test(parts[0]) &&
    /^\d+$/.test(parts[2])
  ) {
    return { chatId: parts[0], topicId: parts[2] };
  }
  if (parts.length >= 2 && /^-?\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
    return { chatId: parts[0], topicId: parts[1] };
  }
  return { chatId: raw, topicId: undefined };
}

function resolveTelegramRequireMention(params: {
  cfg: ClawdbotConfig;
  chatId?: string;
  topicId?: string;
}): boolean | undefined {
  const { cfg, chatId, topicId } = params;
  if (!chatId) return undefined;
  const groupConfig = cfg.channels?.telegram?.groups?.[chatId];
  const groupDefault = cfg.channels?.telegram?.groups?.["*"];
  const topicConfig = topicId && groupConfig?.topics ? groupConfig.topics[topicId] : undefined;
  const defaultTopicConfig =
    topicId && groupDefault?.topics ? groupDefault.topics[topicId] : undefined;
  if (typeof topicConfig?.requireMention === "boolean") {
    return topicConfig.requireMention;
  }
  if (typeof defaultTopicConfig?.requireMention === "boolean") {
    return defaultTopicConfig.requireMention;
  }
  if (typeof groupConfig?.requireMention === "boolean") {
    return groupConfig.requireMention;
  }
  if (typeof groupDefault?.requireMention === "boolean") {
    return groupDefault.requireMention;
  }
  return undefined;
}

function resolveDiscordGuildEntry(guilds: DiscordConfig["guilds"], groupSpace?: string | null) {
  if (!guilds || Object.keys(guilds).length === 0) return null;
  const space = groupSpace?.trim() ?? "";
  if (space && guilds[space]) return guilds[space];
  const normalized = normalizeDiscordSlug(space);
  if (normalized && guilds[normalized]) return guilds[normalized];
  if (normalized) {
    const match = Object.values(guilds).find(
      (entry) => normalizeDiscordSlug(entry?.slug ?? undefined) === normalized,
    );
    if (match) return match;
  }
  return guilds["*"] ?? null;
}

export function resolveTelegramGroupRequireMention(
  params: GroupMentionParams,
): boolean | undefined {
  const { chatId, topicId } = parseTelegramGroupId(params.groupId);
  const requireMention = resolveTelegramRequireMention({
    cfg: params.cfg,
    chatId,
    topicId,
  });
  if (typeof requireMention === "boolean") return requireMention;
  return resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: "telegram",
    groupId: chatId ?? params.groupId,
    accountId: params.accountId,
  });
}

export function resolveWhatsAppGroupRequireMention(params: GroupMentionParams): boolean {
  return resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: "whatsapp",
    groupId: params.groupId,
    accountId: params.accountId,
  });
}

export function resolveIMessageGroupRequireMention(params: GroupMentionParams): boolean {
  return resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: "imessage",
    groupId: params.groupId,
    accountId: params.accountId,
  });
}

export function resolveDiscordGroupRequireMention(params: GroupMentionParams): boolean {
  const guildEntry = resolveDiscordGuildEntry(
    params.cfg.channels?.discord?.guilds,
    params.groupSpace,
  );
  const channelEntries = guildEntry?.channels;
  if (channelEntries && Object.keys(channelEntries).length > 0) {
    const groupChannel = params.groupChannel;
    const channelSlug = normalizeDiscordSlug(groupChannel);
    const entry =
      (params.groupId ? channelEntries[params.groupId] : undefined) ??
      (channelSlug
        ? (channelEntries[channelSlug] ?? channelEntries[`#${channelSlug}`])
        : undefined) ??
      (groupChannel ? channelEntries[normalizeDiscordSlug(groupChannel)] : undefined);
    if (entry && typeof entry.requireMention === "boolean") {
      return entry.requireMention;
    }
  }
  if (typeof guildEntry?.requireMention === "boolean") {
    return guildEntry.requireMention;
  }
  return true;
}

export function resolveSlackGroupRequireMention(params: GroupMentionParams): boolean {
  const account = resolveSlackAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const channels = account.channels ?? {};
  const keys = Object.keys(channels);
  if (keys.length === 0) return true;
  const channelId = params.groupId?.trim();
  const groupChannel = params.groupChannel;
  const channelName = groupChannel?.replace(/^#/, "");
  const normalizedName = normalizeSlackSlug(channelName);
  const candidates = [
    channelId ?? "",
    channelName ? `#${channelName}` : "",
    channelName ?? "",
    normalizedName,
  ].filter(Boolean);
  let matched: { requireMention?: boolean } | undefined;
  for (const candidate of candidates) {
    if (candidate && channels[candidate]) {
      matched = channels[candidate];
      break;
    }
  }
  const fallback = channels["*"];
  const resolved = matched ?? fallback;
  if (typeof resolved?.requireMention === "boolean") {
    return resolved.requireMention;
  }
  return true;
}

export function resolveBlueBubblesGroupRequireMention(params: GroupMentionParams): boolean {
  return resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: "bluebubbles",
    groupId: params.groupId,
    accountId: params.accountId,
  });
}
