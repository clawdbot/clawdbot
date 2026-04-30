import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
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
import { buildDiscordMediaPlaceholder } from "./message-media.js";

export function resolveDiscordEmbedText(
  embed?: { title?: string | null; description?: string | null } | null,
): string {
  const title = normalizeOptionalString(embed?.title) ?? "";
  const description = normalizeOptionalString(embed?.description) ?? "";
  if (title && description) {
    return `${title}\n${description}`;
  }
  return title || description || "";
}

export function resolveDiscordMessageText(
  message: Message,
  options?: { fallbackText?: string; includeForwarded?: boolean },
): string {
  const embedText = resolveDiscordEmbedText(
    (message.embeds?.[0] as { title?: string | null; description?: string | null } | undefined) ??
      null,
  );
  const rawText =
    normalizeOptionalString(message.content) ||
    buildDiscordMediaPlaceholder({
      attachments: message.attachments ?? undefined,
      stickers: resolveDiscordMessageStickers(message),
    }) ||
    embedText ||
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
    const label = user.globalName || user.username;
    out = out.replace(new RegExp(`<@!?${user.id}>`, "g"), `@${label}`);
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
  const referencedText = resolveDiscordMessageText(referencedForward);
  if (!referencedText) {
    return "";
  }
  const authorLabel = formatDiscordSnapshotAuthor(referencedForward.author);
  const heading = authorLabel ? `[Forwarded message from ${authorLabel}]` : "[Forwarded message]";
  return `${heading}\n${referencedText}`;
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
  const attachmentText = buildDiscordMediaPlaceholder({
    attachments: snapshot.attachments ?? undefined,
    stickers: resolveDiscordSnapshotStickers(snapshot),
  });
  const embedText = resolveDiscordEmbedText(snapshot.embeds?.[0]);
  return content || attachmentText || embedText || "";
}
