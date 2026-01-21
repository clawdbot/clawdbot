import type { ChannelType, Client, Message } from "@buape/carbon";
import type { APIAttachment } from "discord-api-types/v10";

import { logVerbose } from "../../globals.js";
import { fetchRemoteMedia } from "../../media/fetch.js";
import { saveMediaBuffer } from "../../media/store.js";

export type DiscordMediaInfo = {
  path: string;
  contentType?: string;
  placeholder: string;
};

export type DiscordChannelInfo = {
  type: ChannelType;
  name?: string;
  topic?: string;
  parentId?: string;
  ownerId?: string;
};

type DiscordSnapshotAuthor = {
  id?: string | null;
  username?: string | null;
  discriminator?: string | null;
  global_name?: string | null;
  name?: string | null;
};

type DiscordSnapshotMessage = {
  content?: string | null;
  embeds?: Array<{ description?: string | null; title?: string | null }> | null;
  attachments?: APIAttachment[] | null;
  author?: DiscordSnapshotAuthor | null;
};

type DiscordMessageSnapshot = {
  message?: DiscordSnapshotMessage | null;
};

const DISCORD_CHANNEL_INFO_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS = 30 * 1000;
const DISCORD_CHANNEL_INFO_CACHE = new Map<
  string,
  { value: DiscordChannelInfo | null; expiresAt: number }
>();

export function __resetDiscordChannelInfoCacheForTest() {
  DISCORD_CHANNEL_INFO_CACHE.clear();
}

export async function resolveDiscordChannelInfo(
  client: Client,
  channelId: string,
): Promise<DiscordChannelInfo | null> {
  const cached = DISCORD_CHANNEL_INFO_CACHE.get(channelId);
  if (cached) {
    if (cached.expiresAt > Date.now()) return cached.value;
    DISCORD_CHANNEL_INFO_CACHE.delete(channelId);
  }
  try {
    const channel = await client.fetchChannel(channelId);
    if (!channel) {
      DISCORD_CHANNEL_INFO_CACHE.set(channelId, {
        value: null,
        expiresAt: Date.now() + DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS,
      });
      return null;
    }
    const name = "name" in channel ? (channel.name ?? undefined) : undefined;
    const topic = "topic" in channel ? (channel.topic ?? undefined) : undefined;
    const parentId = "parentId" in channel ? (channel.parentId ?? undefined) : undefined;
    const ownerId = "ownerId" in channel ? (channel.ownerId ?? undefined) : undefined;
    const payload: DiscordChannelInfo = {
      type: channel.type,
      name,
      topic,
      parentId,
      ownerId,
    };
    DISCORD_CHANNEL_INFO_CACHE.set(channelId, {
      value: payload,
      expiresAt: Date.now() + DISCORD_CHANNEL_INFO_CACHE_TTL_MS,
    });
    return payload;
  } catch (err) {
    logVerbose(`discord: failed to fetch channel ${channelId}: ${String(err)}`);
    DISCORD_CHANNEL_INFO_CACHE.set(channelId, {
      value: null,
      expiresAt: Date.now() + DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS,
    });
    return null;
  }
}

export async function resolveMediaList(
  message: Message,
  maxBytes: number,
): Promise<DiscordMediaInfo[]> {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return [];
  const out: DiscordMediaInfo[] = [];
  for (const attachment of attachments) {
    try {
      const fetched = await fetchRemoteMedia({
        url: attachment.url,
        filePathHint: attachment.filename ?? attachment.url,
      });
      const saved = await saveMediaBuffer(
        fetched.buffer,
        fetched.contentType ?? attachment.content_type,
        "inbound",
        maxBytes,
      );
      out.push({
        path: saved.path,
        contentType: saved.contentType,
        placeholder: inferPlaceholder(attachment),
      });
    } catch (err) {
      const id = attachment.id ?? attachment.url;
      logVerbose(`discord: failed to download attachment ${id}: ${String(err)}`);
    }
  }
  return out;
}

function inferPlaceholder(attachment: APIAttachment): string {
  const mime = attachment.content_type ?? "";
  if (mime.startsWith("image/")) return "<media:image>";
  if (mime.startsWith("video/")) return "<media:video>";
  if (mime.startsWith("audio/")) return "<media:audio>";
  return "<media:document>";
}

