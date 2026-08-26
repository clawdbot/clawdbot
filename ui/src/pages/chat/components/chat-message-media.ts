import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNonArrayRecord, asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import { t } from "../../../i18n/index.ts";
import type { MessageContentItem } from "../../../lib/chat/chat-types.ts";
import { readTranscriptMediaEntries } from "../../../lib/chat/message-extract.ts";
import {
  getMediaFileExtension,
  getMediaFileName,
  hasVideoMediaFileExtension,
} from "../../../lib/media-file-extension.ts";

export type PairingQrExpiryNotice = {
  title: string;
  reason: string;
};

export type ImageBlock = {
  url: string;
  artifactId?: string;
  fileName?: string;
  openUrl?: string;
  alt?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
};

export type ArtifactDownloadResolver = (params: {
  sessionKey: string;
  artifactId: string;
}) => Promise<{ url: string; expiresAt?: string } | null>;

export type ImageRenderOptions = {
  connectionEpoch?: number;
  localMediaPreviewRoots?: readonly string[];
  resourceBasePath?: string;
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

type ChatMediaResourceKind =
  | "assistant-attachment"
  | "managed-image"
  | "managed-media"
  | "pairing-qr";

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

type ChatMediaSubscriber = {
  resources: Map<string, ChatMediaResource<unknown>>;
  children: Set<() => void>;
  owner?: () => void;
};

type ManagedImageBlobUrl = {
  url: string;
  retainCount: number;
};

const chatMediaResources = new Map<string, ChatMediaResource<unknown>>();
const chatMediaSubscribers = new Map<() => void, ChatMediaSubscriber>();
const managedImageBlobUrls = new Map<string, ManagedImageBlobUrl>();
const MANAGED_IMAGE_BLOB_URL_CACHE_MAX_ENTRIES = 64;
let chatMediaRenderVersion = 0;

function chatMediaResourceKey(kind: ChatMediaResourceKind, cacheKey: string): string {
  return `${kind}\0${cacheKey}`;
}

function getChatMediaSubscriber(subscriber: () => void): ChatMediaSubscriber {
  let state = chatMediaSubscribers.get(subscriber);
  if (!state) {
    state = { resources: new Map(), children: new Set() };
    chatMediaSubscribers.set(subscriber, state);
  }
  return state;
}

function pruneChatMediaSubscriber(subscriber: () => void, state: ChatMediaSubscriber): void {
  if (!state.owner && state.children.size === 0 && state.resources.size === 0) {
    chatMediaSubscribers.delete(subscriber);
  }
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
    const subscriptions = getChatMediaSubscriber(subscriber).resources;
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

export function getChatMediaRenderVersion(): number {
  return chatMediaRenderVersion;
}

export function notifyChatMediaResourceSubscribers<Value>(resource: ChatMediaResource<Value>) {
  if (!isChatMediaResourceCurrent(resource)) {
    return;
  }
  chatMediaRenderVersion = (chatMediaRenderVersion + 1) % Number.MAX_SAFE_INTEGER;
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
  const state = getChatMediaSubscriber(subscriber);
  if (state.owner === owner) {
    return;
  }
  if (state.owner) {
    const previousOwner = state.owner;
    const previous = chatMediaSubscribers.get(previousOwner);
    if (previous) {
      previous.children.delete(subscriber);
      pruneChatMediaSubscriber(previousOwner, previous);
    }
  }
  getChatMediaSubscriber(owner).children.add(subscriber);
  state.owner = owner;
}

export function releaseChatMediaResourceSubscriber(subscriber: (() => void) | undefined) {
  const state = subscriber && chatMediaSubscribers.get(subscriber);
  if (!subscriber || !state) {
    return;
  }
  chatMediaSubscribers.delete(subscriber);
  for (const child of state.children) {
    releaseChatMediaResourceSubscriber(child);
  }
  if (state.owner) {
    const owner = chatMediaSubscribers.get(state.owner);
    if (owner) {
      owner.children.delete(subscriber);
      pruneChatMediaSubscriber(state.owner, owner);
    }
  }
  for (const resource of new Set(state.resources.values())) {
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
  const cached = managedImageBlobUrls.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  managedImageBlobUrls.delete(cacheKey);
  managedImageBlobUrls.set(cacheKey, cached);
  return cached.url;
}

function trimManagedImageBlobUrlCache() {
  while (managedImageBlobUrls.size > MANAGED_IMAGE_BLOB_URL_CACHE_MAX_ENTRIES) {
    const evictable = [...managedImageBlobUrls].find(([, cached]) => cached.retainCount === 0);
    if (!evictable) {
      return;
    }
    const [cacheKey, cached] = evictable;
    managedImageBlobUrls.delete(cacheKey);
    const resourceKey = chatMediaResourceKey("managed-image", cacheKey);
    const resource = chatMediaResources.get(resourceKey);
    // Subscriber-free successful resources share their blob's LRU lifetime.
    // The promise finalizer may still be queued, but a matching value is settled.
    if (resource?.value === cached.url && resource.subscribers.size === 0) {
      chatMediaResources.delete(resourceKey);
    }
    URL.revokeObjectURL(cached.url);
  }
}

export function retainManagedImageBlobUrl(cacheKey: string): (() => void) | undefined {
  const cached = managedImageBlobUrls.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  cached.retainCount += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const current = managedImageBlobUrls.get(cacheKey);
    if (current && current.retainCount > 0) {
      current.retainCount -= 1;
    }
    trimManagedImageBlobUrlCache();
  };
}

export function cacheManagedImageBlobUrl(cacheKey: string, blobUrl: string) {
  const previous = managedImageBlobUrls.get(cacheKey);
  managedImageBlobUrls.delete(cacheKey);
  managedImageBlobUrls.set(cacheKey, { url: blobUrl, retainCount: previous?.retainCount ?? 0 });
  if (previous && previous.url !== blobUrl) {
    URL.revokeObjectURL(previous.url);
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

export function isImageMediaPath(path: string, mediaType: unknown): boolean {
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

export function isSvgImageMediaPath(path: string, mediaType: unknown): boolean {
  const normalizedMediaType =
    typeof mediaType === "string" ? mediaType.split(";", 1)[0]?.trim().toLowerCase() : "";
  return normalizedMediaType === "image/svg+xml" || getMediaFileExtension(path) === "svg";
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
  return hasVideoMediaFileExtension(path);
}

// Collision-safe managed inbound URIs store the original filename plus a
// terminal "---<uuid>" storage suffix in the basename
// (e.g. media://inbound/report---<uuid>.pdf). Restore the original filename by
// removing only that final generated segment, so an original name that itself
// contains a "---<uuid>"-shaped part is preserved; the stored URI is unchanged.
const MANAGED_INBOUND_MEDIA_PREFIX = "media://inbound/";
const MANAGED_INBOUND_UUID_SUFFIX_PATTERN =
  /---[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\.[^./]*$|$)/i;

function labelForMediaPath(mediaPath: string): string {
  const trimmed = mediaPath.trim();
  if (trimmed.startsWith(MANAGED_INBOUND_MEDIA_PREFIX)) {
    const basename = trimmed.split("/").pop()?.trim() || trimmed;
    return basename.replace(MANAGED_INBOUND_UUID_SUFFIX_PATTERN, "") || basename;
  }
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const parsed = new URL(trimmed);
      return getMediaFileName(trimmed)?.trim() || parsed.hostname || trimmed;
    }
  } catch {}
  return trimmed.split(/[\\/]/).pop()?.trim() || trimmed;
}

function crossOriginStructuredSvgAttachment(
  source: unknown,
  mediaType: unknown,
  metadata: Record<string, unknown> = {},
): AttachmentItem | null {
  if (typeof source !== "string" || !isSvgImageMediaPath(source, mediaType)) {
    return null;
  }
  try {
    const url = new URL(source, window.location.href);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin === window.location.origin
    ) {
      return null;
    }
  } catch {
    return null;
  }
  const sizeBytes = asFiniteNumber(metadata.sizeBytes);
  return {
    type: "attachment",
    attachment: {
      url: source,
      kind: "image",
      label:
        (typeof metadata.fileName === "string" && metadata.fileName.trim()) ||
        (typeof metadata.alt === "string" && metadata.alt.trim()) ||
        labelForMediaPath(source),
      mimeType: typeof mediaType === "string" ? mediaType : "image/svg+xml",
      ...(typeof metadata.artifactId === "string" ? { artifactId: metadata.artifactId } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    },
  };
}

export function extractStructuredSvgAttachments(message: unknown): AttachmentItem[] {
  const content = asNonArrayRecord(message).content;
  if (!Array.isArray(content)) {
    return [];
  }
  const attachments: AttachmentItem[] = [];
  const append = (attachment: AttachmentItem | null) => {
    if (
      attachment &&
      !attachments.some((item) => item.attachment.url === attachment.attachment.url)
    ) {
      attachments.push(attachment);
    }
  };
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const entry = asNonArrayRecord(block);
    if (entry.type === "image") {
      const source = asOptionalRecord(entry.source);
      append(
        crossOriginStructuredSvgAttachment(entry.url, entry.mimeType ?? source?.media_type, entry),
      );
    } else if (entry.type === "image_url") {
      const imageUrl = asOptionalRecord(entry.image_url);
      append(crossOriginStructuredSvgAttachment(imageUrl?.url, undefined));
    } else if (entry.type === "input_image") {
      const imageUrl = entry.image_url;
      const source = asOptionalRecord(entry.source);
      append(
        crossOriginStructuredSvgAttachment(
          typeof imageUrl === "string" ? imageUrl : asOptionalRecord(imageUrl)?.url,
          undefined,
        ),
      );
      append(crossOriginStructuredSvgAttachment(source?.url, source?.media_type));
    }
  }
  return attachments;
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
          fileName: typeof b.fileName === "string" ? b.fileName : undefined,
          openUrl: typeof b.openUrl === "string" ? b.openUrl : undefined,
          sizeBytes: asFiniteNumber(b.sizeBytes),
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
        } else if (
          typeof b.url === "string" &&
          !crossOriginStructuredSvgAttachment(b.url, b.mimeType ?? source?.media_type, b)
        ) {
          appendImageBlock(images, { url: b.url, ...imageMeta });
        }
      } else if (b.type === "image_url") {
        // OpenAI format
        const imageUrl = b.image_url as Record<string, unknown> | undefined;
        if (
          typeof imageUrl?.url === "string" &&
          !crossOriginStructuredSvgAttachment(imageUrl.url, undefined)
        ) {
          appendImageBlock(images, { url: imageUrl.url });
        }
      } else if (b.type === "input_image") {
        const imageUrl = b.image_url;
        if (
          typeof imageUrl === "string" &&
          !crossOriginStructuredSvgAttachment(imageUrl, undefined)
        ) {
          appendImageBlock(images, { url: imageUrl });
        } else if (imageUrl && typeof imageUrl === "object") {
          const url = (imageUrl as Record<string, unknown>).url;
          if (typeof url === "string" && !crossOriginStructuredSvgAttachment(url, undefined)) {
            appendImageBlock(images, { url });
          }
        }
        const source = b.source as Record<string, unknown> | undefined;
        if (
          typeof source?.url === "string" &&
          !crossOriginStructuredSvgAttachment(source.url, source.media_type)
        ) {
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

  for (const { path: mediaPath, mediaType, fileName, sizeBytes } of readTranscriptMediaEntries(
    message,
  )) {
    if (!isImageMediaPath(mediaPath, mediaType) || isSvgImageMediaPath(mediaPath, mediaType)) {
      continue;
    }
    appendImageBlock(images, { url: mediaPath, fileName, sizeBytes });
  }

  return images;
}

function readPairingQrExpiresAtMs(block: Record<string, unknown>): number | undefined {
  return asFiniteNumber(block.expiresAtMs);
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

export function schedulePairingQrExpiryRefresh(
  messageKey: string,
  message: unknown,
  onRequestUpdate: (() => void) | undefined,
) {
  if (!onRequestUpdate) {
    return;
  }
  const refreshAt = resolveNearestFuturePairingQrExpiresAtMs(message);
  if (refreshAt === undefined) {
    const subscriber = chatMediaSubscribers.get(onRequestUpdate);
    const resourceKey = chatMediaResourceKey("pairing-qr", messageKey);
    const resource = subscriber?.resources.get(resourceKey);
    if (subscriber && resource) {
      subscriber.resources.delete(resourceKey);
      detachChatMediaResourceSubscriber(resource, onRequestUpdate);
      pruneChatMediaSubscriber(onRequestUpdate, subscriber);
    }
    return;
  }
  const resource = observeChatMediaResource<void>("pairing-qr", messageKey, onRequestUpdate);
  scheduleChatMediaResourceRefresh(resource, refreshAt, () =>
    notifyChatMediaResourceSubscribers(resource),
  );
}

export function extractTranscriptAttachments(message: unknown): AttachmentItem[] {
  const attachments: AttachmentItem[] = [];
  for (const {
    path: mediaPath,
    mediaType,
    fileName,
    sizeBytes,
    durationMs,
    width,
    height,
  } of readTranscriptMediaEntries(message)) {
    const image = isImageMediaPath(mediaPath, mediaType);
    const svg = image && isSvgImageMediaPath(mediaPath, mediaType);
    if (image && !svg) {
      continue;
    }
    const kind = svg
      ? "image"
      : isAudioTranscriptMediaPath(mediaPath, mediaType)
        ? "audio"
        : isVideoTranscriptMediaPath(mediaPath, mediaType)
          ? "video"
          : "document";
    attachments.push({
      type: "attachment",
      attachment: {
        url: mediaPath,
        kind,
        label: fileName?.trim() || labelForMediaPath(mediaPath),
        ...(typeof mediaType === "string" ? { mimeType: mediaType } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
      },
    });
  }
  return attachments;
}
