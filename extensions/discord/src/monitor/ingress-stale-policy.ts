import {
  ChannelType,
  MessageReferenceType,
  MessageType,
  type APIMessage,
} from "discord-api-types/v10";
import type { ChannelIngressQueueRecord } from "openclaw/plugin-sdk/channel-outbound";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import { shouldHandleTextCommands } from "openclaw/plugin-sdk/command-surface";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  isRecord,
  normalizeNullableString as nonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { isDiscordThreadChannelType } from "../channel-type.js";
import {
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  type DiscordGuildEntryResolved,
} from "./allow-list.js";
import { hasRawDiscordUserMention } from "./message-handler.raw-mention.js";

const DISCORD_STALE_AMBIENT_BACKLOG_MS = 15 * 60 * 1_000;
const DISCORD_AUDIO_ATTACHMENT_EXTENSIONS =
  /\.(?:aac|caf|flac|m4a|mp3|oga|ogg|opus|wav)(?:[?#]|$)/i;
const loadMentionRuntime = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/channel-inbound"),
);

type DiscordGatewayAttachment = APIMessage["attachments"][number] & {
  contentType?: unknown;
};

export type DiscordGatewayMessage = Omit<APIMessage, "attachments"> & {
  attachments: DiscordGatewayAttachment[];
  guild_id?: unknown;
};

export type DiscordIngressChannelKind = "non-thread" | "thread";

export type DiscordIngressPendingRow = {
  rawMessage: DiscordGatewayMessage;
  payloadReceivedAt: number | null;
  channelKind: DiscordIngressChannelKind | undefined;
};

export type DiscordIngressThreadBindingLookup = {
  getByThreadId?: (threadId: string) => unknown;
  listBySessionKey?: (targetSessionKey: string) => unknown[];
};

export function resolveDiscordIngressChannelKind(
  value: unknown,
): DiscordIngressChannelKind | undefined {
  if (isDiscordThreadChannelType(value)) {
    return "thread";
  }
  if (
    value === ChannelType.GuildText ||
    value === ChannelType.GuildAnnouncement ||
    value === ChannelType.GuildVoice ||
    value === ChannelType.GuildStageVoice ||
    value === ChannelType.DM ||
    value === ChannelType.GroupDM
  ) {
    return "non-thread";
  }
  return undefined;
}

function readDiscordMessageFacts(rawMessage: unknown): { eventId: string; laneKey: string } | null {
  if (!isRecord(rawMessage)) {
    return null;
  }
  const eventId = nonEmptyString(rawMessage.id);
  const channelId = nonEmptyString(rawMessage.channel_id);
  return eventId && channelId ? { eventId, laneKey: `channel:${channelId}` } : null;
}

function hasReadableDiscordPolicyFields(rawMessage: Record<string, unknown>): boolean {
  return (
    typeof rawMessage.content === "string" &&
    typeof rawMessage.timestamp === "string" &&
    typeof rawMessage.mention_everyone === "boolean" &&
    Array.isArray(rawMessage.attachments) &&
    rawMessage.attachments.every(isRecord) &&
    Array.isArray(rawMessage.mentions) &&
    rawMessage.mentions.every((mention) => isRecord(mention) && typeof mention.id === "string") &&
    (rawMessage.message_reference == null || isRecord(rawMessage.message_reference)) &&
    (rawMessage.referenced_message == null || isRecord(rawMessage.referenced_message))
  );
}

export function readDiscordIngressPendingRow(payload: unknown): DiscordIngressPendingRow | null {
  if (
    !isRecord(payload) ||
    !isRecord(payload.rawMessage) ||
    !readDiscordMessageFacts(payload.rawMessage) ||
    !hasReadableDiscordPolicyFields(payload.rawMessage)
  ) {
    return null;
  }
  // SAFETY: identity validation above proves the durable value is a Discord gateway frame.
  const rawMessage = payload.rawMessage as DiscordGatewayMessage;
  const payloadReceivedAt = payload.receivedAt;
  return {
    rawMessage,
    payloadReceivedAt:
      typeof payloadReceivedAt === "number" && Number.isFinite(payloadReceivedAt)
        ? payloadReceivedAt
        : null,
    channelKind:
      payload.channelKind === "non-thread" || payload.channelKind === "thread"
        ? payload.channelKind
        : undefined,
  };
}

function discordIngressRowSentAtMs(
  record: { receivedAt: number },
  row: DiscordIngressPendingRow,
): number {
  const payloadReceivedAt = row.payloadReceivedAt ?? record.receivedAt;
  if (record.receivedAt > payloadReceivedAt) {
    return record.receivedAt;
  }
  const messageSentAt = Date.parse(row.rawMessage.timestamp);
  return Number.isFinite(messageSentAt) ? messageSentAt : record.receivedAt;
}

function isDiscordAddressedMessage(rawMessage: DiscordGatewayMessage, botUserId?: string): boolean {
  if (!nonEmptyString(rawMessage.guild_id) || rawMessage.mention_everyone) {
    return true;
  }
  const botId = nonEmptyString(botUserId);
  if (!botId) {
    return true;
  }
  return (
    rawMessage.mentions?.some((user) => user.id === botId) ||
    rawMessage.referenced_message?.author?.id === botId ||
    hasRawDiscordUserMention(rawMessage.content ?? "", botId)
  );
}

function isOrdinaryDiscordReply(rawMessage: DiscordGatewayMessage): boolean {
  const reference = rawMessage.message_reference;
  if (!reference || !nonEmptyString(reference.message_id)) {
    return false;
  }
  if (reference.type != null && reference.type !== MessageReferenceType.Default) {
    return false;
  }
  if (rawMessage.type != null && rawMessage.type !== MessageType.Reply) {
    return false;
  }
  return true;
}

function hasBoundThread(
  rawMessage: DiscordGatewayMessage,
  threadBindings?: DiscordIngressThreadBindingLookup,
): boolean {
  const channelId = nonEmptyString(rawMessage.channel_id);
  if (!channelId || typeof threadBindings?.getByThreadId !== "function") {
    return false;
  }
  try {
    return Boolean(threadBindings.getByThreadId(channelId));
  } catch {
    return true;
  }
}

function hasPotentialDiscordAudioAttachment(rawMessage: DiscordGatewayMessage): boolean {
  return (rawMessage.attachments ?? []).some((attachment) => {
    const contentType = nonEmptyString(attachment.content_type ?? attachment.contentType);
    if (
      contentType?.startsWith("audio/") ||
      typeof attachment.duration_secs === "number" ||
      nonEmptyString(attachment.waveform)
    ) {
      return true;
    }
    const filename = nonEmptyString(attachment.filename);
    const url = nonEmptyString(attachment.url);
    return Boolean(
      (filename && DISCORD_AUDIO_ATTACHMENT_EXTENSIONS.test(filename)) ||
      (url && DISCORD_AUDIO_ATTACHMENT_EXTENSIONS.test(url)),
    );
  });
}

function configuredAgentIds(cfg?: OpenClawConfig): Array<string | undefined> {
  const ids = new Set<string>();
  for (const entry of cfg?.agents?.list ?? []) {
    const id = nonEmptyString(entry?.id);
    if (id) {
      ids.add(id);
    }
  }
  return [undefined, ...ids];
}

async function matchesConfiguredDiscordMentionText(
  rawMessage: DiscordGatewayMessage,
  params: {
    cfg?: OpenClawConfig;
    discordConfig?: DiscordAccountConfig | null;
  },
): Promise<boolean> {
  const text = typeof rawMessage.content === "string" ? rawMessage.content : "";
  const audioOnly = !text.trim() && hasPotentialDiscordAudioAttachment(rawMessage);
  if ((!text.trim() && !audioOnly) || !params.cfg) {
    return false;
  }
  try {
    const { buildMentionRegexes, matchesMentionPatterns } = await loadMentionRuntime();
    for (const agentId of configuredAgentIds(params.cfg)) {
      const mentionRegexes = buildMentionRegexes(params.cfg, agentId, {
        provider: "discord",
        conversationId: nonEmptyString(rawMessage.channel_id),
        providerPolicy: params.discordConfig?.mentionPatterns,
      });
      if (
        (audioOnly && mentionRegexes.length > 0) ||
        matchesMentionPatterns(text, mentionRegexes)
      ) {
        return true;
      }
    }
  } catch {
    return true;
  }
  return false;
}

function hasPotentialActiveDiscordTextControlCommand(
  rawMessage: DiscordGatewayMessage,
  cfg?: OpenClawConfig,
): boolean {
  const text = typeof rawMessage.content === "string" ? rawMessage.content : "";
  if (!hasControlCommand(text, cfg)) {
    return false;
  }
  try {
    return shouldHandleTextCommands({
      cfg: cfg ?? {},
      surface: "discord",
      commandSource: "text",
    });
  } catch {
    return true;
  }
}

function canExpireDiscordStaleAmbientBacklog(
  rawMessage: DiscordGatewayMessage,
  channelKind: DiscordIngressChannelKind | undefined,
  params: {
    guildEntries?: Record<string, DiscordGuildEntryResolved>;
    resolveChannelInfo?: (
      channelId: string,
    ) => { name?: string; parentId?: string; type: number } | undefined;
  },
): boolean {
  const guildId = nonEmptyString(rawMessage.guild_id);
  if (!guildId || channelKind !== "non-thread") {
    return false;
  }
  const guildInfo = resolveDiscordGuildEntry({
    guildId,
    guildEntries: params.guildEntries,
  });
  if (params.guildEntries && Object.keys(params.guildEntries).length > 0 && !guildInfo) {
    return false;
  }
  const channelInfo = params.resolveChannelInfo?.(rawMessage.channel_id);
  const channelConfig = resolveDiscordChannelConfigWithFallback({
    guildInfo,
    channelId: rawMessage.channel_id,
    channelName: channelInfo?.name,
    channelSlug: channelInfo?.name ? normalizeDiscordSlug(channelInfo.name) : "",
    parentId: channelInfo?.parentId,
    scope: "channel",
  });
  if (guildInfo?.channels && Object.keys(guildInfo.channels).length > 0) {
    return channelConfig?.allowed === true;
  }
  return true;
}

export function createDiscordStaleAmbientPendingDisposition(params: {
  botUserId?: string;
  cfg?: OpenClawConfig;
  discordConfig?: DiscordAccountConfig | null;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  threadBindings?: DiscordIngressThreadBindingLookup;
  resolveChannelInfo?: (
    channelId: string,
  ) => { name?: string; parentId?: string; type: number } | undefined;
}) {
  return async (
    record: ChannelIngressQueueRecord<unknown>,
    context: { laneKey: string; now: number },
  ) => {
    const row = readDiscordIngressPendingRow(record.payload);
    if (
      !row ||
      isDiscordAddressedMessage(row.rawMessage, params.botUserId) ||
      context.now - discordIngressRowSentAtMs(record, row) <= DISCORD_STALE_AMBIENT_BACKLOG_MS ||
      hasPotentialActiveDiscordTextControlCommand(row.rawMessage, params.cfg) ||
      isOrdinaryDiscordReply(row.rawMessage) ||
      hasBoundThread(row.rawMessage, params.threadBindings) ||
      (await matchesConfiguredDiscordMentionText(row.rawMessage, params)) ||
      !canExpireDiscordStaleAmbientBacklog(row.rawMessage, row.channelKind, params)
    ) {
      return null;
    }
    return {
      kind: "fail" as const,
      reason: "stale-ambient-backlog",
      message:
        `Discord ambient message ${record.id} on ${context.laneKey} is older than ` +
        `${DISCORD_STALE_AMBIENT_BACKLOG_MS}ms; suppressing stale backlog before dispatch.`,
    };
  };
}
