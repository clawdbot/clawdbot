import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import { t } from "../../../i18n/index.ts";
import type { MessageContentItem } from "../../../lib/chat/chat-types.ts";
import { getMediaFileExtension } from "../../../lib/media-file-extension.ts";

export type PairingQrExpiryNotice = {
  title: string;
  reason: string;
};
type PairingQrExpiryRefreshTimer = {
  expiresAtMs: number;
  onRequestUpdate: () => void;
  timer: ReturnType<typeof setTimeout>;
};
const pairingQrExpiryRefreshTimers = new Map<string, PairingQrExpiryRefreshTimer>();

export type ImageBlock = {
  url: string;
  openUrl?: string;
  alt?: string;
  width?: number;
  height?: number;
};

export type ImageRenderOptions = {
  localMediaPreviewRoots?: readonly string[];
  basePath?: string;
  authToken?: string | null;
  onRequestUpdate?: () => void;
  onRequestOpenImage?: () => number;
  onOpenImage?: (item: ImageLightboxItem, requestVersion?: number) => void;
};

export type RenderableImageBlock = ImageBlock & {
  displayUrl: string;
};

export type AttachmentItem = Extract<MessageContentItem, { type: "attachment" }>;

const managedImageBlobUrlResolvedCache = new Map<string, string>();
const managedImageBlobUrlMissCache = new Map<string, number>();
const managedImageBlobUrlRetainCounts = new Map<string, number>();
const MANAGED_IMAGE_BLOB_URL_CACHE_MAX_ENTRIES = 64;
const MANAGED_IMAGE_BLOB_URL_MISS_RETRY_MS = 5_000;

export function readManagedImageBlobUrl(cacheKey: string): string | undefined {
  const cached = managedImageBlobUrlResolvedCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  managedImageBlobUrlResolvedCache.delete(cacheKey);
  managedImageBlobUrlResolvedCache.set(cacheKey, cached);
  return cached;
}

function trimManagedImageBlobUrlCache() {
  while (managedImageBlobUrlResolvedCache.size > MANAGED_IMAGE_BLOB_URL_CACHE_MAX_ENTRIES) {
    const evictable = [...managedImageBlobUrlResolvedCache.keys()].find(
      (cacheKey) => (managedImageBlobUrlRetainCounts.get(cacheKey) ?? 0) === 0,
    );
    if (!evictable) {
      return;
    }
    const evicted = managedImageBlobUrlResolvedCache.get(evictable);
    managedImageBlobUrlResolvedCache.delete(evictable);
    if (evicted) {
      URL.revokeObjectURL(evicted);
    }
  }
}

export function retainManagedImageBlobUrl(cacheKey: string): (() => void) | undefined {
  if (!managedImageBlobUrlResolvedCache.has(cacheKey)) {
    return undefined;
  }
  managedImageBlobUrlRetainCounts.set(
    cacheKey,
    (managedImageBlobUrlRetainCounts.get(cacheKey) ?? 0) + 1,
  );
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const remaining = (managedImageBlobUrlRetainCounts.get(cacheKey) ?? 1) - 1;
    if (remaining <= 0) {
      managedImageBlobUrlRetainCounts.delete(cacheKey);
    } else {
      managedImageBlobUrlRetainCounts.set(cacheKey, remaining);
    }
    trimManagedImageBlobUrlCache();
  };
}

export function cacheManagedImageBlobUrl(cacheKey: string, blobUrl: string) {
  const previous = managedImageBlobUrlResolvedCache.get(cacheKey);
  managedImageBlobUrlResolvedCache.delete(cacheKey);
  managedImageBlobUrlResolvedCache.set(cacheKey, blobUrl);
  managedImageBlobUrlMissCache.delete(cacheKey);
  if (previous && previous !== blobUrl) {
    URL.revokeObjectURL(previous);
  }

  // Blob URLs retain browser-managed image data. Keep recent previews reusable,
  // but protect an image while its lightbox still uses that object URL.
  trimManagedImageBlobUrlCache();
}

export function hasRecentManagedImageBlobUrlMiss(cacheKey: string): boolean {
  const missAt = managedImageBlobUrlMissCache.get(cacheKey);
  if (missAt === undefined) {
    return false;
  }
  if (Date.now() - missAt >= MANAGED_IMAGE_BLOB_URL_MISS_RETRY_MS) {
    managedImageBlobUrlMissCache.delete(cacheKey);
    return false;
  }
  managedImageBlobUrlMissCache.delete(cacheKey);
  managedImageBlobUrlMissCache.set(cacheKey, missAt);
  return true;
}

export function cacheManagedImageBlobUrlMiss(cacheKey: string) {
  managedImageBlobUrlMissCache.delete(cacheKey);
  managedImageBlobUrlMissCache.set(cacheKey, Date.now());
  while (managedImageBlobUrlMissCache.size > MANAGED_IMAGE_BLOB_URL_CACHE_MAX_ENTRIES) {
    const oldest = managedImageBlobUrlMissCache.keys().next();
    if (oldest.done) {
      break;
    }
    managedImageBlobUrlMissCache.delete(oldest.value);
  }
}

