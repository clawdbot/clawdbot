import type { MoltbotConfig } from "../../config/config.js";
import {
  resolveChannelGroupRequireMention,
  resolveChannelGroupToolsPolicy,
  resolveToolsBySender,
} from "../../config/group-policy.js";
import type { DiscordConfig } from "../../config/types.js";
import type {
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
} from "../../config/types.tools.js";
import { resolveSlackAccount } from "../../slack/accounts.js";

type GroupMentionParams = {
  cfg: MoltbotConfig;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  accountId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
};

// --- Helpers for simple channel delegates ---

function simpleRequireMention(channel: string) {
  return (params: GroupMentionParams): boolean =>
    resolveChannelGroupRequireMention({
      cfg: params.cfg,
      channel,
      groupId: params.groupId,
      accountId: params.accountId,
    });
}

function simpleToolPolicy(channel: string) {
  return (params: GroupMentionParams): GroupToolPolicyConfig | undefined =>
    resolveChannelGroupToolsPolicy({
      cfg: params.cfg,
      channel,
      groupId: params.groupId,
      accountId: params.accountId,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
    });
}

// --- Normalization ---

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

// --- Telegram ---

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
  cfg: MoltbotConfig;
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

export function resolveTelegramGroupToolPolicy(
  params: GroupMentionParams,
): GroupToolPolicyConfig | undefined {
  const { chatId } = parseTelegramGroupId(params.groupId);
  return resolveChannelGroupToolsPolicy({
    cfg: params.cfg,
    channel: "telegram",
    groupId: chatId ?? params.groupId,
    accountId: params.accountId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
}

// --- Simple channel delegates (WhatsApp, iMessage, BlueBubbles, GoogleChat) ---

export const resolveWhatsAppGroupRequireMention = simpleRequireMention("whatsapp");
export const resolveIMessageGroupRequireMention = simpleRequireMention("imessage");
export const resolveBlueBubblesGroupRequireMention = simpleRequireMention("bluebubbles");
export const resolveGoogleChatGroupRequireMention = simpleRequireMention("googlechat");

export const resolveWhatsAppGroupToolPolicy = simpleToolPolicy("whatsapp");
export const resolveIMessageGroupToolPolicy = simpleToolPolicy("imessage");
export const resolveBlueBubblesGroupToolPolicy = simpleToolPolicy("bluebubbles");
export const resolveGoogleChatGroupToolPolicy = simpleToolPolicy("googlechat");

// --- Discord ---

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

function resolveDiscordChannelEntry(
  channelEntries:
    | Record<
        string,
        {
          requireMention?: boolean;
          tools?: GroupToolPolicyConfig;
          toolsBySender?: GroupToolPolicyBySenderConfig;
        }
      >
    | undefined,
  params: GroupMentionParams,
) {
  if (!channelEntries || Object.keys(channelEntries).length === 0) return undefined;
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

export function resolveDiscordGroupRequireMention(params: GroupMentionParams): boolean {
  const guildEntry = resolveDiscordGuildEntry(
    params.cfg.channels?.discord?.guilds,
    params.groupSpace,
  );
  const entry = resolveDiscordChannelEntry(guildEntry?.channels, params);
  if (entry && typeof entry.requireMention === "boolean") {
    return entry.requireMention;
  }
  if (typeof guildEntry?.requireMention === "boolean") {
    return guildEntry.requireMention;
  }
  return true;
}

export function resolveDiscordGroupToolPolicy(
  params: GroupMentionParams,
): GroupToolPolicyConfig | undefined {
  const guildEntry = resolveDiscordGuildEntry(
    params.cfg.channels?.discord?.guilds,
    params.groupSpace,
  );
  const entry = resolveDiscordChannelEntry(guildEntry?.channels, params);
  if (entry) {
    const senderPolicy = resolveToolsBySender({
      toolsBySender: entry.toolsBySender,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
    });
    if (senderPolicy) return senderPolicy;
    if (entry.tools) return entry.tools;
  }
  const guildSenderPolicy = resolveToolsBySender({
    toolsBySender: guildEntry?.toolsBySender,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  if (guildSenderPolicy) return guildSenderPolicy;
  if (guildEntry?.tools) return guildEntry.tools;
  return undefined;
}

// --- Slack ---

function resolveSlackChannelEntry(params: GroupMentionParams) {
  const account = resolveSlackAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const channels = account.channels ?? {};
  if (Object.keys(channels).length === 0) return { matched: undefined, channels };
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
  let matched: Record<string, unknown> | undefined;
  for (const candidate of candidates) {
    if (candidate && channels[candidate]) {
      matched = channels[candidate] as Record<string, unknown>;
      break;
    }
  }
  const resolved = matched ?? channels["*"];
  return { matched: resolved, channels };
}

export function resolveSlackGroupRequireMention(params: GroupMentionParams): boolean {
  const { matched, channels } = resolveSlackChannelEntry(params);
  if (Object.keys(channels).length === 0) return true;
  const resolved = matched as { requireMention?: boolean } | undefined;
  if (typeof resolved?.requireMention === "boolean") {
    return resolved.requireMention;
  }
  return true;
}

export function resolveSlackGroupToolPolicy(
  params: GroupMentionParams,
): GroupToolPolicyConfig | undefined {
  const { matched, channels } = resolveSlackChannelEntry(params);
  if (Object.keys(channels).length === 0) return undefined;
  const resolved = matched as
    | { tools?: GroupToolPolicyConfig; toolsBySender?: GroupToolPolicyBySenderConfig }
    | undefined;
  const senderPolicy = resolveToolsBySender({
    toolsBySender: resolved?.toolsBySender,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  if (senderPolicy) return senderPolicy;
  if (resolved?.tools) return resolved.tools;
  return undefined;
}
