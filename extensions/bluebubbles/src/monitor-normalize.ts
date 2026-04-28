import { parseFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import {
  asNullableRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  readStringField,
} from "openclaw/plugin-sdk/text-runtime";
import { extractHandleFromChatGuid, normalizeBlueBubblesHandle } from "./targets.js";
import type { BlueBubblesAttachment } from "./types.js";

export const asRecord = asNullableRecord;
const readString = readStringField;

function readNumber(record: Record<string, unknown> | null, key: string): number | undefined {
  if (!record) {
    return undefined;
  }
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(record: Record<string, unknown> | null, key: string): boolean | undefined {
  if (!record) {
    return undefined;
  }
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readNumberLike(record: Record<string, unknown> | null, key: string): number | undefined {
  if (!record) {
    return undefined;
  }
  return parseFiniteNumber(record[key]);
}

export function extractAttachments(message: Record<string, unknown>): BlueBubblesAttachment[] {
  const raw = message["attachments"];
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: BlueBubblesAttachment[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    out.push({
      guid: readString(record, "guid"),
      uti: readString(record, "uti"),
      mimeType: readString(record, "mimeType") ?? readString(record, "mime_type"),
      transferName: readString(record, "transferName") ?? readString(record, "transfer_name"),
      totalBytes: readNumberLike(record, "totalBytes") ?? readNumberLike(record, "total_bytes"),
      height: readNumberLike(record, "height"),
      width: readNumberLike(record, "width"),
      originalROWID: readNumberLike(record, "originalROWID") ?? readNumberLike(record, "rowid"),
    });
  }
  return out;
}

function buildAttachmentPlaceholder(attachments: BlueBubblesAttachment[]): string {
  if (attachments.length === 0) {
    return "";
  }
  const mimeTypes = attachments.map((entry) => entry.mimeType ?? "");
  const allImages = mimeTypes.every((entry) => entry.startsWith("image/"));
  const allVideos = mimeTypes.every((entry) => entry.startsWith("video/"));
  const allAudio = mimeTypes.every((entry) => entry.startsWith("audio/"));
  const tag = allImages
    ? "<media:image>"
    : allVideos
      ? "<media:video>"
      : allAudio
        ? "<media:audio>"
        : "<media:attachment>";
  const label = allImages ? "image" : allVideos ? "video" : allAudio ? "audio" : "file";
  const suffix = attachments.length === 1 ? label : `${label}s`;
  return `${tag} (${attachments.length} ${suffix})`;
}

export function buildMessagePlaceholder(message: NormalizedWebhookMessage): string {
  const attachmentPlaceholder = buildAttachmentPlaceholder(message.attachments ?? []);
  if (attachmentPlaceholder) {
    return attachmentPlaceholder;
  }
  if (message.balloonBundleId) {
    return "<media:sticker>";
  }
  return "";
}

// Returns inline reply tag like "[[reply_to:4]]" for prepending to message body
export function formatReplyTag(message: {
  replyToId?: string;
  replyToShortId?: string;
}): string | null {
  // Prefer short ID
  const rawId = message.replyToShortId || message.replyToId;
  if (!rawId) {
    return null;
  }
  return `[[reply_to:${rawId}]]`;
}

function extractReplyMetadata(message: Record<string, unknown>): {
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
} {
  const replyRaw =
    message["replyTo"] ??
    message["reply_to"] ??
    message["replyToMessage"] ??
    message["reply_to_message"] ??
    message["repliedMessage"] ??
    message["quotedMessage"] ??
    message["associatedMessage"] ??
    message["reply"];
  const replyRecord = asRecord(replyRaw);
  const replyHandle =
    asRecord(replyRecord?.["handle"]) ?? asRecord(replyRecord?.["sender"]) ?? null;
  const replySenderRaw =
    readString(replyHandle, "address") ??
    readString(replyHandle, "handle") ??
    readString(replyHandle, "id") ??
    readString(replyRecord, "senderId") ??
    readString(replyRecord, "sender") ??
    readString(replyRecord, "from");
  const normalizedSender = replySenderRaw
    ? normalizeBlueBubblesHandle(replySenderRaw) || replySenderRaw.trim()
    : undefined;

  const replyToBody =
    readString(replyRecord, "text") ??
    readString(replyRecord, "body") ??
    readString(replyRecord, "message") ??
    readString(replyRecord, "subject") ??
    undefined;

  const directReplyId =
    readString(message, "replyToMessageGuid") ??
    readString(message, "replyToGuid") ??
    readString(message, "replyGuid") ??
    readString(message, "selectedMessageGuid") ??
    readString(message, "selectedMessageId") ??
    readString(message, "replyToMessageId") ??
    readString(message, "replyId") ??
    readString(replyRecord, "guid") ??
    readString(replyRecord, "id") ??
    readString(replyRecord, "messageId");

  const associatedType =
    readNumberLike(message, "associatedMessageType") ??
    readNumberLike(message, "associated_message_type");
  const associatedGuid =
    readString(message, "associatedMessageGuid") ??
    readString(message, "associated_message_guid") ??
    readString(message, "associatedMessageId");
  const isReactionAssociation =
    typeof associatedType === "number" && REACTION_TYPE_MAP.has(associatedType);

  const replyToId = directReplyId ?? (!isReactionAssociation ? associatedGuid : undefined);
  const threadOriginatorGuid = readString(message, "threadOriginatorGuid");
  const messageGuid = readString(message, "guid");
  const fallbackReplyId =
    !replyToId && threadOriginatorGuid && threadOriginatorGuid !== messageGuid
      ? threadOriginatorGuid
      : undefined;

  return {
    replyToId: normalizeOptionalString(replyToId ?? fallbackReplyId),
    replyToBody: normalizeOptionalString(replyToBody),
    replyToSender: normalizedSender || undefined,
  };
}

function readFirstChatRecord(message: Record<string, unknown>): Record<string, unknown> | null {
  const chats = message["chats"];
  if (!Array.isArray(chats) || chats.length === 0) {
    return null;
  }
  const first = chats[0];
  return asRecord(first);
}

function readParticipantEntries(record: Record<string, unknown> | null): unknown[] | undefined {
  if (!record) {
    return undefined;
  }
  const participants = record["participants"];
  if (Array.isArray(participants)) {
    return participants;
  }
  const handles = record["handles"];
  if (Array.isArray(handles)) {
    return handles;
  }
  const participantHandles = record["participantHandles"];
  if (Array.isArray(participantHandles)) {
    return participantHandles;
  }
  return undefined;
}

function extractSenderInfo(message: Record<string, unknown>): {
  senderId: string;
  senderIdExplicit: boolean;
  senderName?: string;
} {
  const handleValue = message.handle ?? message.sender;
  const handle =
    asRecord(handleValue) ?? (typeof handleValue === "string" ? { address: handleValue } : null);
  const senderIdRaw =
    readString(handle, "address") ??
    readString(handle, "handle") ??
    readString(handle, "id") ??
    readString(message, "senderId") ??
    readString(message, "sender") ??
    readString(message, "from") ??
    "";
  const senderId = senderIdRaw.trim();
  const senderName =
    readString(handle, "displayName") ??
    readString(handle, "name") ??
    readString(message, "senderName") ??
    undefined;

  return {
    senderId,
    senderIdExplicit: Boolean(senderId),
    senderName,
  };
}

function extractChatContext(message: Record<string, unknown>): {
  chatGuid?: string;
  chatIdentifier?: string;
  chatId?: number;
  chatName?: string;
  isGroup: boolean;
  participants: unknown[];
} {
  const chat = asRecord(message.chat) ?? asRecord(message.conversation) ?? null;
  const chatFromList = readFirstChatRecord(message);
  const chatGuid =
    readString(message, "chatGuid") ??
    readString(message, "chat_guid") ??
    readString(chat, "chatGuid") ??
    readString(chat, "chat_guid") ??
    readString(chat, "guid") ??
    readString(chatFromList, "chatGuid") ??
    readString(chatFromList, "chat_guid") ??
    readString(chatFromList, "guid");
  const chatIdentifier =
    readString(message, "chatIdentifier") ??
    readString(message, "chat_identifier") ??
    readString(chat, "chatIdentifier") ??
    readString(chat, "chat_identifier") ??
    readString(chat, "identifier") ??
    readString(chatFromList, "chatIdentifier") ??
    readString(chatFromList, "chat_identifier") ??
    readString(chatFromList, "identifier") ??
    extractChatIdentifierFromChatGuid(chatGuid);
  const chatId =
    readNumberLike(message, "chatId") ??
    readNumberLike(message, "chat_id") ??
    readNumberLike(chat, "chatId") ??
    readNumberLike(chat, "chat_id") ??
    readNumberLike(chat, "id") ??
    readNumberLike(chatFromList, "chatId") ??
    readNumberLike(chatFromList, "chat_id") ??
    readNumberLike(chatFromList, "id");
  const chatName =
    readString(message, "chatName") ??
    readString(chat, "displayName") ??
    readString(chat, "name") ??
    readString(chatFromList, "displayName") ??
    readString(chatFromList, "name") ??
    undefined;

  const participants =
    readParticipantEntries(chat) ??
    readParticipantEntries(message) ??
    readParticipantEntries(chatFromList) ??
    [];
  const participantsCount = participants.length;
  const groupFromChatGuid = resolveGroupFlagFromChatGuid(chatGuid);
  const explicitIsGroup =
    readBoolean(message, "isGroup") ??
    readBoolean(message, "is_group") ??
    readBoolean(chat, "isGroup") ??
    readBoolean(message, "group");
  const isGroup =
    typeof groupFromChatGuid === "boolean"
      ? groupFromChatGuid
      : (explicitIsGroup ?? participantsCount > 2);

  return {
    chatGuid,
    chatIdentifier,
    chatId,
    chatName,
    isGroup,
    participants,
  };
}

function normalizeParticipantEntry(entry: unknown): BlueBubblesParticipant | null {
  if (typeof entry === "string" || typeof entry === "number") {
    const raw = String(entry).trim();
    if (!raw) {
      return null;
    }
    const normalized = normalizeBlueBubblesHandle(raw) || raw;
    return normalized ? { id: normalized } : null;
  }
  const record = asRecord(entry);
  if (!record) {
    return null;
  }
  const nestedHandle =
    asRecord(record["handle"]) ?? asRecord(record["sender"]) ?? asRecord(record["contact"]) ?? null;
  const idRaw =
    readString(record, "address") ??
    readString(record, "handle") ??
    readString(record, "id") ??
    readString(record, "phoneNumber") ??
    readString(record, "phone_number") ??
    readString(record, "email") ??
    readString(nestedHandle, "address") ??
    readString(nestedHandle, "handle") ??
    readString(nestedHandle, "id");
  const nameRaw =
    readString(record, "displayName") ??
    readString(record, "name") ??
    readString(record, "title") ??
    readString(nestedHandle, "displayName") ??
    readString(nestedHandle, "name");
  const normalizedId = idRaw ? normalizeBlueBubblesHandle(idRaw) || idRaw.trim() : "";
  if (!normalizedId) {
    return null;
  }
  const name = normalizeOptionalString(nameRaw);
  return { id: normalizedId, name };
}

export function normalizeParticipantList(raw: unknown): BlueBubblesParticipant[] {
  const entries = Array.isArray(raw) ? raw : (readParticipantEntries(asRecord(raw)) ?? []);
  if (entries.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const output: BlueBubblesParticipant[] = [];
  for (const entry of entries) {
    const normalized = normalizeParticipantEntry(entry);
    if (!normalized?.id) {
      continue;
    }
    const key = normalizeLowercaseStringOrEmpty(normalized.id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

export function formatGroupMembers(params: {
  participants?: BlueBubblesParticipant[];
  fallback?: BlueBubblesParticipant;
}): string | undefined {
  const seen = new Set<string>();
  const ordered: BlueBubblesParticipant[] = [];
  for (const entry of params.participants ?? []) {
    if (!entry?.id) {
      continue;
    }
    const key = normalizeLowercaseStringOrEmpty(entry.id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ordered.push(entry);
  }
  if (ordered.length === 0 && params.fallback?.id) {
    ordered.push(params.fallback);
  }
  if (ordered.length === 0) {
    return undefined;
  }
  return ordered.map((entry) => (entry.name ? `${entry.name} (${entry.id})` : entry.id)).join(", ");
}

export function resolveGroupFlagFromChatGuid(chatGuid?: string | null): boolean | undefined {
  const guid = chatGuid?.trim();
  if (!guid) {
    return undefined;
  }
  const parts = guid.split(";");
  if (parts.length >= 3) {
    if (parts[1] === "+") {
      return true;
    }
    if (parts[1] === "-") {
      return false;
    }
  }
  if (guid.includes(";+;")) {
    return true;
  }
  if (guid.includes(";-;")) {
    return false;
  }
  return undefined;
}

function extractChatIdentifierFromChatGuid(chatGuid?: string | null): string | undefined {
  const guid = chatGuid?.trim();
  if (!guid) {
    return undefined;
  }
  const parts = guid.split(";");
  if (parts.length < 3) {
    return undefined;
  }
  const identifier = parts[2]?.trim();
  return identifier || undefined;
}

export function formatGroupAllowlistEntry(params: {
  chatGuid?: string;
  chatId?: number;
  chatIdentifier?: string;
}): string | null {
  const guid = params.chatGuid?.trim();
  if (guid) {
    return `chat_guid:${guid}`;
  }
  const chatId = params.chatId;
  if (typeof chatId === "number" && Number.isFinite(chatId)) {
    return `chat_id:${chatId}`;
  }
  const identifier = params.chatIdentifier?.trim();
  if (identifier) {
    return `chat_identifier:${identifier}`;
  }
  return null;
}

export type BlueBubblesParticipant = {
  id: string;
  name?: string;
};

export type NormalizedWebhookMessage = {
  text: string;
  senderId: string;
  senderIdExplicit: boolean;
  senderName?: string;
  messageId?: string;
  timestamp?: number;
  isGroup: boolean;
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
  chatName?: string;
  fromMe?: boolean;
  attachments?: BlueBubblesAttachment[];
  balloonBundleId?: string;
  associatedMessageGuid?: string;
  associatedMessageType?: number;
  associatedMessageEmoji?: string;
  isTapback?: boolean;
  participants?: BlueBubblesParticipant[];
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  /** Webhook event type preserved for dedup key differentiation. */
  eventType?: string;
  /**
   * When the debouncer merges multiple source webhook events into one
   * processed message (see `combineDebounceEntries` in `monitor-debounce.ts`),
   * this preserves every source `messageId` that contributed to the merged
   * view. Downstream inbound-dedupe commits all of them so a later BlueBubbles
   * MessagePoller replay of any individual source event is recognized as a
   * duplicate rather than re-processed. Unset for single-event messages.
   */
  coalescedMessageIds?: string[];
};

export type NormalizedWebhookReaction = {
  action: "added" | "removed";
  emoji: string;
  senderId: string;
  senderIdExplicit: boolean;
  senderName?: string;
  messageId: string;
  timestamp?: number;
  isGroup: boolean;
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
  chatName?: string;
  fromMe?: boolean;
};

const REACTION_TYPE_MAP = new Map<number, { emoji: string; action: "added" | "removed" }>([
  [2000, { emoji: "❤️", action: "added" }],
  [2001, { emoji: "👍", action: "added" }],
  [2002, { emoji: "👎", action: "added" }],
  [2003, { emoji: "😂", action: "added" }],
  [2004, { emoji: "‼️", action: "added" }],
  [2005, { emoji: "❓", action: "added" }],
  [3000, { emoji: "❤️", action: "removed" }],
  [3001, { emoji: "👍", action: "removed" }],
  [3002, { emoji: "👎", action: "removed" }],
  [3003, { emoji: "😂", action: "removed" }],
  [3004, { emoji: "‼️", action: "removed" }],
  [3005, { emoji: "❓", action: "removed" }],
]);

// Maps tapback text patterns (e.g., "Loved", "Liked") to emoji + action
const TAPBACK_TEXT_MAP = new Map<string, { emoji: string; action: "added" | "removed" }>([
  ["loved", { emoji: "❤️", action: "added" }],
  ["liked", { emoji: "👍", action: "added" }],
  ["disliked", { emoji: "👎", action: "added" }],
  ["laughed at", { emoji: "😂", action: "added" }],
  ["emphasized", { emoji: "‼️", action: "added" }],
  ["questioned", { emoji: "❓", action: "added" }],
  // Removal patterns (e.g., "Removed a heart from")
  ["removed a heart from", { emoji: "❤️", action: "removed" }],
  ["removed a like from", { emoji: "👍", action: "removed" }],
  ["removed a dislike from", { emoji: "👎", action: "removed" }],
  ["removed a laugh from", { emoji: "😂", action: "removed" }],
  ["removed an emphasis from", { emoji: "‼️", action: "removed" }],
  ["removed a question from", { emoji: "❓", action: "removed" }],
]);

const TAPBACK_EMOJI_REGEX =
  /(?:\p{Regional_Indicator}{2})|(?:[0-9#*]\uFE0F?\u20E3)|(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?)*)/u;

function extractFirstEmoji(text: string): string | null {
  const match = text.match(TAPBACK_EMOJI_REGEX);
  return match ? match[0] : null;
}

function extractQuotedTapbackText(text: string): string | null {
  const match = text.match(/[“"]([^”"]+)[”"]/s);
  return match ? match[1] : null;
}

function isTapbackAssociatedType(type: number | undefined): boolean {
  return typeof type === "number" && Number.isFinite(type) && type >= 2000 && type < 4000;
}

function resolveTapbackActionHint(type: number | undefined): "added" | "removed" | undefined {
  if (typeof type !== "number" || !Number.isFinite(type)) {
    return undefined;
  }
  if (type >= 3000 && type < 4000) {
    return "removed";
  }
  if (type >= 2000 && type < 3000) {
    return "added";
  }
  return undefined;
}

export function resolveTapbackContext(message: NormalizedWebhookMessage): {
  emojiHint?: string;
  actionHint?: "added" | "removed";
  replyToId?: string;
} | null {
  const associatedType = message.associatedMessageType;
  const hasTapbackType = isTapbackAssociatedType(associatedType);
  const hasTapbackMarker = Boolean(message.associatedMessageEmoji) || Boolean(message.isTapback);
  if (!hasTapbackType && !hasTapbackMarker) {
    return null;
  }
  const replyToId =
    normalizeOptionalString(message.associatedMessageGuid) ??
    normalizeOptionalString(message.replyToId);
  const actionHint = resolveTapbackActionHint(associatedType);
  const emojiHint =
    message.associatedMessageEmoji?.trim() || REACTION_TYPE_MAP.get(associatedType ?? -1)?.emoji;
  return { emojiHint, actionHint, replyToId };
}

// Detects tapback text patterns like 'Loved "message"' and converts to structured format
export function parseTapbackText(params: {
  text: string;
  emojiHint?: string;
  actionHint?: "added" | "removed";
  requireQuoted?: boolean;
}): {
  emoji: string;
  action: "added" | "removed";
  quotedText: string;
} | null {
  const trimmed = params.text.trim();
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (!trimmed) {
    return null;
  }

  const parseLeadingReactionAction = (
    prefix: "reacted" | "removed",
    defaultAction: "added" | "removed",
  ) => {
    if (!lower.startsWith(prefix)) {
      return null;
    }
    const emoji = extractFirstEmoji(trimmed) ?? params.emojiHint;
    if (!emoji) {
      return null;
    }
    const quotedText = extractQuotedTapbackText(trimmed);
    if (params.requireQuoted && !quotedText) {
      return null;
    }
    const fallback = trimmed.slice(prefix.length).trim();
    return {
      emoji,
      action: params.actionHint ?? defaultAction,
      quotedText: quotedText ?? fallback,
    };
  };

  for (const [pattern, { emoji, action }] of TAPBACK_TEXT_MAP) {
    if (lower.startsWith(pattern)) {
      // Extract quoted text if present (e.g., 'Loved "hello"' -> "hello")
      const afterPattern = trimmed.slice(pattern.length).trim();
      if (params.requireQuoted) {
        const strictMatch = afterPattern.match(/^[“"](.+)[”"]$/s);
        if (!strictMatch) {
          return null;
        }
        return { emoji, action, quotedText: strictMatch[1] };
      }
      const quotedText =
        extractQuotedTapbackText(afterPattern) ?? extractQuotedTapbackText(trimmed) ?? afterPattern;
      return { emoji, action, quotedText };
    }
  }

  const reacted = parseLeadingReactionAction("reacted", "added");
  if (reacted) {
    return reacted;
  }

  const removed = parseLeadingReactionAction("removed", "removed");
  if (removed) {
    return removed;
  }
  return null;
}

function extractMessagePayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  const parseRecord = (value: unknown): Record<string, unknown> | null => {
    const record = asRecord(value);
    if (record) {
      return record;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const parsedEntry = parseRecord(entry);
        if (parsedEntry) {
          return parsedEntry;
        }
      }
      return null;
    }
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    try {
      return parseRecord(JSON.parse(trimmed));
    } catch {
      return null;
    }
  };

  const dataRaw = payload.data ?? payload.payload ?? payload.event;
  const data = parseRecord(dataRaw);
  const messageRaw = payload.message ?? data?.message ?? data;
  const message = parseRecord(messageRaw);
  if (message) {
    return message;
  }
  return null;
}

export function normalizeWebhookMessage(
  payload: Record<string, unknown>,
  options?: { eventType?: string },
): NormalizedWebhookMessage | null {
  const message = extractMessagePayload(payload);
  if (!message) {
    return null;
  }

  const text =
    readString(message, "text") ??
    readString(message, "body") ??
    readString(message, "subject") ??
    "";

  const { senderId, senderIdExplicit, senderName } = extractSenderInfo(message);
  const { chatGuid, chatIdentifier, chatId, chatName, isGroup, participants } =
    extractChatContext(message);
  const normalizedParticipants = normalizeParticipantList(participants);

  const fromMe = readBoolean(message, "isFromMe") ?? readBoolean(message, "is_from_me");
  const messageId =
    readString(message, "guid") ??
    readString(message, "id") ??
    readString(message, "messageId") ??
    undefined;
  const balloonBundleId = readString(message, "balloonBundleId");
  const associatedMessageGuid =
    readString(message, "associatedMessageGuid") ??
    readString(message, "associated_message_guid") ??
    readString(message, "associatedMessageId") ??
    undefined;
  const associatedMessageType =
    readNumberLike(message, "associatedMessageType") ??
    readNumberLike(message, "associated_message_type");
  const associatedMessageEmoji =
    readString(message, "associatedMessageEmoji") ??
    readString(message, "associated_message_emoji") ??
    readString(message, "reactionEmoji") ??
    readString(message, "reaction_emoji") ??
    undefined;
  const isTapback =
    readBoolean(message, "isTapback") ??
    readBoolean(message, "is_tapback") ??
    readBoolean(message, "tapback") ??
    undefined;

  const timestampRaw =
    readNumber(message, "date") ??
    readNumber(message, "dateCreated") ??
    readNumber(message, "timestamp");
  const timestamp =
    typeof timestampRaw === "number"
      ? timestampRaw > 1_000_000_000_000
        ? timestampRaw
        : timestampRaw * 1000
      : undefined;

  // BlueBubbles may omit `handle` in webhook payloads; for DM chat GUIDs we can still infer sender.
  const senderFallbackFromChatGuid =
    !senderIdExplicit && !isGroup && chatGuid ? extractHandleFromChatGuid(chatGuid) : null;
  const normalizedSender = normalizeBlueBubblesHandle(senderId || senderFallbackFromChatGuid || "");
  if (!normalizedSender) {
    return null;
  }
  const replyMetadata = extractReplyMetadata(message);

  return {
    text,
    senderId: normalizedSender,
    senderIdExplicit,
    senderName,
    messageId,
    timestamp,
    isGroup,
    chatId,
    chatGuid,
    chatIdentifier,
    chatName,
    fromMe,
    attachments: extractAttachments(message),
    balloonBundleId,
    associatedMessageGuid,
    associatedMessageType,
    associatedMessageEmoji,
    isTapback,
    participants: normalizedParticipants,
    replyToId: replyMetadata.replyToId,
    replyToBody: replyMetadata.replyToBody,
    replyToSender: replyMetadata.replyToSender,
    eventType: options?.eventType,
  };
}

export function normalizeWebhookReaction(
  payload: Record<string, unknown>,
): NormalizedWebhookReaction | null {
  const message = extractMessagePayload(payload);
  if (!message) {
    return null;
  }

  const associatedGuid =
    readString(message, "associatedMessageGuid") ??
    readString(message, "associated_message_guid") ??
    readString(message, "associatedMessageId");
  const associatedType =
    readNumberLike(message, "associatedMessageType") ??
    readNumberLike(message, "associated_message_type");
  if (!associatedGuid || associatedType === undefined) {
    return null;
  }

  const mapping = REACTION_TYPE_MAP.get(associatedType);
  const associatedEmoji =
    readString(message, "associatedMessageEmoji") ??
    readString(message, "associated_message_emoji") ??
    readString(message, "reactionEmoji") ??
    readString(message, "reaction_emoji");
  const emoji = (associatedEmoji?.trim() || mapping?.emoji) ?? `reaction:${associatedType}`;
  const action = mapping?.action ?? resolveTapbackActionHint(associatedType) ?? "added";

  const { senderId, senderIdExplicit, senderName } = extractSenderInfo(message);
  const { chatGuid, chatIdentifier, chatId, chatName, isGroup } = extractChatContext(message);

  const fromMe = readBoolean(message, "isFromMe") ?? readBoolean(message, "is_from_me");
  const timestampRaw =
    readNumberLike(message, "date") ??
    readNumberLike(message, "dateCreated") ??
    readNumberLike(message, "timestamp");
  const timestamp =
    typeof timestampRaw === "number"
      ? timestampRaw > 1_000_000_000_000
        ? timestampRaw
        : timestampRaw * 1000
      : undefined;

  const senderFallbackFromChatGuid =
    !senderIdExplicit && !isGroup && chatGuid ? extractHandleFromChatGuid(chatGuid) : null;
  const normalizedSender = normalizeBlueBubblesHandle(senderId || senderFallbackFromChatGuid || "");
  if (!normalizedSender) {
    return null;
  }

  return {
    action,
    emoji,
    senderId: normalizedSender,
    senderIdExplicit,
    senderName,
    messageId: associatedGuid,
    timestamp,
    isGroup,
    chatId,
    chatGuid,
    chatIdentifier,
    chatName,
    fromMe,
  };
}
