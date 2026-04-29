import type { ChannelType, Client, Message } from "@buape/carbon";
import { StickerFormatType, type APIAttachment, type APIStickerItem } from "discord-api-types/v10";
import { getFileExtension } from "openclaw/plugin-sdk/media-mime";
import { fetchRemoteMedia, type FetchLike } from "openclaw/plugin-sdk/media-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { buildMediaPayload } from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveDiscordChannelInfoSafe } from "./channel-access.js";
import { mergeAbortSignals } from "./timeouts.js";

const DISCORD_CDN_HOSTNAMES = [
  "cdn.discordapp.com",
  "media.discordapp.net",
  "*.discordapp.com",
  "*.discordapp.net",
];

// Allow Discord CDN downloads when VPN/proxy DNS resolves to RFC2544 benchmark ranges.
const DISCORD_MEDIA_SSRF_POLICY: SsrFPolicy = {
  hostnameAllowlist: DISCORD_CDN_HOSTNAMES,
  allowRfc2544BenchmarkRange: true,
};

const AUDIO_ATTACHMENT_EXTENSIONS = new Set([
  ".aac",
  ".caf",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
]);

function isDiscordAudioAttachmentFileName(fileName?: string | null): boolean {
  const ext = getFileExtension(fileName);
  return Boolean(ext && AUDIO_ATTACHMENT_EXTENSIONS.has(ext));
}

function hasDiscordVoiceAttachmentFields(attachment: APIAttachment): boolean {
  return typeof attachment.duration_secs === "number" || typeof attachment.waveform === "string";
}

