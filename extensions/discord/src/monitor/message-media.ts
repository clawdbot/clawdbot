// Discord plugin module implements message media behavior.
import { StickerFormatType, type APIAttachment, type APIStickerItem } from "discord-api-types/v10";
import {
  formatMediaPlaceholderText,
  type MediaPlaceholderTextFact,
} from "openclaw/plugin-sdk/channel-inbound";
import { getFileExtension, normalizeMimeType } from "openclaw/plugin-sdk/media-mime";
import { saveRemoteMedia, type FetchLike } from "openclaw/plugin-sdk/media-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Message } from "../internal/discord.js";
import {
  resolveDiscordMessageSnapshots,
  resolveDiscordMessageStickers,
  resolveDiscordReferencedForwardMessage,
  resolveDiscordReferencedReplyMessage,
  resolveDiscordSnapshotStickers,
} from "./message-forwarded.js";

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

export type DiscordMediaInfo = Pick<MediaPlaceholderTextFact, "contentType" | "kind" | "path">;

type DiscordMediaResolveOptions = {
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

const NON_DEFINITIVE_MEDIA_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  // Discord can report this container type without identifying whether it holds audio or video.
  "application/ogg",
]);

function isDefinitiveMediaType(contentType: string | null | undefined): boolean {
  const normalized = normalizeMimeType(contentType);
  return Boolean(normalized && !NON_DEFINITIVE_MEDIA_TYPES.has(normalized));
}

function resolveEffectiveMediaType(params: {
  declaredContentType?: string | null;
  fetchedContentType?: string | null;
}): string | undefined {
  if (isDefinitiveMediaType(params.fetchedContentType)) {
    return params.fetchedContentType ?? undefined;
  }
  if (isDefinitiveMediaType(params.declaredContentType)) {
    return params.declaredContentType ?? undefined;
  }
  return params.fetchedContentType ?? params.declaredContentType ?? undefined;
}

function resolveDiscordMediaClassification(params: {
  attachment: APIAttachment;
  fetchedContentType?: string | null;
}): Pick<DiscordMediaInfo, "contentType" | "kind"> {
  const contentType = resolveEffectiveMediaType({
    declaredContentType: params.attachment.content_type,
    fetchedContentType: params.fetchedContentType,
  });
  const mime = normalizeMimeType(contentType);
  const audioKind =
    mime?.startsWith("audio/") ||
    hasDiscordVoiceAttachmentFields(params.attachment) ||
    (isDiscordAudioAttachmentFileName(params.attachment.filename ?? params.attachment.url) &&
      !isDefinitiveMediaType(contentType))
      ? "audio"
      : undefined;
  const kind =
    audioKind ??
    (!isDefinitiveMediaType(contentType)
      ? isImageAttachment(params.attachment)
        ? "image"
        : "document"
      : undefined);

  return {
    // Inbound projection prefers MIME over kind. A native voice classification
    // or filename fallback must replace a non-definitive MIME rather than be masked by it.
    contentType:
      (audioKind && !mime?.startsWith("audio/")) || (kind && !isDefinitiveMediaType(contentType))
        ? undefined
        : contentType,
    ...(kind ? { kind } : {}),
  };
}

