import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import { t } from "../../../i18n/index.ts";
import type { MessageContentItem } from "../../../lib/chat/chat-types.ts";
import { readTranscriptMediaEntries } from "../../../lib/chat/message-extract.ts";
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
  artifactId?: string;
  openUrl?: string;
  alt?: string;
  width?: number;
  height?: number;
};

export type ArtifactDownloadResolver = (params: {
  sessionKey: string;
  artifactId: string;
}) => Promise<{ url: string; expiresAt?: string } | null>;

export type ImageRenderOptions = {
  localMediaPreviewRoots?: readonly string[];
  basePath?: string;
  authToken?: string | null;
  onRequestUpdate?: () => void;
  onRequestOpenImage?: () => number;
  onOpenImage?: (item: ImageLightboxItem, requestVersion?: number) => void;
  resolveArtifactDownload?: ArtifactDownloadResolver;
};

export type RenderableImageBlock = ImageBlock & {
  displayUrl: string;
};

export type AttachmentItem = Extract<MessageContentItem, { type: "attachment" }>;

type ChatMediaResourceKind = "assistant-attachment" | "managed-image";

export type ChatMediaResource<Value> = {
  kind: ChatMediaResourceKind;
  cacheKey: string;
  value: Value | undefined;
  pending: Promise<Value | null> | undefined;
  subscribers: Set<() => void>;
  retryAttempted: boolean;
  unavailableAt: number | undefined;
  abortController: AbortController | undefined;
  refresh: { at: number; timer: ReturnType<typeof setTimeout> } | undefined;
};

const chatMediaResources = new Map<string, ChatMediaResource<unknown>>();
const chatMediaSubscriberResources = new Map<() => void, Map<string, ChatMediaResource<unknown>>>();
const chatMediaSubscriberChildren = new Map<() => void, Set<() => void>>();
const chatMediaSubscriberOwners = new Map<() => void, () => void>();
const managedImageBlobUrlResolvedCache = new Map<string, string>();
const managedImageBlobUrlRetainCounts = new Map<string, number>();
const MANAGED_IMAGE_BLOB_URL_CACHE_MAX_ENTRIES = 64;

function chatMediaResourceKey(kind: ChatMediaResourceKind, cacheKey: string): string {
  return `${kind}\0${cacheKey}`;
}

function detachChatMediaResourceSubscriber(
  resource: ChatMediaResource<unknown>,
  subscriber: () => void,
) {
  resource.subscribers.delete(subscriber);
  if (resource.subscribers.size > 0) {
    return;
  }
  if (resource.refresh) {
    clearTimeout(resource.refresh.timer);
    resource.refresh = undefined;
  }
  const resourceKey = chatMediaResourceKey(resource.kind, resource.cacheKey);
  if (chatMediaResources.get(resourceKey) === resource) {
    chatMediaResources.delete(resourceKey);
  }
  resource.abortController?.abort();
  resource.abortController = undefined;
}

export function observeChatMediaResource<Value>(
  kind: ChatMediaResourceKind,
  cacheKey: string,
  subscriber?: () => void,
  subscriberScope = cacheKey,
): ChatMediaResource<Value> {
  const resourceKey = chatMediaResourceKey(kind, cacheKey);
  let resource = chatMediaResources.get(resourceKey) as ChatMediaResource<Value> | undefined;
  if (!resource) {
    resource = {
      kind,
      cacheKey,
      value: undefined,
      pending: undefined,
      subscribers: new Set(),
      retryAttempted: false,
      unavailableAt: undefined,
      abortController: undefined,
      refresh: undefined,
    };
    chatMediaResources.set(resourceKey, resource as ChatMediaResource<unknown>);
  }
  if (subscriber) {
    let subscriptions = chatMediaSubscriberResources.get(subscriber);
    if (!subscriptions) {
      subscriptions = new Map();
      chatMediaSubscriberResources.set(subscriber, subscriptions);
    }
    const subscriptionKey = chatMediaResourceKey(kind, subscriberScope);
    const previous = subscriptions.get(subscriptionKey);
    if (previous && previous !== resource) {
      detachChatMediaResourceSubscriber(previous, subscriber);
    }
    subscriptions.set(subscriptionKey, resource as ChatMediaResource<unknown>);
    resource.subscribers.add(subscriber);
  }
  return resource;
}

export function isChatMediaResourceCurrent<Value>(resource: ChatMediaResource<Value>): boolean {
  return (
    chatMediaResources.get(chatMediaResourceKey(resource.kind, resource.cacheKey)) === resource
  );
}