function appendImageBlock(images: ImageBlock[], block: ImageBlock) {
  if (!images.some((entry) => entry.url === block.url && entry.alt === block.alt)) {
    images.push(block);
  }
}

function buildBase64ImageUrl(params: { data: string; mediaType?: string }): string {
  return params.data.startsWith("data:")
    ? params.data
    : `data:${params.mediaType ?? "image/png"};base64,${params.data}`;
}

function isImageTranscriptMediaPath(path: string, mediaType: unknown): boolean {
  if (typeof mediaType === "string" && mediaType.trim()) {
    const normalized = mediaType.trim().toLowerCase();
    if (normalized.startsWith("image/")) {
      return true;
    }
    if (normalized !== "application/octet-stream") {
      return false;
    }
  }
  const ext = getMediaFileExtension(path);
  return (
    ext !== undefined &&
    ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "heif", "avif"].includes(ext)
  );
}

function isAudioTranscriptMediaPath(path: string, mediaType: unknown): boolean {
  if (typeof mediaType === "string" && mediaType.trim().toLowerCase().startsWith("audio/")) {
    return true;
  }
  const ext = getMediaFileExtension(path);
  return (
    ext !== undefined &&
    ["aac", "flac", "m2a", "m4a", "mp3", "oga", "ogg", "opus", "wav"].includes(ext)
  );
}

function isVideoTranscriptMediaPath(path: string, mediaType: unknown): boolean {
  if (typeof mediaType === "string" && mediaType.trim().toLowerCase().startsWith("video/")) {
    return true;
  }
  const ext = getMediaFileExtension(path);
  return ext !== undefined && ["m4v", "mov", "mp4", "webm"].includes(ext);
}

function labelForMediaPath(mediaPath: string): string {
  const trimmed = mediaPath.trim();
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const parsed = new URL(trimmed);
      return parsed.pathname.split("/").pop()?.trim() || parsed.hostname || trimmed;
    }
  } catch {}
  return trimmed.split(/[\\/]/).pop()?.trim() || trimmed;
}

function extractTranscriptMediaEntries(message: unknown): Array<{
  path: string;
  mediaType: unknown;
}> {
  const m = message as Record<string, unknown>;
  const transcriptMediaPaths = Array.isArray(m.MediaPaths)
    ? m.MediaPaths.filter((value): value is string => typeof value === "string")
    : typeof m.MediaPath === "string"
      ? [m.MediaPath]
      : [];
  const transcriptMediaTypes = Array.isArray(m.MediaTypes)
    ? m.MediaTypes
    : typeof m.MediaType === "string"
      ? [m.MediaType]
      : [];
  return transcriptMediaPaths.map((mediaPath, index) => ({
    path: mediaPath,
    mediaType: transcriptMediaTypes[index],
  }));
}

export function extractImages(message: unknown): ImageBlock[] {
  const m = message as Record<string, unknown>;
  const content = m.content;
  const images: ImageBlock[] = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== "object" || block === null) {
        continue;
      }
      const b = block as Record<string, unknown>;

      if (b.type === "image") {
        // Handle source object format from optimistic user sends.
        const source = b.source as Record<string, unknown> | undefined;
        const imageMeta = {
          alt: typeof b.alt === "string" ? b.alt : undefined,
          openUrl: typeof b.openUrl === "string" ? b.openUrl : undefined,
          width: typeof b.width === "number" ? b.width : undefined,
          height: typeof b.height === "number" ? b.height : undefined,
        };
        if (source?.type === "base64" && typeof source.data === "string") {
          appendImageBlock(images, {
            url: buildBase64ImageUrl({
              data: source.data,
              mediaType: typeof source.media_type === "string" ? source.media_type : undefined,
            }),
            ...imageMeta,
          });
        } else if (typeof b.data === "string") {
          // Direct tool-result image block from imageResult() / read tool.
          appendImageBlock(images, {
            url: buildBase64ImageUrl({
              data: b.data,
              mediaType: typeof b.mimeType === "string" ? b.mimeType : undefined,
            }),
            ...imageMeta,
          });
        } else if (typeof b.url === "string") {
          appendImageBlock(images, { url: b.url, ...imageMeta });
        }
      } else if (b.type === "image_url") {
        // OpenAI format
        const imageUrl = b.image_url as Record<string, unknown> | undefined;
        if (typeof imageUrl?.url === "string") {
          appendImageBlock(images, { url: imageUrl.url });
        }
      } else if (b.type === "input_image") {
        const imageUrl = b.image_url;
        if (typeof imageUrl === "string") {
          appendImageBlock(images, { url: imageUrl });
        } else if (imageUrl && typeof imageUrl === "object") {
          const url = (imageUrl as Record<string, unknown>).url;
          if (typeof url === "string") {
            appendImageBlock(images, { url });
          }
        }
        const source = b.source as Record<string, unknown> | undefined;
        if (typeof source?.url === "string") {
          appendImageBlock(images, { url: source.url });
        } else if (typeof source?.data === "string") {
          appendImageBlock(images, {
            url: buildBase64ImageUrl({
              data: source.data,
              mediaType: typeof source.media_type === "string" ? source.media_type : undefined,
            }),
          });
        }
      } else if (b.type === "openclaw_pairing_qr") {
        if (isExpiredPairingQrBlock(b)) {
          continue;
        }
        const imageUrl = b.image_url;
        if (typeof imageUrl === "string") {
          appendImageBlock(images, {
            url: imageUrl,
            alt: typeof b.alt === "string" ? b.alt : undefined,
          });
        }
      }
    }
  }

  for (const { path: mediaPath, mediaType } of extractTranscriptMediaEntries(message)) {
    if (!isImageTranscriptMediaPath(mediaPath, mediaType)) {
      continue;
    }
    appendImageBlock(images, { url: mediaPath });
  }

  return images;
}

