// Feishu plugin module resolves attachments referenced from quoted/root/thread-history messages.
import { utimesSync } from "node:fs";
import type { ClawdbotConfig } from "../runtime-api.js";
import {
  resolveFeishuMediaKind,
  resolveSavedFeishuMedia,
  toMessageResourceType,
} from "./bot-content.js";
import { saveMessageResourceFeishu } from "./media.js";
import type { FeishuMediaInfo, FeishuMessageMediaKeys } from "./types.js";

/**
 * Process-wide cache for already-resolved referenced-message attachments. Keyed
 * by `${accountId}:${imageKey|fileKey}` so the same Feishu resource downloaded
 * for one inbound message is reused when another inbound's quoted/root/thread
 * history references it again.
 *
 * Why this exists: long-running monitoring scenarios re-read the same topic
 * history on every new message in the topic. Without a per-key cache an active
 * 20-message thread re-downloads every prior attachment for every new message
 * (O(n²) per topic) and quickly approaches per-turn byte budgets / Feishu API
 * rate limits.
 *
 * Scope: in-process only. Process restart re-warms the cache; that is fine —
 * downloads on a fresh process are bounded by the per-turn budget and resumed
 * naturally as new messages arrive. We do not negative-cache failures because
 * those are typically transient (token refresh, transient 5xx).
 *
 * Bounded with a simple FIFO/LRU. Cap is generous because each entry is just
 * a small object holding a string path; 1000 entries ≈ a few hundred KB.
 */
const REFERENCED_MEDIA_CACHE_MAX_ENTRIES = 1000;
type ReferencedMediaCacheEntry = { info: FeishuMediaInfo; size: number };
const referencedMediaCache = new Map<string, ReferencedMediaCacheEntry>();

type ReferencedMediaResource = {
  fileKey: string;
  type: "image" | "file";
  kind: FeishuMediaInfo["kind"];
  fileName?: string;
};