function mergeHostnameList(...lists: Array<string[] | undefined>): string[] | undefined {
  const merged = lists
    .flatMap((list) => list ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (merged.length === 0) {
    return undefined;
  }
  return uniqueStrings(merged);
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

export async function resolveReferencedReplyMediaList(
  message: Message,
  maxBytes: number,
  options?: DiscordMediaResolveOptions,
): Promise<DiscordMediaInfo[]> {
  const referencedReply = resolveDiscordReferencedReplyMessage(message);
  const out: DiscordMediaInfo[] = [];
  if (!referencedReply) {
    return out;
  }
  const resolvedSsrFPolicy = resolveDiscordMediaSsrFPolicy(options?.ssrfPolicy);
  await appendResolvedMediaFromAttachments({
    attachments: referencedReply.attachments,
    maxBytes,
    out,
    errorPrefix: "discord: failed to download referenced reply attachment",
    fetchImpl: options?.fetchImpl,
    ssrfPolicy: resolvedSsrFPolicy,
    readIdleTimeoutMs: options?.readIdleTimeoutMs,
    totalTimeoutMs: options?.totalTimeoutMs,
    abortSignal: options?.abortSignal,
  });
  await appendResolvedMediaFromStickers({
    stickers: resolveDiscordMessageStickers(referencedReply),
    maxBytes,
    out,
    errorPrefix: "discord: failed to download referenced reply sticker",
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
  fallbackContentType?: string;
  originalFilename?: string;
}) {
  const timeoutAbortController = params.totalTimeoutMs ? new AbortController() : undefined;
  const signal =
    params.abortSignal && timeoutAbortController
      ? AbortSignal.any([params.abortSignal, timeoutAbortController.signal])
      : (params.abortSignal ?? timeoutAbortController?.signal);
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const savePromise = saveRemoteMedia({
    url: params.url,
    filePathHint: params.filePathHint,
    maxBytes: params.maxBytes,
    fetchImpl: params.fetchImpl,
    ssrfPolicy: params.ssrfPolicy,
    readIdleTimeoutMs: params.readIdleTimeoutMs,
    fallbackContentType: params.fallbackContentType,
    originalFilename: params.originalFilename,
    ...(signal ? { requestInit: { signal } } : {}),
  }).catch((error: unknown) => {
    if (timedOut) {
      return new Promise<never>(() => {});
    }
    throw error;
  });
  try {
    if (!params.totalTimeoutMs) {
      return await savePromise;
    }
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        timeoutAbortController?.abort();
        reject(new Error(`discord media download timed out after ${params.totalTimeoutMs}ms`));
      }, params.totalTimeoutMs);
      timeoutHandle.unref?.();
    });
    return await Promise.race([savePromise, timeoutPromise]);
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
      params.out.push(resolveDiscordMediaClassification({ attachment }));
      continue;
    }
    try {
      const saved = await fetchDiscordMedia({
        url: attachmentUrl,
        filePathHint: attachment.filename ?? attachmentUrl,
        maxBytes: params.maxBytes,
        fetchImpl: params.fetchImpl,
        ssrfPolicy: params.ssrfPolicy,
        readIdleTimeoutMs: params.readIdleTimeoutMs,
        totalTimeoutMs: params.totalTimeoutMs,
        abortSignal: params.abortSignal,
        fallbackContentType: attachment.content_type,
        originalFilename: attachment.filename,
      });
      const classification = resolveDiscordMediaClassification({
        attachment,
        fetchedContentType: saved.contentType,
      });
      params.out.push({
        path: saved.path,
        ...classification,
      });
    } catch (err) {
      const id = attachment.id ?? attachmentUrl;
      logVerbose(`${params.errorPrefix} ${id}: ${String(err)}`);
      const classification = resolveDiscordMediaClassification({ attachment });
      params.out.push({
        ...classification,
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
        const saved = await fetchDiscordMedia({
          url: candidate.url,
          filePathHint: candidate.fileName,
          maxBytes: params.maxBytes,
          fetchImpl: params.fetchImpl,
          ssrfPolicy: params.ssrfPolicy,
          readIdleTimeoutMs: params.readIdleTimeoutMs,
          totalTimeoutMs: params.totalTimeoutMs,
          abortSignal: params.abortSignal,
          fallbackContentType: inferStickerContentType(sticker),
          originalFilename: candidate.fileName,
        });
        params.out.push({
          path: saved.path,
          contentType: saved.contentType,
          kind: "sticker",
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
          contentType: inferStickerContentType(sticker),
          kind: "sticker",
        });
      }
    }
  }
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

function resolveDiscordTextMediaFacts(params: {
  attachments?: APIAttachment[];
  stickers?: APIStickerItem[];
}): MediaPlaceholderTextFact[] {
  return [
    ...(params.attachments ?? []).map((attachment) => {
      const classification = resolveDiscordMediaClassification({ attachment });
      return classification;
    }),
    ...(params.stickers ?? []).map(() => ({ kind: "sticker" as const })),
  ];
}

/** Renders native Discord media only for transcript surfaces that cannot carry facts. */
export function formatDiscordMediaText(params: {
  attachments?: APIAttachment[];
  stickers?: APIStickerItem[];
}): string {
  return formatMediaPlaceholderText(resolveDiscordTextMediaFacts(params));
}