function readPairingQrExpiresAtMs(block: Record<string, unknown>): number | undefined {
  const expiresAtMs = block.expiresAtMs;
  return typeof expiresAtMs === "number" && Number.isFinite(expiresAtMs) ? expiresAtMs : undefined;
}

function isExpiredPairingQrBlock(block: Record<string, unknown>, nowMs = Date.now()): boolean {
  const expiresAtMs = readPairingQrExpiresAtMs(block);
  return expiresAtMs !== undefined && expiresAtMs <= nowMs;
}

export function extractPairingQrExpiryNotices(
  message: unknown,
  nowMs = Date.now(),
): PairingQrExpiryNotice[] {
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (!Array.isArray(content)) {
    return [];
  }
  const notices: PairingQrExpiryNotice[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type === "openclaw_pairing_qr" && isExpiredPairingQrBlock(b, nowMs)) {
      notices.push({
        title: t("chat.pairingQrExpired.title"),
        reason: t("chat.pairingQrExpired.reason"),
      });
    }
  }
  return notices;
}

function resolveNearestFuturePairingQrExpiresAtMs(
  message: unknown,
  nowMs = Date.now(),
): number | undefined {
  const m = message as Record<string, unknown>;
  const content = m.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  let nearestExpiresAtMs: number | undefined;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type !== "openclaw_pairing_qr") {
      continue;
    }
    const expiresAtMs = readPairingQrExpiresAtMs(b);
    if (expiresAtMs === undefined || expiresAtMs <= nowMs) {
      continue;
    }
    nearestExpiresAtMs =
      nearestExpiresAtMs === undefined ? expiresAtMs : Math.min(nearestExpiresAtMs, expiresAtMs);
  }
  return nearestExpiresAtMs;
}

function clearPairingQrExpiryRefreshTimer(messageKey: string) {
  const existing = pairingQrExpiryRefreshTimers.get(messageKey);
  if (!existing) {
    return;
  }
  clearTimeout(existing.timer);
  pairingQrExpiryRefreshTimers.delete(messageKey);
}

export function schedulePairingQrExpiryRefresh(
  messageKey: string,
  message: unknown,
  onRequestUpdate: (() => void) | undefined,
) {
  const nowMs = Date.now();
  const expiresAtMs = resolveNearestFuturePairingQrExpiresAtMs(message, nowMs);
  const existing = pairingQrExpiryRefreshTimers.get(messageKey);
  if (!expiresAtMs || !onRequestUpdate) {
    if (existing) {
      clearPairingQrExpiryRefreshTimer(messageKey);
    }
    return;
  }
  if (existing?.expiresAtMs === expiresAtMs && existing.onRequestUpdate === onRequestUpdate) {
    return;
  }
  clearPairingQrExpiryRefreshTimer(messageKey);
  const timer = setTimeout(
    () => {
      pairingQrExpiryRefreshTimers.delete(messageKey);
      onRequestUpdate();
    },
    Math.max(0, expiresAtMs - nowMs),
  );
  pairingQrExpiryRefreshTimers.set(messageKey, { expiresAtMs, onRequestUpdate, timer });
}

export function extractTranscriptAttachments(message: unknown): AttachmentItem[] {
  const attachments: AttachmentItem[] = [];
  for (const { path: mediaPath, mediaType } of extractTranscriptMediaEntries(message)) {
    if (isImageTranscriptMediaPath(mediaPath, mediaType)) {
      continue;
    }
    const kind = isAudioTranscriptMediaPath(mediaPath, mediaType)
      ? "audio"
      : isVideoTranscriptMediaPath(mediaPath, mediaType)
        ? "video"
        : "document";
    attachments.push({
      type: "attachment",
      attachment: {
        url: mediaPath,
        kind,
        label: labelForMediaPath(mediaPath),
        ...(typeof mediaType === "string" ? { mimeType: mediaType } : {}),
      },
    });
  }
  return attachments;
}