export function notifyChatMediaResourceSubscribers<Value>(resource: ChatMediaResource<Value>) {
  if (!isChatMediaResourceCurrent(resource)) {
    return;
  }
  // A pane can change its subscription while another pane is being notified.
  // Snapshot the current generation so a replacement never receives stale work.
  for (const subscriber of Array.from(resource.subscribers)) {
    if (resource.subscribers.has(subscriber)) {
      subscriber();
    }
  }
}

export function scheduleChatMediaResourceRefresh<Value>(
  resource: ChatMediaResource<Value>,
  refreshAt: number | undefined,
  onRefresh: () => void,
) {
  if (resource.refresh?.at === refreshAt) {
    return;
  }
  if (resource.refresh) {
    clearTimeout(resource.refresh.timer);
    resource.refresh = undefined;
  }
  if (refreshAt === undefined || resource.subscribers.size === 0) {
    return;
  }
  const refresh = {
    at: refreshAt,
    timer: setTimeout(
      () => {
        if (!isChatMediaResourceCurrent(resource) || resource.refresh !== refresh) {
          return;
        }
        resource.refresh = undefined;
        onRefresh();
      },
      Math.max(0, refreshAt - Date.now()),
    ),
  };
  resource.refresh = refresh;
}

export function observeChatMediaResourceSubscriber(owner: () => void, subscriber: () => void) {
  const previousOwner = chatMediaSubscriberOwners.get(subscriber);
  if (previousOwner === owner) {
    return;
  }
  if (previousOwner) {
    const previousChildren = chatMediaSubscriberChildren.get(previousOwner);
    previousChildren?.delete(subscriber);
    if (previousChildren?.size === 0) {
      chatMediaSubscriberChildren.delete(previousOwner);
    }
  }
  let children = chatMediaSubscriberChildren.get(owner);
  if (!children) {
    children = new Set();
    chatMediaSubscriberChildren.set(owner, children);
  }
  children.add(subscriber);
  chatMediaSubscriberOwners.set(subscriber, owner);
}

export function releaseChatMediaResourceSubscriber(subscriber: (() => void) | undefined) {
  if (!subscriber) {
    return;
  }
  const children = chatMediaSubscriberChildren.get(subscriber);
  if (children) {
    chatMediaSubscriberChildren.delete(subscriber);
    for (const child of children) {
      releaseChatMediaResourceSubscriber(child);
    }
  }
  const owner = chatMediaSubscriberOwners.get(subscriber);
  if (owner) {
    chatMediaSubscriberOwners.delete(subscriber);
    const ownerChildren = chatMediaSubscriberChildren.get(owner);
    ownerChildren?.delete(subscriber);
    if (ownerChildren?.size === 0) {
      chatMediaSubscriberChildren.delete(owner);
    }
  }
  const subscriptions = chatMediaSubscriberResources.get(subscriber);
  if (!subscriptions) {
    return;
  }
  chatMediaSubscriberResources.delete(subscriber);
  for (const resource of new Set(subscriptions.values())) {
    detachChatMediaResourceSubscriber(resource, subscriber);
  }
}

export function trimManagedImageMissResources() {
  const misses = [...chatMediaResources.entries()].filter(
    ([, resource]) =>
      resource.kind === "managed-image" &&
      resource.value === null &&
      resource.subscribers.size === 0 &&
      !resource.pending,
  );
  for (const [resourceKey] of misses.slice(0, -MANAGED_IMAGE_BLOB_URL_CACHE_MAX_ENTRIES)) {
    chatMediaResources.delete(resourceKey);
  }
}

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
      const resourceKey = chatMediaResourceKey("managed-image", evictable);
      const resource = chatMediaResources.get(resourceKey);
      // Subscriber-free successful resources share their blob's LRU lifetime.
      // The promise finalizer may still be queued, but a matching value is settled.
      if (resource?.value === evicted && resource.subscribers.size === 0) {
        chatMediaResources.delete(resourceKey);
      }
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
  if (previous && previous !== blobUrl) {
    URL.revokeObjectURL(previous);
  }

  // Blob URLs retain browser-managed image data. Keep recent previews reusable,
  // but protect an image while its lightbox still uses that object URL.
  trimManagedImageBlobUrlCache();
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
          artifactId: typeof b.artifactId === "string" ? b.artifactId : undefined,
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

  for (const { path: mediaPath, mediaType } of readTranscriptMediaEntries(message)) {
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
  for (const { path: mediaPath, mediaType } of readTranscriptMediaEntries(message)) {
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
