// Discord plugin module implements message text behavior.
import { ComponentType } from "discord-api-types/v10";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Message } from "../internal/discord.js";
import {
  formatDiscordSnapshotAuthor,
  normalizeDiscordMessageSnapshots,
  resolveDiscordMessageSnapshots,
  resolveDiscordMessageStickers,
  resolveDiscordReferencedForwardMessage,
  resolveDiscordSnapshotStickers,
  type DiscordSnapshotMessage,
} from "./message-forwarded.js";
import { formatDiscordMediaText } from "./message-media.js";

export function resolveDiscordEmbedText(
  embeds?: readonly { title?: string | null; description?: string | null }[] | null,
): string {
  return (embeds ?? [])
    .flatMap(({ title, description }) => [
      normalizeOptionalString(title),
      normalizeOptionalString(description),
    ])
    .filter(Boolean)
    .join("\n");
}

export function resolveDiscordMessageText(
  message: Message,
  options?: { fallbackText?: string; includeForwarded?: boolean },
): string {
  const embedText = resolveDiscordEmbedText(message.embeds);
  const componentText = extractDiscordComponentsV2Text(resolveDiscordMessageComponents(message));
  const rawText =
    normalizeOptionalString(message.content) ||
    embedText ||
    componentText ||
    normalizeOptionalString(options?.fallbackText) ||
    "";
  const baseText = resolveDiscordMentions(rawText, message);
  if (!options?.includeForwarded) {
    return baseText;
  }
  const forwardedText = resolveDiscordForwardedMessagesText(message);
  if (!forwardedText) {
    return baseText;
  }
  if (!baseText) {
    return forwardedText;
  }
  return `${baseText}\n${forwardedText}`;
}

export function resolveDiscordMessageMentionDocuments(message: Message): string[] {
  const content = typeof message.content === "string" ? message.content : "";
  if (content.trim()) {
    return [content];
  }
  const embedDocuments = (message.embeds ?? []).flatMap(({ title, description }) =>
    [title, description].filter(
      (value): value is string => typeof value === "string" && Boolean(value.trim()),
    ),
  );
  if (embedDocuments.length > 0) {
    return embedDocuments;
  }
  const componentDocuments: string[] = [];
  collectDiscordTextDisplayDocuments(resolveDiscordMessageComponents(message), componentDocuments);
  return componentDocuments;
}

/** Adds native media text only for history surfaces that cannot carry structured facts. */
export function resolveDiscordMessageHistoryText(
  message: Message,
  options?: { fallbackText?: string; includeForwarded?: boolean },
): string {
  const text = resolveDiscordMessageText(message, options);
  const mediaText = formatDiscordMediaText({
    attachments: message.attachments ?? undefined,
    stickers: resolveDiscordMessageStickers(message),
  });
  return [text, mediaText].filter(Boolean).join("\n");
}

function resolveDiscordMentions(text: string, message: Message): string {
  if (!text.includes("<")) {
    return text;
  }
  const mentions = message.mentionedUsers ?? [];
  if (!Array.isArray(mentions) || mentions.length === 0) {
    return text;
  }
  let out = text;
  for (const user of mentions) {
    const label = user.globalName || user.username || user.id;
    out = out.replace(new RegExp(`<@!?${user.id}>`, "g"), () => `@${label}`);
  }
  return out;
}

function resolveDiscordForwardedMessagesText(message: Message): string {
  const snapshots = resolveDiscordMessageSnapshots(message);
  if (snapshots.length > 0) {
    return resolveDiscordForwardedMessagesTextFromSnapshots(snapshots);
  }
  const referencedForward = resolveDiscordReferencedForwardMessage(message);
  if (!referencedForward) {
    return "";
  }
  const referencedText = resolveDiscordMessageHistoryText(referencedForward);
  if (!referencedText) {
    return "";
  }
  const authorLabel = formatDiscordSnapshotAuthor(referencedForward.author);
  const heading = authorLabel ? `[Forwarded message from ${authorLabel}]` : "[Forwarded message]";
  return `${heading}\n${referencedText}`;
}

function resolveDiscordMessageComponents(message: Message): unknown {
  const components = (message as { components?: unknown }).components;
  if (components !== undefined) {
    return components;
  }
  try {
    return (message as { rawData?: { components?: unknown } }).rawData?.components;
  } catch {
    return undefined;
  }
}

function extractDiscordComponentsV2Text(components: unknown): string {
  const parts: string[] = [];
  collectDiscordTextDisplayDocuments(components, parts);
  return parts
    .map((part) => normalizeOptionalString(part))
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

function collectDiscordTextDisplayDocuments(value: unknown, parts: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDiscordTextDisplayDocuments(entry, parts);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const component = value as {
    type?: unknown;
    content?: unknown;
    components?: unknown;
    component?: unknown;
  };
  if (
    component.type === ComponentType.TextDisplay &&
    typeof component.content === "string" &&
    component.content.trim()
  ) {
    parts.push(component.content);
  }
  collectDiscordTextDisplayDocuments(component.components, parts);
  collectDiscordTextDisplayDocuments(component.component, parts);
}

export function resolveDiscordForwardedMessagesTextFromSnapshots(snapshots: unknown): string {
  const forwardedBlocks = normalizeDiscordMessageSnapshots(snapshots)
    .map((snapshot) => buildDiscordForwardedMessageBlock(snapshot.message))
    .filter((entry): entry is string => Boolean(entry));
  if (forwardedBlocks.length === 0) {
    return "";
  }
  return forwardedBlocks.join("\n\n");
}

function buildDiscordForwardedMessageBlock(
  snapshotMessage: DiscordSnapshotMessage | null | undefined,
): string | null {
  if (!snapshotMessage) {
    return null;
  }
  const text = resolveDiscordSnapshotMessageText(snapshotMessage);
  if (!text) {
    return null;
  }
  const authorLabel = formatDiscordSnapshotAuthor(snapshotMessage.author);
  const heading = authorLabel ? `[Forwarded message from ${authorLabel}]` : "[Forwarded message]";
  return `${heading}\n${text}`;
}

function resolveDiscordSnapshotMessageText(snapshot: DiscordSnapshotMessage): string {
  const content = normalizeOptionalString(snapshot.content) ?? "";
  const attachmentText = formatDiscordMediaText({
    attachments: snapshot.attachments ?? undefined,
    stickers: resolveDiscordSnapshotStickers(snapshot),
  });
  const embedText = resolveDiscordEmbedText(snapshot.embeds);
  const componentText = extractDiscordComponentsV2Text(snapshot.components);
  const text = content || embedText || componentText;
  return [text, attachmentText].filter(Boolean).join("\n");
}