function mergeHostnameList(...lists: Array<string[] | undefined>): string[] | undefined {
  const merged = lists
    .flatMap((list) => list ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (merged.length === 0) {
    return undefined;
  }
  return Array.from(new Set(merged));
}

function resolveDiscordMediaSsrFPolicy(policy?: SsrFPolicy): SsrFPolicy {
  if (!policy) {
    return DISCORD_MEDIA_SSRF_POLICY;
  }
  const hostnameAllowlist = mergeHostnameList(
    DISCORD_MEDIA_SSRF_POLICY.hostnameAllowlist,
    policy.hostnameAllowlist,
  );
  const allowedHostnames = mergeHostnameList(
    DISCORD_MEDIA_SSRF_POLICY.allowedHostnames,
    policy.allowedHostnames,
  );
  return {
    ...DISCORD_MEDIA_SSRF_POLICY,
    ...policy,
    ...(allowedHostnames ? { allowedHostnames } : {}),
    ...(hostnameAllowlist ? { hostnameAllowlist } : {}),
    allowRfc2544BenchmarkRange:
      Boolean(DISCORD_MEDIA_SSRF_POLICY.allowRfc2544BenchmarkRange) ||
      Boolean(policy.allowRfc2544BenchmarkRange),
  };
}

export type DiscordMediaInfo = {
  path: string;
  contentType?: string;
  placeholder: string;
};

type DiscordMediaResolveOptions = {
  fetchImpl?: FetchLike;
  ssrfPolicy?: SsrFPolicy;
  readIdleTimeoutMs?: number;
  totalTimeoutMs?: number;
  abortSignal?: AbortSignal;
};

export type DiscordChannelInfo = {
  type: ChannelType;
  name?: string;
  topic?: string;
  parentId?: string;
  ownerId?: string;
};

type DiscordMessageWithChannelId = Message & {
  channel_id?: unknown;
  rawData?: { channel_id?: unknown };
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
  stickers?: APIStickerItem[] | null;
  sticker_items?: APIStickerItem[] | null;
  author?: DiscordSnapshotAuthor | null;
};

const FORWARD_MESSAGE_REFERENCE_TYPE = 1;

type DiscordMessageSnapshot = {
  message?: DiscordSnapshotMessage | null;
};

const DISCORD_CHANNEL_INFO_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCORD_CHANNEL_INFO_NEGATIVE_CACHE_TTL_MS = 30 * 1000;
const DISCORD_CHANNEL_INFO_CACHE = new Map<
  string,
  { value: DiscordChannelInfo | null; expiresAt: number }
>();
const DISCORD_STICKER_ASSET_BASE_URL = "https://media.discordapp.net/stickers";

export function __resetDiscordChannelInfoCacheForTest() {
  DISCORD_CHANNEL_INFO_CACHE.clear();
}

function normalizeDiscordChannelId(value: unknown): string {
  return normalizeOptionalStringifiedId(value) ?? "";
}

export function resolveDiscordMessageChannelId(params: {
  message: Message;
  eventChannelId?: string | number | null;
}): string {
  const message = params.message as DiscordMessageWithChannelId;
  return (
    normalizeDiscordChannelId(message.channelId) ||
    normalizeDiscordChannelId(message.channel_id) ||
    normalizeDiscordChannelId(message.rawData?.channel_id) ||
    normalizeDiscordChannelId(params.eventChannelId)
  );
}

export async function resolveDiscordChannelInfo(
  client: Client,
  channelId: string,
): Promise<DiscordChannelInfo | null> {
  const cached = DISCORD_CHANNEL_INFO_CACHE.get(channelId);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return cached.value;
    }
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
    const channelInfo = resolveDiscordChannelInfoSafe(channel);
    const payload: DiscordChannelInfo = {
      type: (channelInfo.type as ChannelType | undefined) ?? channel.type,
      name: channelInfo.name,
      topic: channelInfo.topic,
      parentId: channelInfo.parentId,
      ownerId: channelInfo.ownerId,
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

function normalizeStickerItems(value: unknown): APIStickerItem[] {
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
  const normalized = normalizeStickerItems(stickers);
  if (normalized.length > 0) {
    return normalized;
  }
  const rawData = (message as { rawData?: { sticker_items?: unknown; stickers?: unknown } })
    .rawData;
  return normalizeStickerItems(rawData?.sticker_items ?? rawData?.stickers);
}

function resolveDiscordSnapshotStickers(snapshot: DiscordSnapshotMessage): APIStickerItem[] {
  return normalizeStickerItems(snapshot.stickers ?? snapshot.sticker_items);
}

export function hasDiscordMessageStickers(message: Message): boolean {
  return resolveDiscordMessageStickers(message).length > 0;
}

export async function resolveMediaList(
  message: Message,
  maxBytes: number,
  options?: DiscordMediaResolveOptions,
): Promise<DiscordMediaInfo[]> {
  const out: DiscordMediaInfo[] = [];
  const resolvedSsrFPolicy = resolveDiscordMediaSsrFPolicy(options?.ssrfPolicy);
  await appendResolvedMediaFromAttachments({
    attachments: message.attachments ?? [],
    maxBytes,
    out,
    errorPrefix: "discord: failed to download attachment",
    fetchImpl: options?.fetchImpl,
    ssrfPolicy: resolvedSsrFPolicy,
    readIdleTimeoutMs: options?.readIdleTimeoutMs,
    totalTimeoutMs: options?.totalTimeoutMs,
    abortSignal: options?.abortSignal,
  });
  await appendResolvedMediaFromStickers({
    stickers: resolveDiscordMessageStickers(message),
    maxBytes,
    out,
    errorPrefix: "discord: failed to download sticker",
    fetchImpl: options?.fetchImpl,
    ssrfPolicy: resolvedSsrFPolicy,
    readIdleTimeoutMs: options?.readIdleTimeoutMs,
    totalTimeoutMs: options?.totalTimeoutMs,
    abortSignal: options?.abortSignal,
  });
  return out;
}

export async function resolveForwardedMediaList(
  message: Message,
  maxBytes: number,
  options?: DiscordMediaResolveOptions,
): Promise<DiscordMediaInfo[]> {
  const snapshots = resolveDiscordMessageSnapshots(message);
  const out: DiscordMediaInfo[] = [];
  const resolvedSsrFPolicy = resolveDiscordMediaSsrFPolicy(options?.ssrfPolicy);
  if (snapshots.length > 0) {
    for (const snapshot of snapshots) {
      await appendResolvedMediaFromAttachments({
        attachments: snapshot.message?.attachments,
        maxBytes,
        out,
        errorPrefix: "discord: failed to download forwarded attachment",
        fetchImpl: options?.fetchImpl,
        ssrfPolicy: resolvedSsrFPolicy,
        readIdleTimeoutMs: options?.readIdleTimeoutMs,
        totalTimeoutMs: options?.totalTimeoutMs,
        abortSignal: options?.abortSignal,
      });
      await appendResolvedMediaFromStickers({
        stickers: snapshot.message ? resolveDiscordSnapshotStickers(snapshot.message) : [],
        maxBytes,
        out,
        errorPrefix: "discord: failed to download forwarded sticker",
        fetchImpl: options?.fetchImpl,
        ssrfPolicy: resolvedSsrFPolicy,
        readIdleTimeoutMs: options?.readIdleTimeoutMs,
        totalTimeoutMs: options?.totalTimeoutMs,
        abortSignal: options?.abortSignal,
      });
    }
    return out;
  }
  const referencedForward = resolveDiscordReferencedForwardMessage(message);
  if (!referencedForward) {
    return out;
  }
  await appendResolvedMediaFromAttachments({
    attachments: referencedForward.attachments,
    maxBytes,
    out,
    errorPrefix: "discord: failed to download forwarded attachment",
    fetchImpl: options?.fetchImpl,
    ssrfPolicy: resolvedSsrFPolicy,
    readIdleTimeoutMs: options?.readIdleTimeoutMs,
    totalTimeoutMs: options?.totalTimeoutMs,
    abortSignal: options?.abortSignal,
  });
  await appendResolvedMediaFromStickers({
    stickers: resolveDiscordMessageStickers(referencedForward),
    maxBytes,
    out,
    errorPrefix: "discord: failed to download forwarded sticker",
    fetchImpl: options?.fetchImpl,
    ssrfPolicy: resolvedSsrFPolicy,
    readIdleTimeoutMs: options?.readIdleTimeoutMs,
    totalTimeoutMs: options?.totalTimeoutMs,
    abortSignal: options?.abortSignal,
  });
  return out;
}

async function fetchDiscordMedia(params: {
  url: string;
  filePathHint: string;
  maxBytes: number;
  fetchImpl?: FetchLike;
  ssrfPolicy?: SsrFPolicy;
  readIdleTimeoutMs?: number;
  totalTimeoutMs?: number;
  abortSignal?: AbortSignal;
}) {
  // `totalTimeoutMs` is enforced per individual attachment or sticker fetch.
  // The caller abort signal remains the outer bound for the message.
  const timeoutAbortController = params.totalTimeoutMs ? new AbortController() : undefined;
  const signal = mergeAbortSignals([params.abortSignal, timeoutAbortController?.signal]);
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const fetchPromise = fetchRemoteMedia({
    url: params.url,
    filePathHint: params.filePathHint,
    maxBytes: params.maxBytes,
    fetchImpl: params.fetchImpl,
    ssrfPolicy: params.ssrfPolicy,
    readIdleTimeoutMs: params.readIdleTimeoutMs,
    ...(signal ? { requestInit: { signal } } : {}),
  }).catch((error) => {
    if (timedOut) {
      // After the timeout wins the race we abort the underlying fetch and keep
      // this branch pending so the later AbortError does not surface as an
      // unhandled rejection after Promise.race has already settled.
      return new Promise<never>(() => {});
    }
    throw error;
  });

  try {
    if (!params.totalTimeoutMs) {
      return await fetchPromise;
    }
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        timeoutAbortController?.abort();
        reject(new Error(`discord media download timed out after ${params.totalTimeoutMs}ms`));
      }, params.totalTimeoutMs);
      timeoutHandle.unref?.();
    });
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function appendResolvedMediaFromAttachments(params: {
  attachments?: APIAttachment[] | null;
  maxBytes: number;
  out: DiscordMediaInfo[];
  errorPrefix: string;
  fetchImpl?: FetchLike;
  ssrfPolicy?: SsrFPolicy;
  readIdleTimeoutMs?: number;
  totalTimeoutMs?: number;
  abortSignal?: AbortSignal;
}) {
  const attachments = params.attachments;
  if (!attachments || attachments.length === 0) {
    return;
  }
  for (const attachment of attachments) {
    const attachmentUrl = normalizeOptionalString(attachment.url);
    if (!attachmentUrl) {
      logVerbose(
        `${params.errorPrefix} ${attachment.id ?? attachment.filename ?? "attachment"}: missing url`,
      );
      continue;
    }
    try {
      const fetched = await fetchDiscordMedia({
        url: attachmentUrl,
        filePathHint: attachment.filename ?? attachmentUrl,
        maxBytes: params.maxBytes,
        fetchImpl: params.fetchImpl,
        ssrfPolicy: params.ssrfPolicy,
        readIdleTimeoutMs: params.readIdleTimeoutMs,
        totalTimeoutMs: params.totalTimeoutMs,
        abortSignal: params.abortSignal,
      });
      const saved = await saveMediaBuffer(
        fetched.buffer,
        fetched.contentType ?? attachment.content_type,
        "inbound",
        params.maxBytes,
      );
      params.out.push({
        path: saved.path,
        contentType: saved.contentType,
        placeholder: inferPlaceholder(attachment),
      });
    } catch (err) {
      const id = attachment.id ?? attachmentUrl;
      logVerbose(`${params.errorPrefix} ${id}: ${String(err)}`);
      // Preserve attachment context even when remote fetch is blocked/fails.
      params.out.push({
        path: attachmentUrl,
        contentType: attachment.content_type,
        placeholder: inferPlaceholder(attachment),
      });
    }
  }
}