function isImageAttachment(attachment: APIAttachment): boolean {
  const mime = attachment.content_type ?? "";
  if (mime.startsWith("image/")) return true;
  const name = attachment.filename?.toLowerCase() ?? "";
  if (!name) return false;
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/.test(name);
}

function buildDiscordAttachmentPlaceholder(attachments?: APIAttachment[]): string {
  if (!attachments || attachments.length === 0) return "";
  const count = attachments.length;
  const allImages = attachments.every(isImageAttachment);
  const label = allImages ? "image" : "file";
  const suffix = count === 1 ? label : `${label}s`;
  const tag = allImages ? "<media:image>" : "<media:document>";
  return `${tag} (${count} ${suffix})`;
}

export function resolveDiscordMessageText(
  message: Message,
  options?: { fallbackText?: string; includeForwarded?: boolean },
): string {
  const baseText =
    message.content?.trim() ||
    buildDiscordAttachmentPlaceholder(message.attachments) ||
    message.embeds?.[0]?.description ||
    options?.fallbackText?.trim() ||
    "";
  if (!options?.includeForwarded) return baseText;
  const forwardedText = resolveDiscordForwardedMessagesText(message);
  if (!forwardedText) return baseText;
  if (!baseText) return forwardedText;
  return `${baseText}\n${forwardedText}`;
}

function resolveDiscordForwardedMessagesText(message: Message): string {
  const snapshots = resolveDiscordMessageSnapshots(message);
  if (snapshots.length === 0) return "";
  const forwardedBlocks = snapshots
    .map((snapshot) => {
      const snapshotMessage = snapshot.message;
      if (!snapshotMessage) return null;
      const text = resolveDiscordSnapshotMessageText(snapshotMessage);
      if (!text) return null;
      const authorLabel = formatDiscordSnapshotAuthor(snapshotMessage.author);
      const heading = authorLabel
        ? `[Forwarded message from ${authorLabel}]`
        : "[Forwarded message]";
      return `${heading}\n${text}`;
    })
    .filter((entry): entry is string => Boolean(entry));
  if (forwardedBlocks.length === 0) return "";
  return forwardedBlocks.join("\n\n");
}

function resolveDiscordMessageSnapshots(message: Message): DiscordMessageSnapshot[] {
  const rawData = (message as { rawData?: { message_snapshots?: unknown } }).rawData;
  const snapshots =
    rawData?.message_snapshots ??
    (message as { message_snapshots?: unknown }).message_snapshots ??
    (message as { messageSnapshots?: unknown }).messageSnapshots;
  if (!Array.isArray(snapshots)) return [];
  return snapshots.filter(
    (entry): entry is DiscordMessageSnapshot => Boolean(entry) && typeof entry === "object",
  );
}

function resolveDiscordSnapshotMessageText(snapshot: DiscordSnapshotMessage): string {
  const content = snapshot.content?.trim() ?? "";
  const attachmentText = buildDiscordAttachmentPlaceholder(snapshot.attachments ?? undefined);
  const embed = snapshot.embeds?.[0];
  const embedText = embed?.description?.trim() || embed?.title?.trim() || "";
  return content || attachmentText || embedText || "";
}

function formatDiscordSnapshotAuthor(
  author: DiscordSnapshotAuthor | null | undefined,
): string | undefined {
  if (!author) return undefined;
  const globalName = author.global_name ?? undefined;
  const username = author.username ?? undefined;
  const name = author.name ?? undefined;
  const discriminator = author.discriminator ?? undefined;
  const base = globalName || username || name;
  if (username && discriminator && discriminator !== "0") {
    return `@${username}#${discriminator}`;
  }
  if (base) return `@${base}`;
  if (author.id) return `@${author.id}`;
  return undefined;
}

export function buildDiscordMediaPayload(
  mediaList: Array<{ path: string; contentType?: string }>,
): {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
} {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const mediaTypes = mediaList.map((media) => media.contentType).filter(Boolean) as string[];
  return {
    MediaPath: first?.path,
    MediaType: first?.contentType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}
