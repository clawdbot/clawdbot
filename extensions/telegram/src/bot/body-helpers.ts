// Telegram helper module supports body helpers behavior.
import type { Chat, Message, MessageOrigin, User } from "grammy/types";
import type {
  ChannelInboundMediaInput,
  NormalizedLocation,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { telegramHtmlToPlainTextFallback } from "../format.js";
import { renderTelegramTextEntities } from "./inbound-text-entities.js";

type TelegramMediaMessage = Pick<
  Message,
  "photo" | "video" | "video_note" | "audio" | "voice" | "document" | "sticker"
>;

type TelegramMediaFileRef =
  | NonNullable<Message["photo"]>[number]
  | NonNullable<Message["video"]>
  | NonNullable<Message["video_note"]>
  | NonNullable<Message["audio"]>
  | NonNullable<Message["voice"]>
  | NonNullable<Message["document"]>
  | NonNullable<Message["sticker"]>;

export type TelegramMediaKind = Exclude<NonNullable<ChannelInboundMediaInput["kind"]>, "unknown">;

type TelegramPrimaryMedia = {
  kind: TelegramMediaKind;
  fileRef: TelegramMediaFileRef;
};

export function buildSenderName(msg: Message) {
  const name =
    [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").trim() ||
    msg.from?.username;
  return name || undefined;
}

export function resolveTelegramPrimaryMedia(
  msg: TelegramMediaMessage | undefined | null,
): TelegramPrimaryMedia | undefined {
  if (!msg) {
    return undefined;
  }
  const photo = msg.photo?.[msg.photo.length - 1];
  if (photo) {
    return { kind: "image", fileRef: photo };
  }
  if (msg.video) {
    return { kind: "video", fileRef: msg.video };
  }
  if (msg.video_note) {
    return { kind: "video", fileRef: msg.video_note };
  }
  if (msg.audio) {
    return { kind: "audio", fileRef: msg.audio };
  }
  if (msg.voice) {
    return { kind: "audio", fileRef: msg.voice };
  }
  if (msg.document) {
    return { kind: "document", fileRef: msg.document };
  }
  if (msg.sticker) {
    return { kind: "sticker", fileRef: msg.sticker };
  }
  return undefined;
}

export function buildSenderLabel(msg: Message, senderId?: number | string) {
  const name = buildSenderName(msg);
  const username = msg.from?.username ? `@${msg.from.username}` : undefined;
  let label = name;
  if (name && username) {
    label = `${name} (${username})`;
  } else if (!name && username) {
    label = username;
  }
  const normalizedSenderId =
    senderId != null ? normalizeOptionalString(String(senderId)) : undefined;
  const fallbackId = normalizedSenderId ?? (msg.from?.id != null ? String(msg.from.id) : undefined);
  const idPart = fallbackId ? `id:${fallbackId}` : undefined;
  if (label && idPart) {
    return `${label} ${idPart}`;
  }
  if (label) {
    return label;
  }
  return idPart ?? "id:unknown";
}

export type TelegramTextEntity = NonNullable<Message["entities"]>[number];

const TELEGRAM_RICH_MESSAGE_PLACEHOLDER = "[unsupported Telegram rich_message received]";

type TelegramTextMessage = Pick<
  Message,
  "text" | "caption" | "entities" | "caption_entities" | "poll"
> & { rich_message?: unknown };

function compactRichText(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function joinRichText(parts: string[], separator: string): string {
  return parts.map(compactRichText).filter(Boolean).join(separator);
}

function renderRichInlineText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(renderRichInlineText).filter(Boolean).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  const directText = value.text;
  if (directText !== undefined) {
    return renderRichInlineText(directText);
  }
  for (const key of ["alternative_text", "expression"] as const) {
    const text = value[key];
    if (typeof text === "string") {
      return text;
    }
  }
  return "";
}

function renderRichBlocks(value: unknown): string {
  if (Array.isArray(value)) {
    return joinRichText(value.map(renderRichBlocks), "\n");
  }
  if (!isRecord(value)) {
    return renderRichInlineText(value);
  }
  if (typeof value.markdown === "string") {
    return value.markdown;
  }
  if (typeof value.html === "string") {
    return telegramHtmlToPlainTextFallback(value.html);
  }
  const parts: string[] = [];
  for (const key of [
    "text",
    "summary",
    "label",
    "title",
    "subtitle",
    "credit",
    "expression",
  ] as const) {
    parts.push(renderRichInlineText(value[key]));
  }
  if (value.caption !== undefined) {
    const caption = value.caption;
    if (isRecord(caption) && caption.credit !== undefined) {
      parts.push(
        joinRichText(
          [renderRichInlineText(caption.text), renderRichInlineText(caption.credit)],
          "\n",
        ),
      );
    } else {
      parts.push(renderRichInlineText(caption));
    }
  }
  for (const key of ["blocks", "items", "rows", "cells", "headers", "children"] as const) {
    parts.push(renderRichBlocks(value[key]));
  }
  return joinRichText(parts, "\n");
}

export function resolveTelegramRichMessagePlaceholder(
  msg: TelegramTextMessage,
): string | undefined {
  return isRecord(msg.rich_message) ? TELEGRAM_RICH_MESSAGE_PLACEHOLDER : undefined;
}

export function resolveTelegramRichMessageText(msg: TelegramTextMessage): string | undefined {
  if (!isRecord(msg.rich_message)) {
    return undefined;
  }
  return compactRichText(renderRichBlocks(msg.rich_message)) || undefined;
}

export function resolveTelegramRichMessageBody(msg: TelegramTextMessage): string | undefined {
  return resolveTelegramRichMessageText(msg) ?? resolveTelegramRichMessagePlaceholder(msg);
}

export function isBinaryContent(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return true;
    }
  }
  return false;
}