type DiscordStickerAssetCandidate = {
  url: string;
  fileName: string;
};

function resolveStickerAssetCandidates(sticker: APIStickerItem): DiscordStickerAssetCandidate[] {
  const baseName = sticker.name?.trim() || `sticker-${sticker.id}`;
  switch (sticker.format_type) {
    case StickerFormatType.GIF:
      return [
        {
          url: `${DISCORD_STICKER_ASSET_BASE_URL}/${sticker.id}.gif`,
          fileName: `${baseName}.gif`,
        },
      ];
    case StickerFormatType.Lottie:
      return [
        {
          url: `${DISCORD_STICKER_ASSET_BASE_URL}/${sticker.id}.png?size=160`,
          fileName: `${baseName}.png`,
        },
        {
          url: `${DISCORD_STICKER_ASSET_BASE_URL}/${sticker.id}.json`,
          fileName: `${baseName}.json`,
        },
      ];
    case StickerFormatType.APNG:
    case StickerFormatType.PNG:
    default:
      return [
        {
          url: `${DISCORD_STICKER_ASSET_BASE_URL}/${sticker.id}.png`,
          fileName: `${baseName}.png`,
        },
      ];
  }
}

function formatStickerError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

function inferStickerContentType(sticker: APIStickerItem): string | undefined {
  switch (sticker.format_type) {
    case StickerFormatType.GIF:
      return "image/gif";
    case StickerFormatType.APNG:
    case StickerFormatType.Lottie:
    case StickerFormatType.PNG:
      return "image/png";
    default:
      return undefined;
  }
}

