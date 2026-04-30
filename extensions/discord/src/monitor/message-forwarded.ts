import type { APIAttachment, APIStickerItem } from "discord-api-types/v10";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { Message } from "../internal/discord.js";

export type DiscordSnapshotAuthor = {
  id?: string | null;
  username?: string | null;
  discriminator?: string | null;
  global_name?: string | null;
  name?: string | null;
};

export type DiscordSnapshotMessage = {
  content?: string | null;
  embeds?: Array<{ description?: string | null; title?: string | null }> | null;
  attachments?: APIAttachment[] | null;
  stickers?: APIStickerItem[] | null;
  sticker_items?: APIStickerItem[] | null;
  author?: DiscordSnapshotAuthor | null;
};

export type DiscordMessageSnapshot = {
  message?: DiscordSnapshotMessage | null;
};

const FORWARD_MESSAGE_REFERENCE_TYPE = 1;

export function normalizeDiscordStickerItems(value: unknown): APIStickerItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is APIStickerItem =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as { id?: unknown }).id === "string" &&
      typeof (entry as { name?: unknown }).name === "string",
  );
}

export function resolveDiscordMessageStickers(message: Message): APIStickerItem[] {
  const stickers = (message as { stickers?: unknown }).stickers;
  const normalized = normalizeDiscordStickerItems(stickers);
  if (normalized.length > 0) {
    return normalized;
  }
  const rawData = (message as { rawData?: { sticker_items?: unknown; stickers?: unknown } })
    .rawData;
  return normalizeDiscordStickerItems(rawData?.sticker_items ?? rawData?.stickers);
}

export function resolveDiscordSnapshotStickers(snapshot: DiscordSnapshotMessage): APIStickerItem[] {
  return normalizeDiscordStickerItems(snapshot.stickers ?? snapshot.sticker_items);
}

export function hasDiscordMessageStickers(message: Message): boolean {
  return resolveDiscordMessageStickers(message).length > 0;
}

export function resolveDiscordMessageSnapshots(message: Message): DiscordMessageSnapshot[] {
  const rawData = (message as { rawData?: { message_snapshots?: unknown } }).rawData;
  return normalizeDiscordMessageSnapshots(
    rawData?.message_snapshots ??
      (message as { message_snapshots?: unknown }).message_snapshots ??
      (message as { messageSnapshots?: unknown }).messageSnapshots,
  );
}

export function normalizeDiscordMessageSnapshots(snapshots: unknown): DiscordMessageSnapshot[] {
  if (!Array.isArray(snapshots)) {
    return [];
  }
  return snapshots.filter(
    (entry): entry is DiscordMessageSnapshot => Boolean(entry) && typeof entry === "object",
  );
}

export function resolveDiscordReferencedForwardMessage(message: Message): Message | null {
  const referenceType = message.messageReference?.type;
  return Number(referenceType) === FORWARD_MESSAGE_REFERENCE_TYPE
    ? message.referencedMessage
    : null;
}

export function formatDiscordSnapshotAuthor(
  author: DiscordSnapshotAuthor | null | undefined,
): string | undefined {
  if (!author) {
    return undefined;
  }
  const globalName = normalizeOptionalString(author.global_name) ?? undefined;
  const username = normalizeOptionalString(author.username) ?? undefined;
  const name = normalizeOptionalString(author.name) ?? undefined;
  const discriminator = normalizeOptionalString(author.discriminator) ?? undefined;
  const base = globalName || username || name;
  if (username && discriminator && discriminator !== "0") {
    return `@${username}#${discriminator}`;
  }
  if (base) {
    return `@${base}`;
  }
  if (author.id) {
    return `@${author.id}`;
  }
  return undefined;
}
