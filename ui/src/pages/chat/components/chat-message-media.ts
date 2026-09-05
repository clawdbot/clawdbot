import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNonArrayRecord, asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import { t } from "../../../i18n/index.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import type { MessageContentItem } from "../../../lib/chat/chat-types.ts";
import { readTranscriptMediaEntries } from "../../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import {
  isAudioTranscriptMediaPath,
  isImageMediaPath,
  isSvgImageMediaPath,
  isVideoTranscriptMediaPath,
  labelForMediaPath,
} from "../../../lib/media-file-extension.ts";

export type ImageBlock = {
  url: string;
  factIndex?: number;
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
  sessionKey?: string;
  agentId?: string;
  policyKey?: string;
  canonicalMessageKey?: string;
  localSubmission?: boolean;
  connectionEpoch?: number;
  localMediaPreviewRoots?: readonly string[];
  resourceBasePath?: string;
  authToken?: string | null;
  onRequestUpdate?: () => void;
  onRequestOpenImage?: () => number;
  onOpenImage?: (item: ImageLightboxItem, requestVersion?: number) => void;
  resolveArtifactDownload?: ArtifactDownloadResolver;
};

export function assistantMediaPolicyKey(
  session: GatewaySessionRow | undefined,
  configEpoch = 0,
): string | undefined {
  if (!session && configEpoch === 0) {
    return undefined;
  }
  // These facts invalidate previews; the Gateway still owns the permission decision.
  return JSON.stringify([
    configEpoch,
    session?.permissionMode,
    session?.permissionModePending,
    session?.execNode,
    session?.execCwd,
    session?.sessionRoot,
    session?.spawnedWorkspaceDir,
    session?.spawnedCwd,
    session?.worktree?.id,
  ]);
}

export type AttachmentItem = Extract<MessageContentItem, { type: "attachment" }>;
type AttachmentFailureItem = Extract<MessageContentItem, { type: "attachment_error" }>;
export type AssistantAttachmentItem = AttachmentItem | AttachmentFailureItem;

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
  if (
    !images.some((entry) =>
      block.factIndex !== undefined
        ? entry.factIndex === block.factIndex
        : entry.factIndex === undefined && entry.url === block.url && entry.alt === block.alt,
    )
  ) {
    images.push(block);
  }
}

function buildBase64ImageUrl(data: string, mediaType: unknown): string {
  return data.startsWith("data:")
    ? data
    : `data:${typeof mediaType === "string" ? mediaType : "image/png"};base64,${data}`;
}