export function resolveTelegramTextContent(text: unknown, caption?: unknown): string {
  const raw = typeof text === "string" ? text : typeof caption === "string" ? caption : "";
  return isBinaryContent(raw) ? "" : raw;
}

function formatTelegramPollText(poll: NonNullable<Message["poll"]>): string {
  const correctOptionIds = new Set(poll.correct_option_ids ?? []);
  const optionLines = poll.options.map((option, index) => {
    const optionText = renderTelegramTextEntities(option.text, option.text_entities);
    const voteLabel = option.voter_count === 1 ? "vote" : "votes";
    const correctLabel = correctOptionIds.has(index) ? " (correct)" : "";
    return `${index + 1}. ${optionText} — ${option.voter_count} ${voteLabel}${correctLabel}`;
  });

  return [
    `[Poll] ${renderTelegramTextEntities(poll.question, poll.question_entities)}`,
    ...(poll.description
      ? [renderTelegramTextEntities(poll.description, poll.description_entities)]
      : []),
    ...optionLines,
    `Total voters: ${poll.total_voter_count}`,
    `Type: ${poll.type}`,
    `Visibility: ${poll.is_anonymous ? "anonymous" : "public"}`,
    `Selection: ${poll.allows_multiple_answers ? "multiple answers" : "single answer"}`,
    `Status: ${poll.is_closed ? "closed" : "open"}`,
    ...(poll.explanation
      ? [`Explanation: ${renderTelegramTextEntities(poll.explanation, poll.explanation_entities)}`]
      : []),
  ].join("\n");
}

export function getTelegramTextParts(msg: TelegramTextMessage): {
  text: string;
  entities: TelegramTextEntity[];
} {
  const text = resolveTelegramTextContent(msg.text, msg.caption);
  if (text) {
    return { text, entities: msg.entities ?? msg.caption_entities ?? [] };
  }
  return { text: msg.poll ? formatTelegramPollText(msg.poll) : "", entities: [] };
}

export function joinTelegramTextParts(
  messages: readonly Message[],
  separator: string,
): { text: string; entities: TelegramTextEntity[] } {
  const textParts: string[] = [];
  const entities: TelegramTextEntity[] = [];
  let offset = 0;

  for (const message of messages) {
    const textPart = getTelegramTextParts(message);
    if (!textPart.text) {
      continue;
    }
    if (textParts.length > 0) {
      offset += separator.length;
    }
    entities.push(
      ...textPart.entities.map((entity) => ({ ...entity, offset: entity.offset + offset })),
    );
    textParts.push(textPart.text);
    offset += textPart.text.length;
  }

  return { text: textParts.join(separator), entities };
}

function isTelegramMentionWordChar(char: string | undefined): boolean {
  return char != null && /[a-z0-9_]/i.test(char);
}

function hasStandaloneTelegramMention(text: string, mention: string): boolean {
  let startIndex = 0;
  while (startIndex < text.length) {
    const idx = text.indexOf(mention, startIndex);
    if (idx === -1) {
      return false;
    }
    const prev = idx > 0 ? text[idx - 1] : undefined;
    const next = text[idx + mention.length];
    if (!isTelegramMentionWordChar(prev) && !isTelegramMentionWordChar(next)) {
      return true;
    }
    startIndex = idx + 1;
  }
  return false;
}

function isBotCommandAddressedToMention(command: string, mention: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(command);
  if (!normalized.startsWith("/") || !normalized.endsWith(mention)) {
    return false;
  }
  const atIndex = normalized.lastIndexOf(mention);
  return atIndex > 1;
}

export function hasBotMention(msg: Message, botUsername: string) {
  const { text, entities } = getTelegramTextParts(msg);
  const mention = normalizeLowercaseStringOrEmpty(`@${botUsername}`);
  if (hasStandaloneTelegramMention(normalizeLowercaseStringOrEmpty(text), mention)) {
    return true;
  }
  for (const ent of entities) {
    const slice = text.slice(ent.offset, ent.offset + ent.length);
    if (ent.type === "mention" && normalizeLowercaseStringOrEmpty(slice) === mention) {
      return true;
    }
    if (ent.type === "bot_command" && isBotCommandAddressedToMention(slice, mention)) {
      return true;
    }
  }
  return false;
}