async function appendResolvedMediaFromStickers(params: {
  stickers?: APIStickerItem[] | null;
  maxBytes: number;
  out: DiscordMediaInfo[];
  errorPrefix: string;
  fetchImpl?: FetchLike;
  ssrfPolicy?: SsrFPolicy;
  readIdleTimeoutMs?: number;
  totalTimeoutMs?: number;
  abortSignal?: AbortSignal;
}) {
  const stickers = params.stickers;
  if (!stickers || stickers.length === 0) {
    return;
  }
  for (const sticker of stickers) {
    const candidates = resolveStickerAssetCandidates(sticker);
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        const fetched = await fetchDiscordMedia({
          url: candidate.url,
          filePathHint: candidate.fileName,
          maxBytes: params.maxBytes,
          fetchImpl: params.fetchImpl,
          ssrfPolicy: params.ssrfPolicy,
          readIdleTimeoutMs: params.readIdleTimeoutMs,
          totalTimeoutMs: params.totalTimeoutMs,
          abortSignal: params.abortSignal,
        });
        const saved = await saveMediaBuffer(
          fetched.buffer,
          fetched.contentType,
          "inbound",
          params.maxBytes,
        );
        params.out.push({
          path: saved.path,
          contentType: saved.contentType,
          placeholder: "<media:sticker>",
        });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) {
      logVerbose(`${params.errorPrefix} ${sticker.id}: ${formatStickerError(lastError)}`);
      const fallback = candidates[0];
      if (fallback) {
        params.out.push({
          path: fallback.url,
          contentType: inferStickerContentType(sticker),
          placeholder: "<media:sticker>",
        });
      }
    }
  }
}