export function projectMessageMedia(
  message: unknown,
  content: readonly MessageContentItem[],
  nowMs = Date.now(),
) {
  const record = asNonArrayRecord(message);
  const blocks = Array.isArray(record.content) ? record.content : [];
  const images: ImageBlock[] = [];
  const attachments: AssistantAttachmentItem[] = [];
  const attachmentUrls = new Set<string>();
  let expiredPairingQrCount = 0;
  let nextPairingQrExpiresAt: number | undefined;
  const appendAttachment = (item: AssistantAttachmentItem) => {
    if (item.type === "attachment_error" || !attachmentUrls.has(item.attachment.url)) {
      attachments.push(item);
      if (item.type === "attachment") {
        attachmentUrls.add(item.attachment.url);
      }
    }
  };
  for (const item of content) {
    if (item.type === "attachment" || item.type === "attachment_error") {
      appendAttachment(item);
    }
  }
  const appendSvgAttachment = (
    source: unknown,
    mediaType?: unknown,
    metadata?: Record<string, unknown>,
  ): boolean => {
    if (typeof source !== "string" || !isSvgImageMediaPath(source, mediaType)) {
      return false;
    }
    try {
      const url = new URL(source, window.location.href);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.origin === window.location.origin
      ) {
        return false;
      }
    } catch {
      return false;
    }
    const sizeBytes = asFiniteNumber(metadata?.sizeBytes);
    appendAttachment({
      type: "attachment",
      attachment: {
        url: source,
        kind: "image",
        label:
          (typeof metadata?.fileName === "string" && metadata.fileName.trim()) ||
          (typeof metadata?.alt === "string" && metadata.alt.trim()) ||
          labelForMediaPath(source),
        mimeType: typeof mediaType === "string" ? mediaType : "image/svg+xml",
        ...(typeof metadata?.artifactId === "string" ? { artifactId: metadata.artifactId } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      },
    });
    return true;
  };
  const layout = asNonArrayRecord(asNonArrayRecord(record["__openclaw"]).mediaImageLayout);
  const slots = Array.isArray(layout.slots) ? layout.slots.map(asNonArrayRecord) : [];
  const factIndexes = slots.length > 0 ? new Set(slots.map((slot) => slot.factIndex)) : undefined;
  // Reject ambiguous layouts before deduplication: fact positions, including
  // holes and duplicate sources, are the persisted attachment identity.
  const validLayout =
    factIndexes !== undefined &&
    !(Array.isArray(layout.suppressedFactIndexes) && layout.suppressedFactIndexes.length > 0) &&
    slots.every(
      (slot) =>
        (slot.kind === "inline" || slot.kind === "offloaded") &&
        typeof slot.factIndex === "number" &&
        Number.isSafeInteger(slot.factIndex) &&
        slot.factIndex >= 0,
    ) &&
    factIndexes.size === slots.length;
  const inlineSlots = validLayout ? slots.filter((slot) => slot.kind === "inline") : [];
  let inlineIndex = 0;

  for (const value of blocks) {
    const block = asOptionalRecord(value);
    if (!block) {
      continue;
    }
    const source = asOptionalRecord(block.source);
    if (block.type === "image") {
      const factIndex = inlineSlots[inlineIndex++]?.factIndex;
      // The structured SVG reference is independent of inline data in the same block.
      const imageUrl = normalizeOptionalString(block.url) ?? normalizeOptionalString(source?.url);
      const svg = appendSvgAttachment(imageUrl, block.mimeType ?? source?.media_type, block);
      const base64Source =
        source?.type === "base64" && typeof source.data === "string" ? source : undefined;
      const data = base64Source ? base64Source.data : block.data;
      const url =
        typeof data === "string"
          ? buildBase64ImageUrl(data, base64Source ? base64Source.media_type : block.mimeType)
          : !svg && imageUrl !== undefined
            ? imageUrl
            : undefined;
      if (url !== undefined) {
        images.push({
          url,
          ...(typeof factIndex === "number" ? { factIndex } : {}),
          artifactId: typeof block.artifactId === "string" ? block.artifactId : undefined,
          alt: typeof block.alt === "string" ? block.alt : undefined,
          fileName: typeof block.fileName === "string" ? block.fileName : undefined,
          openUrl: typeof block.openUrl === "string" ? block.openUrl : undefined,
          sizeBytes: asFiniteNumber(block.sizeBytes),
          width: typeof block.width === "number" ? block.width : undefined,
          height: typeof block.height === "number" ? block.height : undefined,
        });
      }
    } else if (block.type === "image_url") {
      const url = normalizeOptionalString(asOptionalRecord(block.image_url)?.url);
      if (url !== undefined && !appendSvgAttachment(url)) {
        images.push({ url });
      }
    } else if (block.type === "input_image") {
      const blockImages: ImageBlock[] = [];
      const url =
        normalizeOptionalString(block.image_url) ??
        normalizeOptionalString(asOptionalRecord(block.image_url)?.url);
      if (url !== undefined && !appendSvgAttachment(url)) {
        blockImages.push({ url });
      }
      const sourceUrl = normalizeOptionalString(source?.url);
      const svg = appendSvgAttachment(sourceUrl, source?.media_type);
      if (sourceUrl !== undefined && !svg) {
        appendImageBlock(blockImages, { url: sourceUrl });
      } else if (typeof source?.data === "string") {
        appendImageBlock(blockImages, {
          url: buildBase64ImageUrl(source.data, source.media_type),
        });
      }
      // Separate blocks are separate attachments, including identical uploads.
      images.push(...blockImages);
    } else if (block.type === "openclaw_pairing_qr") {
      const expiresAt = asFiniteNumber(block.expiresAtMs);
      if (expiresAt !== undefined) {
        if (expiresAt <= nowMs) {
          expiredPairingQrCount += 1;
          continue;
        }
        nextPairingQrExpiresAt = Math.min(nextPairingQrExpiresAt ?? expiresAt, expiresAt);
      }
      const imageUrl = normalizeOptionalString(block.image_url);
      if (imageUrl !== undefined) {
        images.push({
          url: imageUrl,
          alt: typeof block.alt === "string" ? block.alt : undefined,
        });
      }
    }
  }
  // Only a complete inline layout may lend its fact positions to mounted previews.
  if (inlineIndex !== inlineSlots.length) {
    for (const image of images) {
      delete image.factIndex;
    }
  }
  for (const {
    path: mediaPath,
    mediaType,
    fileName,
    sizeBytes,
    durationMs,
    width,
    height,
    factIndex,
  } of readTranscriptMediaEntries(message)) {
    const image = isImageMediaPath(mediaPath, mediaType);
    const svg = image && isSvgImageMediaPath(mediaPath, mediaType);
    if (image && !svg) {
      appendImageBlock(images, {
        url: mediaPath,
        fileName,
        sizeBytes,
        ...(validLayout && factIndexes.has(factIndex) ? { factIndex } : {}),
      });
    } else {
      appendAttachment({
        type: "attachment",
        attachment: {
          url: mediaPath,
          kind: svg
            ? "image"
            : isAudioTranscriptMediaPath(mediaPath, mediaType)
              ? "audio"
              : isVideoTranscriptMediaPath(mediaPath, mediaType)
                ? "video"
                : "document",
          label: fileName?.trim() || labelForMediaPath(mediaPath),
          ...(typeof mediaType === "string" ? { mimeType: mediaType } : {}),
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
        },
      });
    }
  }
  return { images, attachments, expiredPairingQrCount, nextPairingQrExpiresAt };
}

export function schedulePairingQrExpiryRefresh(
  messageKey: string,
  refreshAt: number | undefined,
  onRequestUpdate: (() => void) | undefined,
) {
  if (!onRequestUpdate) {
    return;
  }
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

// Reply previews and completed-run actions describe the media the bubble renders.
export function extractMessageMediaText(
  message: unknown,
  content = normalizeMessage(message).content,
): string {
  const { images, attachments } = projectMessageMedia(message, content);
  return [
    ...images.map(
      (image) => image.fileName?.trim() || image.alt?.trim() || t("chat.imageLightbox.untitled"),
    ),
    ...content.flatMap((item) => {
      if (item.type !== "omitted_media") {
        return [];
      }
      const reason =
        item.media.sizeBytes === undefined
          ? t("chat.attachments.omittedFromHistory")
          : t("chat.attachments.omittedFromHistoryWithSize", {
              size: formatBytes(item.media.sizeBytes),
            });
      return [`${t("chat.attachments.image")} · ${reason}`];
    }),
    ...attachments.map(
      (item) => item.attachment.label.trim() || t("chat.attachments.attachedFile"),
    ),
  ].join("\n");
}