export function hasLeadingBotCommandAddressedToOtherBot(
  msg: Message,
  botUsername: string,
): boolean {
  const { text, entities } = getTelegramTextParts(msg);
  const normalizedBotUsername = normalizeLowercaseStringOrEmpty(botUsername).replace(/^@/u, "");
  if (!normalizedBotUsername) {
    return false;
  }
  const leadingCommand = entities.find(
    (entity) => entity.type === "bot_command" && entity.offset === 0,
  );
  if (!leadingCommand) {
    return false;
  }
  const command = text.slice(0, leadingCommand.length);
  const target = command.match(/^\/[^@\s]+@([a-z0-9_]+)$/iu)?.[1];
  return Boolean(target && target.toLowerCase() !== normalizedBotUsername);
}

export function hasBotMentionInText(text: string, botUsername: string): boolean {
  return hasStandaloneTelegramMention(
    normalizeLowercaseStringOrEmpty(text),
    normalizeLowercaseStringOrEmpty(`@${botUsername}`),
  );
}

export type TelegramForwardedContext = {
  from: string;
  date?: number;
  fromType: string;
  fromId?: string;
  fromUsername?: string;
  fromTitle?: string;
  fromSignature?: string;
  fromChatType?: Chat["type"];
  fromMessageId?: number;
};

function normalizeForwardedUserLabel(user: User) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  const username = normalizeOptionalString(user.username);
  const id = String(user.id);
  const display =
    (name && username
      ? `${name} (@${username})`
      : name || (username ? `@${username}` : undefined)) || `user:${id}`;
  return { display, name: name || undefined, username, id };
}

function normalizeForwardedChatLabel(chat: Chat, fallbackKind: "chat" | "channel") {
  const title = normalizeOptionalString(chat.title);
  const username = normalizeOptionalString(chat.username);
  const id = String(chat.id);
  const display = title || (username ? `@${username}` : undefined) || `${fallbackKind}:${id}`;
  return { display, title, username, id };
}

function buildForwardedContextFromUser(params: {
  user: User;
  date?: number;
  type: string;
}): TelegramForwardedContext | null {
  const { display, name, username, id } = normalizeForwardedUserLabel(params.user);
  if (!display) {
    return null;
  }
  return {
    from: display,
    date: params.date,
    fromType: params.type,
    fromId: id,
    fromUsername: username,
    fromTitle: name,
  };
}

function buildForwardedContextFromHiddenName(params: {
  name?: string;
  date?: number;
  type: string;
}): TelegramForwardedContext | null {
  const trimmed = params.name?.trim();
  if (!trimmed) {
    return null;
  }
  return {
    from: trimmed,
    date: params.date,
    fromType: params.type,
    fromTitle: trimmed,
  };
}

function buildForwardedContextFromChat(params: {
  chat: Chat;
  date?: number;
  type: string;
  signature?: string;
  messageId?: number;
}): TelegramForwardedContext | null {
  const fallbackKind = params.type === "channel" ? "channel" : "chat";
  const { display, title, username, id } = normalizeForwardedChatLabel(params.chat, fallbackKind);
  if (!display) {
    return null;
  }
  const signature = normalizeOptionalString(params.signature);
  const from = signature ? `${display} (${signature})` : display;
  const chatType = normalizeOptionalString(params.chat.type) as Chat["type"] | undefined;
  return {
    from,
    date: params.date,
    fromType: params.type,
    fromId: id,
    fromUsername: username,
    fromTitle: title,
    fromSignature: signature,
    fromChatType: chatType,
    fromMessageId: params.messageId,
  };
}

function resolveForwardOrigin(origin: MessageOrigin): TelegramForwardedContext | null {
  switch (origin.type) {
    case "user":
      return buildForwardedContextFromUser({
        user: origin.sender_user,
        date: origin.date,
        type: "user",
      });
    case "hidden_user":
      return buildForwardedContextFromHiddenName({
        name: origin.sender_user_name,
        date: origin.date,
        type: "hidden_user",
      });
    case "chat":
      return buildForwardedContextFromChat({
        chat: origin.sender_chat,
        date: origin.date,
        type: "chat",
        signature: origin.author_signature,
      });
    case "channel":
      return buildForwardedContextFromChat({
        chat: origin.chat,
        date: origin.date,
        type: "channel",
        signature: origin.author_signature,
        messageId: origin.message_id,
      });
    default:
      origin satisfies never;
      return null;
  }
}

export function normalizeForwardedContext(msg: Message): TelegramForwardedContext | null {
  if (!msg.forward_origin) {
    return null;
  }
  return resolveForwardOrigin(msg.forward_origin);
}

export function extractTelegramLocation(msg: Message): NormalizedLocation | null {
  const { venue, location } = msg;

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