function inferPlaceholder(attachment: APIAttachment): string {
  const mime = attachment.content_type ?? "";
  if (mime.startsWith("image/")) {
    return "<media:image>";
  }
  if (mime.startsWith("video/")) {
    return "<media:video>";
  }
  if (mime.startsWith("audio/")) {
    return "<media:audio>";
  }
  if (hasDiscordVoiceAttachmentFields(attachment)) {
    return "<media:audio>";
  }
  if (isDiscordAudioAttachmentFileName(attachment.filename ?? attachment.url)) {
    return "<media:audio>";
  }
  return "<media:document>";
}

function isImageAttachment(attachment: APIAttachment): boolean {
  const mime = attachment.content_type ?? "";
  if (mime.startsWith("image/")) {
    return true;
  }
  const name = normalizeLowercaseStringOrEmpty(attachment.filename);
  if (!name) {
    return false;
  }
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/.test(name);
}

function buildDiscordAttachmentPlaceholder(attachments?: APIAttachment[]): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }
  const count = attachments.length;
  const allImages = attachments.every(isImageAttachment);
  const label = allImages ? "image" : "file";
  const suffix = count === 1 ? label : `${label}s`;
  const tag = allImages ? "<media:image>" : "<media:document>";
  return `${tag} (${count} ${suffix})`;
}

function buildDiscordStickerPlaceholder(stickers?: APIStickerItem[]): string {
  if (!stickers || stickers.length === 0) {
    return "";
  }
  const count = stickers.length;
  const label = count === 1 ? "sticker" : "stickers";
  return `<media:sticker> (${count} ${label})`;
}

function buildDiscordMediaPlaceholder(params: {
  attachments?: APIAttachment[];
  stickers?: APIStickerItem[];
}): string {
  const attachmentText = buildDiscordAttachmentPlaceholder(params.attachments);
  const stickerText = buildDiscordStickerPlaceholder(params.stickers);
  if (attachmentText && stickerText) {
    return `${attachmentText}\n${stickerText}`;
  }
  return attachmentText || stickerText || "";
}

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

function resolveDiscordMessageSnapshots(message: Message): DiscordMessageSnapshot[] {
  const rawData = (message as { rawData?: { message_snapshots?: unknown } }).rawData;
  return normalizeDiscordMessageSnapshots(
    rawData?.message_snapshots ??
      (message as { message_snapshots?: unknown }).message_snapshots ??
      (message as { messageSnapshots?: unknown }).messageSnapshots,
  );
}

function normalizeDiscordMessageSnapshots(snapshots: unknown): DiscordMessageSnapshot[] {
  if (!Array.isArray(snapshots)) {
    return [];
  }
  return snapshots.filter(
    (entry): entry is DiscordMessageSnapshot => Boolean(entry) && typeof entry === "object",
  );
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

function resolveDiscordReferencedForwardMessage(message: Message): Message | null {
  const referenceType = message.messageReference?.type;
  return Number(referenceType) === FORWARD_MESSAGE_REFERENCE_TYPE
    ? message.referencedMessage
    : null;
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

function formatDiscordSnapshotAuthor(
  author: DiscordSnapshotAuthor | null | undefined,
): string | undefined {
  if (!author) {
    return undefined;
  }
  const globalName = author.global_name ?? undefined;
  const username = author.username ?? undefined;
  const name = author.name ?? undefined;
  const discriminator = author.discriminator ?? undefined;
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
  return buildMediaPayload(mediaList);
}