function addReferencedMediaResource(
  resources: ReferencedMediaResource[],
  seen: Set<string>,
  resource: ReferencedMediaResource,
): void {
  if (!resource.fileKey) {
    return;
  }
  const key = `${resource.type}:${resource.fileKey}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  resources.push(resource);
}

function collectReferencedMediaResources(
  messageType: string,
  mediaKeys: FeishuMessageMediaKeys,
): ReferencedMediaResource[] {
  const resources: ReferencedMediaResource[] = [];
  const seen = new Set<string>();

  if (messageType === "post") {
    for (const imageKey of mediaKeys.imageKeys ?? []) {
      addReferencedMediaResource(resources, seen, {
        fileKey: imageKey,
        type: "image",
        kind: "image",
      });
    }
    for (const media of mediaKeys.mediaKeys ?? []) {
      addReferencedMediaResource(resources, seen, {
        fileKey: media.fileKey,
        type: "file",
        kind: "video",
        fileName: media.fileName,
      });
    }
    return resources;
  }

  if (mediaKeys.imageKey) {
    addReferencedMediaResource(resources, seen, {
      fileKey: mediaKeys.imageKey,
      type: "image",
      // Always an image: for video/media messages the image_key is the
      // poster/thumbnail, not the video bytes, so kind must not follow the
      // message type or inbound media facts would label an image as video.
      kind: "image",
      fileName: mediaKeys.fileName,
    });
  }
  if (mediaKeys.fileKey) {
    addReferencedMediaResource(resources, seen, {
      fileKey: mediaKeys.fileKey,
      type: toMessageResourceType(messageType),
      kind: resolveFeishuMediaKind(messageType),
      fileName: mediaKeys.fileName,
    });
  }

  return resources;
}

function rememberReferencedMedia(key: string, value: ReferencedMediaCacheEntry): void {
  if (referencedMediaCache.has(key)) {
    referencedMediaCache.delete(key);
  } else if (referencedMediaCache.size >= REFERENCED_MEDIA_CACHE_MAX_ENTRIES) {
    const oldest = referencedMediaCache.keys().next().value;
    if (oldest !== undefined) {
      referencedMediaCache.delete(oldest);
    }
  }
  referencedMediaCache.set(key, value);
}

function recallReferencedMedia(key: string): ReferencedMediaCacheEntry | undefined {
  const cached = referencedMediaCache.get(key);
  if (!cached) {
    return undefined;
  }
  // The media store prunes inbound files by mtime on a short TTL
  // (DEFAULT_TTL_MS in src/media/store.ts is minutes, not hours). A cache hit
  // must therefore both verify the file still exists and touch it so the
  // recalled path gets a full retention window again — otherwise the next
  // sweep could remove it between context build and agent read. Evict and
  // re-download when the file is already gone.
  if (!cached.info.path) {
    referencedMediaCache.delete(key);
    return undefined;
  }
  try {
    const now = new Date();
    utimesSync(cached.info.path, now, now);
  } catch {
    referencedMediaCache.delete(key);
    return undefined;
  }
  referencedMediaCache.delete(key);
  referencedMediaCache.set(key, cached);
  return cached;
}

/** Test-only: drop all cached referenced-media entries. */
export function clearFeishuReferencedMediaCacheForTests(): void {
  referencedMediaCache.clear();
}

/**
 * Resolve attachments from a referenced (quoted/root/history) message into
 * FeishuMediaInfo entries. The Feishu file resource API requires the
 * message_id of the message that owns the resource, so callers must pass the
 * referenced message's id, not the inbound message's id.
 *
 * Used to pull image/file attachments from quoted/root/topic-history messages
 * into the agent's MediaPaths so an inbound that references earlier media is
 * answered from the actual bytes instead of a `[image message]`-style stub.
 *
 * Caching: results are memoized per `(accountId, resource type, key)`. A repeat
 * call with the same key returns the previously saved media without hitting
 * the Feishu API or rewriting the on-disk buffer.
 *
 * Budget: `maxBytes` bounds the bytes charged per call — fresh downloads and
 * cache hits both charge their saved size, so callers can cap the total media
 * delivered into one agent turn, not just wire cost. Entries carry their saved
 * size so callers that de-duplicate across calls can charge only what they
 * actually append. `failedDownloads` counts only real download attempts;
 * cache hits are never blocked by the failure cap.
 */
export async function resolveFeishuReferencedMessageMedia(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  messageType: string;
  mediaKeys: FeishuMessageMediaKeys;
  maxBytes: number;
  /** Stop after this many failed downloads (rich-text posts can carry many keys). */
  maxFailedDownloads?: number;
  log?: (msg: string) => void;
  accountId?: string;
  label?: string;
}): Promise<{
  entries: Array<{ media: FeishuMediaInfo; size: number }>;
  failedDownloads: number;
}> {
  const { cfg, messageId, messageType, mediaKeys, maxBytes, log, accountId, label } = params;
  const maxFailedDownloads = params.maxFailedDownloads ?? Number.POSITIVE_INFINITY;
  const resources = collectReferencedMediaResources(messageType, mediaKeys);
  if (resources.length === 0) {
    return { entries: [], failedDownloads: 0 };
  }
  const labelPrefix = label ? `${label} ` : "";
  const entries: Array<{ media: FeishuMediaInfo; size: number }> = [];
  let chargedBytes = 0;
  let failedDownloads = 0;

  for (const resource of resources) {
    // The byte budget bounds delivered media per call: a warm cache must not
    // let one turn attach unbounded previously-downloaded files.
    const remainingBytes = maxBytes - chargedBytes;
    if (remainingBytes <= 0) {
      break;
    }
    const cacheKey = `${accountId ?? "default"}:${resource.type}:${resource.fileKey}`;
    const cached = recallReferencedMedia(cacheKey);
    if (cached) {
      if (cached.size > remainingBytes) {
        continue;
      }
      log?.(
        `feishu: reused cached ${labelPrefix}${messageType} media for key=${resource.fileKey} -> ${cached.info.path}`,
      );
      // Kind is message-specific, not file-specific: the same file key can be
      // referenced as file/audio/video across messages. Cached path/contentType
      // are immutable; re-apply the current resource's kind on every recall.
      entries.push({ media: { ...cached.info, kind: resource.kind }, size: cached.size });
      chargedBytes += cached.size;
      continue;
    }

    // The failure cap gates only real download attempts; cache hits above stay
    // served even after expired/oversized keys exhaust the download quota.
    if (failedDownloads >= maxFailedDownloads) {
      continue;
    }

    try {
      const result = await saveMessageResourceFeishu({
        cfg,
        messageId,
        fileKey: resource.fileKey,
        type: resource.type,
        accountId,
        maxBytes: remainingBytes,
        originalFilename: resource.fileName,
      });
      const saved = await resolveSavedFeishuMedia({
        result,
        maxBytes: remainingBytes,
        originalFilename: resource.fileName,
      });
      const info: FeishuMediaInfo = {
        path: saved.path,
        contentType: saved.contentType ?? result.contentType,
        kind: resource.kind,
      };
      rememberReferencedMedia(cacheKey, { info, size: saved.size });
      entries.push({ media: info, size: saved.size });
      chargedBytes += saved.size;
      log?.(
        `feishu: downloaded ${labelPrefix}${messageType} media for message=${messageId}, saved to ${saved.path} (${saved.size}B)`,
      );
    } catch (err) {
      // Failed attempts still cost wire bytes before save-time size checks
      // reject them, and only saved bytes reach `downloadedBytes`. Count the
      // failure so callers can stop after a few and bound per-turn cost even
      // when a sender stacks oversized attachments.
      failedDownloads++;
      log?.(
        `feishu: failed to download ${labelPrefix}${messageType} media for message=${messageId}: ${String(err)}`,
      );
    }
  }

  return { entries, failedDownloads };
}
