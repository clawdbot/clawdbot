import { StickerFormatType, type APIAttachment, type APIStickerItem } from "discord-api-types/v10";
import { getFileExtension } from "openclaw/plugin-sdk/media-mime";
import {
  fetchRemoteMedia,
  saveMediaBuffer,
  type FetchLike,
} from "openclaw/plugin-sdk/media-runtime";
import { buildMediaPayload } from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Message } from "../internal/discord.js";
import {
  resolveDiscordMessageSnapshots,
  resolveDiscordMessageStickers,
  resolveDiscordReferencedForwardMessage,
  resolveDiscordSnapshotStickers,
} from "./message-forwarded.js";
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

const DISCORD_STICKER_ASSET_BASE_URL = "https://media.discordapp.net/stickers";

export type DiscordMediaInfo = {
  path: string;
  contentType?: string;
  placeholder: string;
};

export type DiscordMediaResolveOptions = {
  fetchImpl?: FetchLike;
  ssrfPolicy?: SsrFPolicy;
  readIdleTimeoutMs?: number;
  totalTimeoutMs?: number;
  abortSignal?: AbortSignal;
};

type DiscordStickerAssetCandidate = {
  url: string;
  fileName: string;
};

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
        attachment.filename,
      );
      params.out.push({
        path: saved.path,
        contentType: saved.contentType,
        placeholder: inferPlaceholder(attachment),
      });
    } catch (err) {
      const id = attachment.id ?? attachmentUrl;
      logVerbose(`${params.errorPrefix} ${id}: ${String(err)}`);
      params.out.push({
        path: attachmentUrl,
        contentType: attachment.content_type,
        placeholder: inferPlaceholder(attachment),
      });
    }
  }
}

function resolveStickerAssetCandidates(sticker: APIStickerItem): DiscordStickerAssetCandidate[] {
  const baseName = sticker.name?.trim() || `sticker-${sticker.id}`;
  switch (sticker.format_type) {
    case StickerFormatType.GIF:
      return [
        { url: `${DISCORD_STICKER_ASSET_BASE_URL}/${sticker.id}.gif`, fileName: `${baseName}.gif` },
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
        { url: `${DISCORD_STICKER_ASSET_BASE_URL}/${sticker.id}.png`, fileName: `${baseName}.png` },
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
          candidate.fileName,
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

export function buildDiscordMediaPlaceholder(params: {
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
