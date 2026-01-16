import { formatLocationText, type NormalizedLocation } from "../../channels/location.js";
import type { TelegramAccountConfig } from "../../config/types.telegram.js";
import type {
  TelegramLocation,
  TelegramMessage,
  TelegramStreamMode,
  TelegramVenue,
} from "./types.js";

const TELEGRAM_GENERAL_TOPIC_ID = 1;

export function resolveTelegramForumThreadId(params: {
  isForum?: boolean;
  messageThreadId?: number | null;
}) {
  if (params.isForum && params.messageThreadId == null) {
    return TELEGRAM_GENERAL_TOPIC_ID;
  }
  return params.messageThreadId ?? undefined;
}

/**
 * Build thread params for Telegram API calls (messages, media).
 * Excludes General topic (id=1) as Telegram rejects explicit message_thread_id=1
 * for sendMessage calls in forum supergroups ("message thread not found" error).
 */
export function buildTelegramThreadParams(messageThreadId?: number) {
  if (messageThreadId == null || messageThreadId === TELEGRAM_GENERAL_TOPIC_ID) {
    return undefined;
  }
  return { message_thread_id: messageThreadId };
}

/**
 * Build thread params for typing indicators (sendChatAction).
 * Unlike sendMessage, sendChatAction accepts message_thread_id=1 for General topic.
 */
export function buildTypingThreadParams(messageThreadId?: number) {
  if (messageThreadId == null) {
    return undefined;
  }
  return { message_thread_id: messageThreadId };
}

export function resolveTelegramStreamMode(
  telegramCfg: Pick<TelegramAccountConfig, "streamMode"> | undefined,
): TelegramStreamMode {
  const raw = telegramCfg?.streamMode?.trim().toLowerCase();
  if (raw === "off" || raw === "partial" || raw === "block") return raw;
  return "partial";
}

export function buildTelegramGroupPeerId(chatId: number | string, messageThreadId?: number) {
  return messageThreadId != null ? `${chatId}:topic:${messageThreadId}` : String(chatId);
}

export function buildTelegramGroupFrom(chatId: number | string, messageThreadId?: number) {
  return messageThreadId != null ? `group:${chatId}:topic:${messageThreadId}` : `group:${chatId}`;
}

export function buildSenderName(msg: TelegramMessage) {
  const name =
    [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").trim() ||
    msg.from?.username;
  return name || undefined;
}

export function buildSenderLabel(msg: TelegramMessage, senderId?: number | string) {
  const name = buildSenderName(msg);
  const username = msg.from?.username ? `@${msg.from.username}` : undefined;
  let label = name;
  if (name && username) {
    label = `${name} (${username})`;
  } else if (!name && username) {
    label = username;
  }
  const normalizedSenderId =
    senderId != null && `${senderId}`.trim() ? `${senderId}`.trim() : undefined;
  const fallbackId = normalizedSenderId ?? (msg.from?.id != null ? String(msg.from.id) : undefined);
  const idPart = fallbackId ? `id:${fallbackId}` : undefined;
  if (label && idPart) return `${label} ${idPart}`;
  if (label) return label;
  return idPart ?? "id:unknown";
}

export function buildGroupLabel(
  msg: TelegramMessage,
  chatId: number | string,
  messageThreadId?: number,
) {
  const title = msg.chat?.title;
  const topicSuffix = messageThreadId != null ? ` topic:${messageThreadId}` : "";
  if (title) return `${title} id:${chatId}${topicSuffix}`;
  return `group:${chatId}${topicSuffix}`;
}

export function buildGroupFromLabel(
  msg: TelegramMessage,
  chatId: number | string,
  senderId?: number | string,
  messageThreadId?: number,
) {
  const groupLabel = buildGroupLabel(msg, chatId, messageThreadId);
  const senderLabel = buildSenderLabel(msg, senderId);
  return `${groupLabel} from ${senderLabel}`;
}

export function hasBotMention(msg: TelegramMessage, botUsername: string) {
  const text = (msg.text ?? msg.caption ?? "").toLowerCase();
  if (text.includes(`@${botUsername}`)) return true;
  const entities = msg.entities ?? msg.caption_entities ?? [];
  for (const ent of entities) {
    if (ent.type !== "mention") continue;
    const slice = (msg.text ?? msg.caption ?? "").slice(ent.offset, ent.offset + ent.length);
    if (slice.toLowerCase() === `@${botUsername}`) return true;
  }
  return false;
}

export function resolveTelegramReplyId(raw?: string): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

export function describeReplyTarget(msg: TelegramMessage) {
  const reply = msg.reply_to_message;
  if (!reply) return null;
  const replyBody = (reply.text ?? reply.caption ?? "").trim();
  let body = replyBody;
  if (!body) {
    if (reply.photo) body = "<media:image>";
    else if (reply.video) body = "<media:video>";
    else if (reply.audio || reply.voice) body = "<media:audio>";
    else if (reply.document) body = "<media:document>";
    else {
      const locationData = extractTelegramLocation(reply);
      if (locationData) body = formatLocationText(locationData);
    }
  }
  if (!body) return null;
  const sender = buildSenderName(reply);
  const senderLabel = sender ? `${sender}` : "unknown sender";
  return {
    id: reply.message_id ? String(reply.message_id) : undefined,
    sender: senderLabel,
    body,
  };
}

export function extractTelegramLocation(msg: TelegramMessage): NormalizedLocation | null {
  const msgWithLocation = msg as {
    location?: TelegramLocation;
    venue?: TelegramVenue;
  };
  const { venue, location } = msgWithLocation;

  if (venue) {
    return {
      latitude: venue.location.latitude,
      longitude: venue.location.longitude,
      accuracy: venue.location.horizontal_accuracy,
      name: venue.title,
      address: venue.address,
      source: "place",
      isLive: false,
    };
  }

  if (location) {
    const isLive = typeof location.live_period === "number" && location.live_period > 0;
    return {
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.horizontal_accuracy,
      source: isLive ? "live" : "pin",
      isLive,
    };
  }

  return null;
}
