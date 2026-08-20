// Gateway managed media attachment store.
// Validates, stores, serves, and cleans up outgoing image/audio/video attachments.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { maxBytesForKind, mediaKindFromMime, type MediaKind } from "@openclaw/media-core/constants";
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { expectDefined } from "@openclaw/normalization-core";
import {
  asDateTimestampMs,
  asNonNegativeFiniteNumber,
  resolveTimestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import pLimit from "p-limit";
import type { ReplyMediaAttachment } from "../auto-reply/reply-payload.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { loadExactSessionEntryReadOnlyResult } from "../config/sessions/session-accessor.sqlite-entry-availability.js";
import { resolveSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  resolveExistingAgentSessionStoreTargetsReadOnlyResult,
  type SessionStoreTargetsReadCache,
} from "../config/sessions/targets-read-availability.js";
import { openLocalFileSafely, readLocalFileSafely } from "../infra/fs-safe.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { loadPendingSessionDeliveries } from "../infra/session-delivery-queue-storage.js";
import { assertLocalMediaAllowed, resolveLocalMediaRoots } from "../media/local-media-access.js";
import { resolveLocalMediaPath } from "../media/local-media-path.js";
import { probePlaybackMediaFileDescriptor } from "../media/media-probe.js";
import {
  createImageProcessor,
  getImageMetadata,
  readImageProbeFromHeader,
} from "../media/media-services.js";
import {
  replacePlaybackFileExtension,
  resolvePlaybackModeForSource,
  resolvePlaybackTranscode,
} from "../media/playback-transcode.js";
import { getMediaDir, MEDIA_MAX_BYTES, saveMediaBuffer, saveMediaSource } from "../media/store.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { buildAssistantMediaContentDisposition } from "./assistant-media-content-disposition.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  createGatewayByteStream,
  resolveByteResponse,
  writeByteHeaders,
} from "./http-byte-range.js";
import { sendJson, sendMethodNotAllowed, sendMissingScopeForbidden } from "./http-common.js";
import {
  authorizeGatewayHttpRequestOrReply,
  resolveOpenAiCompatibleHttpOperatorScopes,
  resolveOpenAiCompatibleHttpSenderIsOwner,
} from "./http-utils.js";
import {
  attachManagedImageRecordToMessage,
  claimManagedImageRecordCleanupIfCurrent,
  deleteClaimedManagedImageRecord,
  insertManagedImageRecord,
  listManagedImageRecordEntries,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  readManagedImageRecord,
  type ManagedImageRecord,
} from "./managed-image-record-store.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent.js";
import { readSessionMessagesWithSourceAsync } from "./session-transcript-readers.js";
import {
  loadGatewaySessionEntryReadOnly,
  resolveSessionHistoryTranscriptPathAsync,
} from "./session-utils.js";

const OUTGOING_IMAGE_ROUTE_PREFIX = "/api/chat/media/outgoing";
const DEFAULT_TRANSIENT_OUTGOING_IMAGE_TTL_MS = 15 * 60 * 1000;
const MANAGED_OUTGOING_IMAGE_TICKET_SCOPE = "managed-outgoing-image";
export const MANAGED_OUTGOING_IMAGE_TICKET_TTL_MS = 5 * 60 * 1000;
export const MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX = "artifact_managed_image_";
export const MANAGED_OUTGOING_MEDIA_ARTIFACT_ID_PREFIX = "artifact_managed_media_";
const MANAGED_IMAGE_THUMBNAIL_MAX_SIDE = 300;
const MANAGED_IMAGE_THUMBNAIL_CACHE_MAX_ENTRIES = 128;
const MANAGED_IMAGE_THUMBNAIL_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const MANAGED_IMAGE_THUMBNAIL_MAX_PENDING = 128;
const MANAGED_OUTGOING_ATTACHMENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const managedOutgoingImageTicketSecret = randomBytes(32);
const managedImageThumbnailCache = new Map<string, Buffer>();
const managedImageThumbnailJobs = new Map<string, Promise<Buffer>>();
const limitManagedImageThumbnails = pLimit(4);
let managedImageThumbnailCacheBytes = 0;

export const DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS = {
  maxBytes: 12 * 1024 * 1024,
  maxWidth: 4096,
  maxHeight: 4096,
  maxPixels: 20_000_000,
} as const;

export type ManagedImageAttachmentLimits = {
  maxBytes: number;
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
};

type ManagedImageAttachmentLimitsConfig = Partial<
  Pick<ManagedImageAttachmentLimits, "maxBytes" | "maxWidth" | "maxHeight" | "maxPixels">
>;

type ManagedMediaKind = Extract<MediaKind, "image" | "audio" | "video">;

type ParsedMediaDataUrl =
  | { kind: "not-data-url" }
  | { kind: "unsupported-data-url" }
  | {
      kind: "media-data-url";
      buffer: Buffer;
      contentType: string;
      mediaKind: ManagedMediaKind;
    };

type ManagedMediaBlock = Record<string, unknown>;

type CleanupManagedOutgoingMediaRecordsResult = {
  deletedRecordCount: number;
  deletedFileCount: number;
  retainedCount: number;
};

type SessionManagedOutgoingAttachmentIndex = Set<string>;
type SessionManagedOutgoingAttachmentIndexRead =
  | { kind: "available"; index: SessionManagedOutgoingAttachmentIndex | null }
  | {
      kind: "unavailable";
      reason:
        | "database-missing"
        | "schema-missing"
        | "table-missing"
        | "row-invalid"
        | "read-failed";
    };
type ManagedOutgoingTranscriptMatch = "match" | "missing" | "unavailable";
type SessionStoreAvailabilityRead = ReturnType<
  typeof resolveExistingAgentSessionStoreTargetsReadOnlyResult
>;

type SessionManagedOutgoingAttachmentIndexCacheEntry = {
  transcriptPath: string;
  mtimeMs: number;
  size: number;
  index: SessionManagedOutgoingAttachmentIndex;
};

type ManagedOutgoingImageTicketPayload = {
  scope: typeof MANAGED_OUTGOING_IMAGE_TICKET_SCOPE;
  sessionKey: string;
  attachmentId: string;
  variant: "full";
  exp: number;
};

export type ManagedOutgoingMediaArtifactDownload = {
  artifactId: string;
  sessionKey: string;
  type: ManagedMediaKind;
  title: string;
  mimeType?: string;
  sizeBytes?: number;
  url: string;
  expiresAt: string;
};

function readManagedImageThumbnail(cacheKey: string): Buffer | undefined {
  const thumbnail = managedImageThumbnailCache.get(cacheKey);
  if (!thumbnail) {
    return undefined;
  }
  managedImageThumbnailCache.delete(cacheKey);
  managedImageThumbnailCache.set(cacheKey, thumbnail);
  return thumbnail;
}

function cacheManagedImageThumbnail(cacheKey: string, thumbnail: Buffer): void {
  const previous = managedImageThumbnailCache.get(cacheKey);
  if (previous) {
    managedImageThumbnailCache.delete(cacheKey);
    managedImageThumbnailCacheBytes -= previous.byteLength;
  }
  managedImageThumbnailCache.set(cacheKey, thumbnail);
  managedImageThumbnailCacheBytes += thumbnail.byteLength;
  while (
    managedImageThumbnailCache.size > MANAGED_IMAGE_THUMBNAIL_CACHE_MAX_ENTRIES ||
    managedImageThumbnailCacheBytes > MANAGED_IMAGE_THUMBNAIL_CACHE_MAX_BYTES
  ) {
    const oldest = managedImageThumbnailCache.entries().next().value;
    if (!oldest) {
      break;
    }
    managedImageThumbnailCache.delete(oldest[0]);
    managedImageThumbnailCacheBytes -= oldest[1].byteLength;
  }
}

async function resolveManagedImageThumbnail(
  cacheKey: string,
  create: () => Promise<Buffer>,
): Promise<Buffer> {
  const cached = readManagedImageThumbnail(cacheKey);
  if (cached) {
    return cached;
  }
  const active = managedImageThumbnailJobs.get(cacheKey);
  if (active) {
    return await active;
  }
  if (limitManagedImageThumbnails.pendingCount >= MANAGED_IMAGE_THUMBNAIL_MAX_PENDING) {
    throw new Error("managed image thumbnail queue is full");
  }
  const pending = limitManagedImageThumbnails(create)
    .then((thumbnail) => {
      cacheManagedImageThumbnail(cacheKey, thumbnail);
      return thumbnail;
    })
    .finally(() => {
      managedImageThumbnailJobs.delete(cacheKey);
    });
  managedImageThumbnailJobs.set(cacheKey, pending);
  return await pending;
}
type SessionManagedOutgoingAttachmentTranscriptStat = Omit<
  SessionManagedOutgoingAttachmentIndexCacheEntry,
  "index"
>;

const sessionManagedOutgoingAttachmentIndexCache = new Map<
  string,
  SessionManagedOutgoingAttachmentIndexCacheEntry
>();
const MAX_SESSION_MANAGED_OUTGOING_ATTACHMENT_INDEX_CACHE_ENTRIES = 500;

function buildSessionManagedOutgoingAttachmentIndexCacheKey(
  sessionKey: string,
  agentId?: string,
): string {
  return sessionKey === "global" && agentId ? `agent:${agentId}:global` : sessionKey;
}

export function resolveManagedImageAttachmentLimits(
  config?: ManagedImageAttachmentLimitsConfig | null,
): ManagedImageAttachmentLimits {
  return {
    maxBytes: config?.maxBytes ?? DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS.maxBytes,
    maxWidth: config?.maxWidth ?? DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS.maxWidth,
    maxHeight: config?.maxHeight ?? DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS.maxHeight,
    maxPixels: config?.maxPixels ?? DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS.maxPixels,
  };
}

function formatLimitMiB(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${bytes} bytes`;
  }
  return Number.isInteger(bytes / (1024 * 1024))
    ? `${bytes / (1024 * 1024)} MiB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function createManagedImageAttachmentError(message: string) {
  const error = new Error(message);
  error.name = "ManagedImageAttachmentError";
  return error;
}

function isManagedImageAttachmentSafeError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "ManagedImageAttachmentError") {
    return true;
  }
  return (
    error.message.startsWith("Managed image attachment ") ||
    error.message.startsWith("Invalid image data URL")
  );
}

function getSanitizedManagedImageAttachmentError(
  error: unknown,
  label: string,
  kind: ManagedMediaKind | "media",
): Error {
  if (isManagedImageAttachmentSafeError(error)) {
    return error;
  }
  return createManagedImageAttachmentError(
    `Managed ${kind} attachment ${JSON.stringify(label)} could not be prepared`,
  );
}

function validateManagedImageBuffer(
  buffer: Buffer,
  alt: string,
  limits: ManagedImageAttachmentLimits,
): void {
  if (buffer.byteLength > limits.maxBytes) {
    throw createManagedImageAttachmentError(
      `Managed image attachment ${JSON.stringify(alt)} exceeds the ${formatLimitMiB(limits.maxBytes)} byte limit`,
    );
  }
}

function maxBytesForManagedMediaKind(
  kind: ManagedMediaKind,
  imageLimits: ManagedImageAttachmentLimits,
): number {
  return kind === "image" ? imageLimits.maxBytes : maxBytesForKind(kind);
}

function createManagedMediaByteLimitError(params: {
  kind: ManagedMediaKind;
  label: string;
  maxBytes: number;
}): Error {
  return createManagedImageAttachmentError(
    `Managed ${params.kind} attachment ${JSON.stringify(params.label)} exceeds the ${formatLimitMiB(params.maxBytes)} byte limit`,
  );
}

function estimateBase64DecodedByteLength(base64: string): number {
  const normalized = base64.replace(/\s+/g, "");
  const paddingMatch = /=+$/u.exec(normalized);
  const padding = Math.min(paddingMatch?.[0].length ?? 0, 2);
  return Math.floor((normalized.length * 3) / 4) - padding;
}

function getManagedImageMetadataLimitError(
  metadata: { width: number; height: number } | null,
  alt: string,
  limits: ManagedImageAttachmentLimits,
): string | null {
  if (!metadata) {
    return `Managed image attachment ${JSON.stringify(alt)} is missing readable dimensions`;
  }

  if (metadata.width > limits.maxWidth) {
    return `Managed image attachment ${JSON.stringify(alt)} exceeds the ${limits.maxWidth}px width limit`;
  }
  if (metadata.height > limits.maxHeight) {
    return `Managed image attachment ${JSON.stringify(alt)} exceeds the ${limits.maxHeight}px height limit`;
  }
  if (metadata.width * metadata.height > limits.maxPixels) {
    return `Managed image attachment ${JSON.stringify(alt)} exceeds the ${limits.maxPixels.toLocaleString("en-US")} pixel limit`;
  }
  return null;
}

function orientManagedImageMetadata(
  buffer: Buffer,
  metadata: { width: number; height: number } | null,
): { width: number; height: number } | null {
  if (!metadata) {
    return null;
  }
  const orientation = readImageProbeFromHeader(buffer)?.orientation;
  return orientation === 5 || orientation === 6 || orientation === 7 || orientation === 8
    ? { width: metadata.height, height: metadata.width }
    : metadata;
}

async function resizeManagedImageBufferToLimits(params: {
  buffer: Buffer;
  limits: ManagedImageAttachmentLimits;
}): Promise<{ buffer: Buffer; contentType: string; width: number; height: number }> {
  const resized = await createImageProcessor().encode(params.buffer, {
    format: "auto",
    limits: {
      maxWidth: params.limits.maxWidth,
      maxHeight: params.limits.maxHeight,
      maxPixels: params.limits.maxPixels,
    },
    opaque: { format: "jpeg", quality: 92 },
    transparent: { format: "png", compressionLevel: 9 },
    transparency: "auto",
  });

  return {
    buffer: resized.data,
    contentType: resized.mimeType,
    width: resized.width,
    height: resized.height,
  };
}

function resolveManagedImageOriginalPath(record: ManagedImageRecord) {
  if (
    !path.isAbsolute(record.original.mediaRoot) ||
    record.original.mediaSubdir !== MANAGED_OUTGOING_ORIGINALS_SUBDIR ||
    !record.original.mediaId ||
    record.original.mediaId.includes("/") ||
    record.original.mediaId.includes("\\") ||
    record.original.mediaId.includes("\0")
  ) {
    throw new Error("Managed image record has an unsafe media identity");
  }
  return path.join(record.original.mediaRoot, record.original.mediaSubdir, record.original.mediaId);
}

function resolveManagedImageOriginalsDir(stateDir: string): string {
  const runtimeMediaRoot =
    path.resolve(stateDir) === path.resolve(resolveStateDir())
      ? getMediaDir()
      : path.join(stateDir, "media");
  return path.join(runtimeMediaRoot, MANAGED_OUTGOING_ORIGINALS_SUBDIR);
}

async function hasUnmigratedManagedImageMetadata(stateDir: string): Promise<boolean> {
  try {
    const names = await fs.readdir(path.join(stateDir, "media", "outgoing", "records"));
    return names.some((name) => name.endsWith(".json") || name.includes(".json.doctor-importing-"));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function deleteAgedOrphanManagedImageFiles(params: {
  stateDir: string;
  nowMs: number;
  minAgeMs: number;
}): Promise<number> {
  // Destructive migration barrier only: runtime never parses or serves legacy metadata.
  // Any legacy source may own an old file, so Doctor must retire all JSON before orphan reaping.
  if (await hasUnmigratedManagedImageMetadata(params.stateDir)) {
    return 0;
  }
  const referencedMediaIds = new Set(
    listManagedImageRecordEntries({ stateDir: params.stateDir }).map(
      ({ record }) => record.original.mediaId,
    ),
  );
  const originalsDir = resolveManagedImageOriginalsDir(params.stateDir);
  let names: string[];
  try {
    names = await fs.readdir(originalsDir);
  } catch {
    return 0;
  }
  let deletedCount = 0;
  for (const name of names) {
    if (referencedMediaIds.has(name)) {
      continue;
    }
    const filePath = path.join(originalsDir, name);
    try {
      const stat = await fs.lstat(filePath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        params.nowMs - stat.mtimeMs < params.minAgeMs
      ) {
        continue;
      }
      await fs.rm(filePath, { force: true });
      deletedCount += 1;
    } catch {
      // A later maintenance pass retries transient filesystem failures and races.
    }
  }
  return deletedCount;
}

function buildOutgoingVariantUrl(sessionKey: string, attachmentId: string, variant: "full") {
  return `${OUTGOING_IMAGE_ROUTE_PREFIX}/${encodeURIComponent(sessionKey)}/${attachmentId}/${variant}`;
}

function buildManagedOutgoingArtifactId(attachmentId: string, kind: ManagedMediaKind): string {
  const prefix =
    kind === "image"
      ? MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX
      : MANAGED_OUTGOING_MEDIA_ARTIFACT_ID_PREFIX;
  return `${prefix}${attachmentId}`;
}

export function parseManagedOutgoingArtifactId(
  value: string,
): { attachmentId: string; family: "image" | "media" } | null {
  const family = value.startsWith(MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX)
    ? "image"
    : value.startsWith(MANAGED_OUTGOING_MEDIA_ARTIFACT_ID_PREFIX)
      ? "media"
      : null;
  if (!family) {
    return null;
  }
  const prefix =
    family === "image"
      ? MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX
      : MANAGED_OUTGOING_MEDIA_ARTIFACT_ID_PREFIX;
  const attachmentId = value.slice(prefix.length);
  return MANAGED_OUTGOING_ATTACHMENT_ID_RE.test(attachmentId) ? { attachmentId, family } : null;
}

function signManagedOutgoingImageTicketPayload(encodedPayload: string): string {
  return createHmac("sha256", managedOutgoingImageTicketSecret)
    .update(encodedPayload)
    .digest("base64url");
}

function createManagedOutgoingImageTicket(params: {
  sessionKey: string;
  attachmentId: string;
  nowMs?: number;
}): { ticket: string; expiresAt: string } | null {
  const now = asDateTimestampMs(params.nowMs ?? Date.now());
  if (now === undefined) {
    return null;
  }
  const exp = asDateTimestampMs(now + MANAGED_OUTGOING_IMAGE_TICKET_TTL_MS);
  if (exp === undefined) {
    return null;
  }
  const payload: ManagedOutgoingImageTicketPayload = {
    scope: MANAGED_OUTGOING_IMAGE_TICKET_SCOPE,
    sessionKey: params.sessionKey,
    attachmentId: params.attachmentId,
    variant: "full",
    exp,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signManagedOutgoingImageTicketPayload(encodedPayload);
  return {
    ticket: `v1.${encodedPayload}.${signature}`,
    expiresAt: resolveTimestampMsToIsoString(exp),
  };
}

function verifyManagedOutgoingImageTicket(params: {
  ticket: string | null;
  sessionKey: string;
  attachmentId: string;
  nowMs?: number;
}): boolean {
  const now = asDateTimestampMs(params.nowMs ?? Date.now());
  if (now === undefined) {
    return false;
  }
  const parts = params.ticket?.split(".");
  if (!parts || parts.length !== 3 || parts[0] !== "v1") {
    return false;
  }
  const [, encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) {
    return false;
  }
  if (!safeEqualSecret(signature, signManagedOutgoingImageTicketPayload(encodedPayload))) {
    return false;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<ManagedOutgoingImageTicketPayload>;
    return (
      payload.scope === MANAGED_OUTGOING_IMAGE_TICKET_SCOPE &&
      payload.sessionKey === params.sessionKey &&
      payload.attachmentId === params.attachmentId &&
      payload.variant === "full" &&
      typeof payload.exp === "number" &&
      Number.isFinite(payload.exp) &&
      payload.exp >= now
    );
  } catch {
    return false;
  }
}

function deriveAltText(source: string, index: number) {
  const fallback = `Generated image ${index + 1}`;
  try {
    if (/^https?:\/\//i.test(source)) {
      const parsed = new URL(source);
      const name = path.basename(parsed.pathname || "").trim();
      return name || fallback;
    }
  } catch {
    // Fall through to local path handling.
  }
  const localName = path.basename(source).trim();
  return localName || fallback;
}

function parseMediaDataUrl(
  source: string,
  label: string,
  imageLimits: ManagedImageAttachmentLimits,
): ParsedMediaDataUrl {
  const trimmed = source.trim();
  if (!trimmed.startsWith("data:")) {
    return { kind: "not-data-url" };
  }

  const afterPrefix = trimmed.slice("data:".length);
  const commaIdx = afterPrefix.indexOf(",");
  const mimeAndParams = commaIdx < 0 ? "" : afterPrefix.slice(0, commaIdx);
  const base64Marker = ";base64";
  if (mimeAndParams.slice(-base64Marker.length).toLowerCase() !== base64Marker) {
    throw new Error("Invalid image data URL");
  }
  const semicolonIdx = mimeAndParams.indexOf(";");
  const contentType = (semicolonIdx < 0 ? mimeAndParams : mimeAndParams.slice(0, semicolonIdx))
    .trim()
    .toLowerCase();
  if (!contentType) {
    throw new Error("Invalid image data URL");
  }

  const base64Part = afterPrefix.slice(commaIdx + 1);
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64Part)) {
    throw new Error("Invalid image data URL");
  }

  const mediaKind = mediaKindFromMime(contentType);
  if (mediaKind !== "image" && mediaKind !== "audio" && mediaKind !== "video") {
    return { kind: "unsupported-data-url" };
  }

  const maxBytes = maxBytesForManagedMediaKind(mediaKind, imageLimits);
  if (estimateBase64DecodedByteLength(base64Part) > maxBytes) {
    throw createManagedMediaByteLimitError({ kind: mediaKind, label, maxBytes });
  }

  return {
    kind: "media-data-url",
    buffer: Buffer.from(base64Part.replace(/\s+/g, ""), "base64"),
    contentType,
    mediaKind,
  };
}

async function getVariantStats(params: { filePath: string; buffer?: Buffer; sizeBytes?: number }) {
  const loaded = params.buffer
    ? { buffer: params.buffer, sizeBytes: params.sizeBytes ?? params.buffer.byteLength }
    : await (async () => {
        const { buffer, stat } = await readLocalFileSafely({ filePath: params.filePath });
        return { buffer, sizeBytes: stat.size };
      })();
  const metadataBuffer = loaded.buffer;
  const metadata = (await getImageMetadata(metadataBuffer).catch(() => null)) ?? {
    width: null,
    height: null,
  };
  return {
    width: metadata.width ?? null,
    height: metadata.height ?? null,
    sizeBytes: Number.isFinite(loaded.sizeBytes) ? loaded.sizeBytes : null,
  };
}

async function deleteManagedImageRecordArtifacts(
  record: ManagedImageRecord,
  stateDir = resolveStateDir(),
  alreadyClaimed = false,
) {
  if (!alreadyClaimed && !claimManagedImageRecordCleanupIfCurrent(record, stateDir)) {
    return { deletedRecord: false, deletedFileCount: 0 };
  }
  try {
    await fs.rm(resolveManagedImageOriginalPath(record), { force: true });
  } catch {
    // Keep the durable cleanup claim so the next sweep retries this exact file.
    return { deletedRecord: false, deletedFileCount: 0 };
  }
  return {
    deletedRecord: deleteClaimedManagedImageRecord(record, stateDir),
    deletedFileCount: 1,
  };
}

export async function cleanupManagedOutgoingMediaRecords(params?: {
  stateDir?: string;
  nowMs?: number;
  transientMaxAgeMs?: number;
  sessionKey?: string;
  agentId?: string;
  forceDeleteSessionRecords?: boolean;
  hasActiveSessionRun?: (sessionKey: string, agentId: string | undefined) => boolean;
}): Promise<CleanupManagedOutgoingMediaRecordsResult> {
  const stateDir = params?.stateDir ?? resolveStateDir();
  const nowMs = params?.nowMs ?? Date.now();
  const transientMaxAgeMs = params?.transientMaxAgeMs ?? DEFAULT_TRANSIENT_OUTGOING_IMAGE_TTL_MS;
  const sessionKeyFilter = params?.sessionKey ?? null;
  const agentIdFilter = params?.agentId?.trim() ? normalizeAgentId(params.agentId) : undefined;
  const globalCompatibilityOwnerAgentId =
    sessionKeyFilter === "global" && agentIdFilter
      ? tryResolveSessionCompatibilityOwnerAgentId(getRuntimeConfig(), "global")
      : undefined;
  const forceDeleteSessionRecords = params?.forceDeleteSessionRecords === true;
  const entries = listManagedImageRecordEntries({ stateDir });
  let pendingPreparedAttachmentIds: Set<string> | null | undefined;

  let deletedRecordCount = 0;
  let deletedFileCount = 0;
  let retainedCount = 0;
  const transcriptAttachmentIndexCache = new Map<
    string,
    SessionManagedOutgoingAttachmentIndex | null
  >();
  const sessionStoreAvailabilityCache = new Map<string, SessionStoreAvailabilityRead>();
  const sessionStoreTargetsReadCache: SessionStoreTargetsReadCache = new Map();
  for (const entry of entries) {
    const { record } = entry;
    if (sessionKeyFilter && record.sessionKey !== sessionKeyFilter) {
      retainedCount += 1;
      continue;
    }
    if (
      sessionKeyFilter === "global" &&
      record.sessionKey === "global" &&
      (!agentIdFilter ||
        resolveManagedSessionOwnerAgentId(
          record.sessionKey,
          record.agentId,
          globalCompatibilityOwnerAgentId,
        ) !== agentIdFilter)
    ) {
      retainedCount += 1;
      continue;
    }

    let shouldDelete = entry.cleanupPending;
    if (
      !entry.cleanupPending &&
      forceDeleteSessionRecords &&
      (!sessionKeyFilter || record.sessionKey === sessionKeyFilter)
    ) {
      shouldDelete = true;
    } else if (!entry.cleanupPending && record.messageId) {
      const transcriptMatch = await recordMatchesTranscriptMessage(
        record,
        transcriptAttachmentIndexCache,
        sessionStoreAvailabilityCache,
        sessionStoreTargetsReadCache,
        stateDir,
      );
      // Session-store unavailability is not proof that durable chat history no longer owns media.
      shouldDelete = transcriptMatch === "missing";
    } else if (!entry.cleanupPending) {
      const createdAtMs = Date.parse(record.createdAt);
      const otherwiseDeletable =
        Number.isFinite(createdAtMs) &&
        nowMs - createdAtMs >= transientMaxAgeMs &&
        params?.hasActiveSessionRun?.(record.sessionKey, record.agentId?.trim() || undefined) !==
          true;
      if (otherwiseDeletable) {
        if (pendingPreparedAttachmentIds === undefined) {
          pendingPreparedAttachmentIds = await loadPendingPreparedAttachmentIds(stateDir);
        }
        shouldDelete =
          pendingPreparedAttachmentIds !== null &&
          !pendingPreparedAttachmentIds.has(record.attachmentId);
      }
    }

    if (shouldDelete) {
      const deleted = await deleteManagedImageRecordArtifacts(
        record,
        stateDir,
        entry.cleanupPending,
      );
      if (deleted.deletedRecord) {
        deletedRecordCount += 1;
        deletedFileCount += deleted.deletedFileCount;
      } else {
        retainedCount += 1;
      }
    } else {
      retainedCount += 1;
    }
  }

  deletedFileCount += await deleteAgedOrphanManagedImageFiles({
    stateDir,
    nowMs,
    minAgeMs: Math.max(transientMaxAgeMs, DEFAULT_TRANSIENT_OUTGOING_IMAGE_TTL_MS),
  });

  return { deletedRecordCount, deletedFileCount, retainedCount };
}

function resolveManagedSessionOwnerAgentId(
  sessionKey: string,
  explicitAgentId?: string,
  compatibilityAgentId?: string,
): string | undefined {
  const ownerAgentId =
    explicitAgentId?.trim() ||
    parseAgentSessionKey(sessionKey)?.agentId ||
    compatibilityAgentId?.trim();
  return ownerAgentId ? normalizeAgentId(ownerAgentId) : undefined;
}

function resolveManagedRecordKind(record: ManagedImageRecord): ManagedMediaKind | null {
  const kind = mediaKindFromMime(record.original.contentType);
  return kind === "image" || kind === "audio" || kind === "video" ? kind : null;
}

function buildManagedMediaBlock(
  record: ManagedImageRecord,
  playback?: "native" | "transcode",
): ManagedMediaBlock {
  const kind = resolveManagedRecordKind(record);
  if (!kind) {
    throw new Error("Managed media record has an unsupported content type");
  }
  const fullUrl = buildOutgoingVariantUrl(record.sessionKey, record.attachmentId, "full");
  return {
    type: kind,
    artifactId: buildManagedOutgoingArtifactId(record.attachmentId, kind),
    url: fullUrl,
    openUrl: fullUrl,
    ...(kind === "image" ? { alt: record.alt } : { fileName: record.original.filename }),
    mimeType: record.original.contentType,
    ...(playback ? { playback } : {}),
    ...(kind === "image" ? { width: record.original.width, height: record.original.height } : {}),
    sizeBytes: record.original.sizeBytes,
  };
}

function buildManagedOutgoingAttachmentRefKey(messageId: string, attachmentId: string) {
  return `${messageId}::${attachmentId}`;
}

function buildManagedImageResizeWarningBlock(params: {
  alt: string;
  originalWidth: number;
  originalHeight: number;
  resizedWidth: number;
  resizedHeight: number;
}): ManagedMediaBlock {
  return {
    type: "text",
    text:
      `[Image warning] ${params.alt} exceeded gateway dimension/pixel limits and was resized from ` +
      `${params.originalWidth}×${params.originalHeight} to ${params.resizedWidth}×${params.resizedHeight}.`,
  };
}

function toRecordFilename(filePath: string) {
  const name = path.basename(filePath).trim();
  return name || null;
}

function asArray(value: string[] | undefined | null) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim())
    : [];
}

function parseManagedOutgoingRoute(value: string) {
  try {
    const parsed = new URL(value, "http://localhost");
    const match = parsed.pathname.match(/^\/api\/chat\/media\/outgoing\/([^/]+)\/([^/]+)\/full$/);
    if (!match) {
      return null;
    }
    if (
      !MANAGED_OUTGOING_ATTACHMENT_ID_RE.test(
        expectDefined(match[2], "managed image attachments regex capture 2"),
      )
    ) {
      return null;
    }
    return {
      sessionKey: decodeURIComponent(
        expectDefined(match[1], "managed image attachments regex capture 1"),
      ),
      attachmentId: expectDefined(match[2], "managed image attachments regex capture 2"),
    };
  } catch {
    return null;
  }
}

function collectManagedOutgoingAttachmentRefs(
  blocks: readonly Record<string, unknown>[] | undefined,
  expectedSessionKey?: string,
) {
  const refs = new Map<string, { attachmentId: string; sessionKey: string }>();
  for (const block of blocks ?? []) {
    if (block?.type !== "image" && block?.type !== "audio" && block?.type !== "video") {
      continue;
    }
    for (const candidate of [block.url, block.openUrl]) {
      if (typeof candidate !== "string") {
        continue;
      }
      const parsed = parseManagedOutgoingRoute(candidate);
      if (!parsed) {
        continue;
      }
      if (expectedSessionKey && parsed.sessionKey !== expectedSessionKey) {
        continue;
      }
      const attachmentId = expectDefined(parsed.attachmentId, "managed image attachment id");
      refs.set(attachmentId, {
        attachmentId,
        sessionKey: parsed.sessionKey,
      });
    }
  }
  return [...refs.values()];
}

async function loadPendingPreparedAttachmentIds(stateDir: string): Promise<Set<string> | null> {
  try {
    const attachmentIds = new Set<string>();
    for (const entry of await loadPendingSessionDeliveries(stateDir)) {
      if (entry.kind !== "agentTurn") {
        continue;
      }
      for (const blocks of Object.values(entry.preparedMediaBlocks ?? {})) {
        for (const ref of collectManagedOutgoingAttachmentRefs(blocks, entry.sessionKey)) {
          attachmentIds.add(ref.attachmentId);
        }
      }
    }
    return attachmentIds;
  } catch {
    // Queue ownership must be readable before transient artifacts can be reaped safely.
    return null;
  }
}

function getCachedSessionManagedOutgoingAttachmentIndex(
  sessionKey: string,
  agentId: string | undefined,
  stat: { transcriptPath: string; mtimeMs: number; size: number },
) {
  const cacheKey = buildSessionManagedOutgoingAttachmentIndexCacheKey(sessionKey, agentId);
  const cached = sessionManagedOutgoingAttachmentIndexCache.get(cacheKey);
  if (!cached) {
    return null;
  }
  if (
    cached.transcriptPath !== stat.transcriptPath ||
    cached.mtimeMs !== stat.mtimeMs ||
    cached.size !== stat.size
  ) {
    sessionManagedOutgoingAttachmentIndexCache.delete(cacheKey);
    return null;
  }
  sessionManagedOutgoingAttachmentIndexCache.delete(cacheKey);
  sessionManagedOutgoingAttachmentIndexCache.set(cacheKey, cached);
  return cached.index;
}

function setCachedSessionManagedOutgoingAttachmentIndex(
  sessionKey: string,
  agentId: string | undefined,
  stat: SessionManagedOutgoingAttachmentTranscriptStat,
  index: SessionManagedOutgoingAttachmentIndex,
) {
  sessionManagedOutgoingAttachmentIndexCache.set(
    buildSessionManagedOutgoingAttachmentIndexCacheKey(sessionKey, agentId),
    {
      transcriptPath: stat.transcriptPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      index,
    },
  );
  pruneMapToMaxSize(
    sessionManagedOutgoingAttachmentIndexCache,
    MAX_SESSION_MANAGED_OUTGOING_ATTACHMENT_INDEX_CACHE_ENTRIES,
  );
}

function sameManagedOutgoingAttachmentTranscriptStat(
  left: SessionManagedOutgoingAttachmentTranscriptStat | null,
  right: SessionManagedOutgoingAttachmentTranscriptStat | null,
): boolean {
  return (
    left?.transcriptPath === right?.transcriptPath &&
    left?.mtimeMs === right?.mtimeMs &&
    left?.size === right?.size
  );
}

async function getSessionManagedOutgoingAttachmentIndex(
  sessionKey: string,
  cache?: Map<string, SessionManagedOutgoingAttachmentIndex | null>,
  agentId?: string,
  storeAvailabilityCache?: Map<string, SessionStoreAvailabilityRead>,
  storeTargetsReadCache?: SessionStoreTargetsReadCache,
  stateDir?: string,
): Promise<SessionManagedOutgoingAttachmentIndexRead> {
  const cacheKey = buildSessionManagedOutgoingAttachmentIndexCacheKey(sessionKey, agentId);
  if (cache?.has(cacheKey)) {
    return { kind: "available", index: cache.get(cacheKey) ?? null };
  }
  const cfg = getRuntimeConfig();
  const ownerAgentId =
    resolveManagedSessionOwnerAgentId(sessionKey, agentId) ??
    tryResolveSessionCompatibilityOwnerAgentId(cfg, sessionKey);
  if (!ownerAgentId) {
    return { kind: "unavailable", reason: "read-failed" };
  }
  const discovery =
    storeAvailabilityCache?.get(ownerAgentId) ??
    resolveExistingAgentSessionStoreTargetsReadOnlyResult(cfg, ownerAgentId, {
      cache: storeTargetsReadCache,
      ...(stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : {}),
    });
  storeAvailabilityCache?.set(ownerAgentId, discovery);
  if (!discovery.available) {
    return { kind: "unavailable", reason: discovery.reason };
  }
  const usesRuntimeState = !stateDir || path.resolve(stateDir) === path.resolve(resolveStateDir());
  const env = stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env;
  type SessionEntry = ReturnType<typeof loadGatewaySessionEntryReadOnly>["entry"];
  let matched: { entry: NonNullable<SessionEntry>; storePath: string } | undefined;
  for (const target of discovery.targets) {
    const exact = loadExactSessionEntryReadOnlyResult({
      agentId: ownerAgentId,
      clone: false,
      env,
      sessionKey,
      storePath: target.storePath,
    });
    if (!exact.found) {
      return { kind: "unavailable", reason: exact.reason };
    }
    let targetEntry = exact.value?.entry;
    if (!targetEntry) {
      try {
        targetEntry = resolveSessionEntry(
          {
            agentId: ownerAgentId,
            clone: false,
            env,
            sessionKey,
            storePath: target.storePath,
          },
          { readOnly: true },
        ).existing;
      } catch {
        return { kind: "unavailable", reason: "row-invalid" };
      }
    }
    if (targetEntry) {
      if (matched) {
        return { kind: "unavailable", reason: "read-failed" };
      }
      matched = { entry: targetEntry, storePath: target.storePath };
    }
  }
  let entry: SessionEntry = matched?.entry;
  let storePath = matched?.storePath ?? discovery.targets[0]?.storePath ?? "";
  if (!entry && usesRuntimeState) {
    const loaded = loadGatewaySessionEntryReadOnly(sessionKey, { agentId: ownerAgentId });
    const exact = loadExactSessionEntryReadOnlyResult({
      agentId: ownerAgentId,
      clone: false,
      sessionKey,
      storePath: loaded.storePath,
    });
    if (!exact.found) {
      return { kind: "unavailable", reason: exact.reason };
    }
    entry = exact.value?.entry ?? loaded.entry;
    storePath = loaded.storePath;
  }
  const sessionId = entry?.sessionId;
  if (!sessionId) {
    cache?.set(cacheKey, null);
    return { kind: "available", index: null };
  }

  let transcriptStat: SessionManagedOutgoingAttachmentTranscriptStat | null = null;
  // This path is only a cache/reset-archive hint. Canonical active messages are
  // read from the structured SQLite identity below even when no artifact exists.
  const resolvedTranscriptPath = await resolveSessionHistoryTranscriptPathAsync(
    sessionId,
    storePath,
    undefined,
    { allowResetArchiveFallback: true },
  );
  if (resolvedTranscriptPath) {
    try {
      const stat = await fs.stat(resolvedTranscriptPath);
      transcriptStat = {
        transcriptPath: resolvedTranscriptPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
      const cachedIndex = getCachedSessionManagedOutgoingAttachmentIndex(
        sessionKey,
        agentId,
        transcriptStat,
      );
      if (cachedIndex) {
        cache?.set(cacheKey, cachedIndex);
        return { kind: "available", index: cachedIndex };
      }
    } catch {
      sessionManagedOutgoingAttachmentIndexCache.delete(cacheKey);
    }
  } else {
    sessionManagedOutgoingAttachmentIndexCache.delete(cacheKey);
  }

  const readResult = await readSessionMessagesWithSourceAsync(
    {
      agentId,
      sessionEntry: entry,
      sessionId,
      sessionKey,
      storePath,
    },
    {
      mode: "full",
      reason: "managed outgoing attachment index",
      allowResetArchiveFallback: true,
    },
  );
  const messages = readResult.messages;
  const preReadTranscriptStat = transcriptStat;
  if (readResult.transcriptPath) {
    try {
      const stat = await fs.stat(readResult.transcriptPath);
      const postReadTranscriptStat = {
        transcriptPath: readResult.transcriptPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
      transcriptStat = sameManagedOutgoingAttachmentTranscriptStat(
        preReadTranscriptStat,
        postReadTranscriptStat,
      )
        ? postReadTranscriptStat
        : null;
    } catch {
      transcriptStat = null;
    }
  } else {
    transcriptStat = null;
  }
  const index: SessionManagedOutgoingAttachmentIndex = new Set();
  for (const message of messages) {
    const meta = (message as { __openclaw?: { id?: string } } | null)?.["__openclaw"];
    const messageId = meta?.id;
    if (typeof messageId !== "string" || !messageId) {
      continue;
    }
    for (const ref of collectManagedOutgoingAttachmentRefs(
      Array.isArray((message as { content?: unknown[] } | null)?.content)
        ? ((message as { content: unknown[] }).content as Record<string, unknown>[])
        : [],
      sessionKey,
    )) {
      index.add(buildManagedOutgoingAttachmentRefKey(messageId, ref.attachmentId));
    }
  }

  if (transcriptStat) {
    setCachedSessionManagedOutgoingAttachmentIndex(sessionKey, agentId, transcriptStat, index);
  }
  cache?.set(cacheKey, index);
  return { kind: "available", index };
}

async function recordMatchesTranscriptMessage(
  record: ManagedImageRecord,
  cache?: Map<string, SessionManagedOutgoingAttachmentIndex | null>,
  storeAvailabilityCache?: Map<string, SessionStoreAvailabilityRead>,
  storeTargetsReadCache?: SessionStoreTargetsReadCache,
  stateDir?: string,
): Promise<ManagedOutgoingTranscriptMatch> {
  if (!record.messageId) {
    return "missing";
  }
  const read = await getSessionManagedOutgoingAttachmentIndex(
    record.sessionKey,
    cache,
    record.agentId,
    storeAvailabilityCache,
    storeTargetsReadCache,
    stateDir,
  );
  if (read.kind === "unavailable") {
    return "unavailable";
  }
  return read.index?.has(
    buildManagedOutgoingAttachmentRefKey(record.messageId, record.attachmentId),
  )
    ? "match"
    : "missing";
}

async function resolveManagedOutgoingMediaArtifactDownloadForRecord(
  record: ManagedImageRecord,
  stateDir?: string,
): Promise<ManagedOutgoingMediaArtifactDownload | null> {
  if (
    (await recordMatchesTranscriptMessage(record, undefined, undefined, undefined, stateDir)) !==
    "match"
  ) {
    return null;
  }
  const kind = resolveManagedRecordKind(record);
  if (!kind) {
    return null;
  }
  const ticket = createManagedOutgoingImageTicket({
    sessionKey: record.sessionKey,
    attachmentId: record.attachmentId,
  });
  if (!ticket) {
    return null;
  }
  try {
    const stat = await fs.stat(resolveManagedImageOriginalPath(record));
    if (!stat.isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  const canonicalUrl = buildOutgoingVariantUrl(record.sessionKey, record.attachmentId, "full");
  const params = new URLSearchParams({ mediaTicket: ticket.ticket });
  return {
    artifactId: buildManagedOutgoingArtifactId(record.attachmentId, kind),
    sessionKey: record.sessionKey,
    type: kind,
    title: kind === "image" ? record.alt : (record.original.filename ?? record.alt),
    ...(record.original.contentType ? { mimeType: record.original.contentType } : {}),
    ...(record.original.sizeBytes != null ? { sizeBytes: record.original.sizeBytes } : {}),
    url: `${canonicalUrl}?${params.toString()}`,
    expiresAt: ticket.expiresAt,
  };
}

/** Resolve one transcript-backed media artifact to a short-lived HTTP capability. */
export async function resolveManagedOutgoingMediaArtifactDownload(params: {
  sessionKey: string;
  agentId?: string;
  defaultAgentId?: string;
  artifactId: string;
  stateDir?: string;
}): Promise<ManagedOutgoingMediaArtifactDownload | null> {
  const parsed = parseManagedOutgoingArtifactId(params.artifactId);
  if (!parsed) {
    return null;
  }
  const record = readManagedImageRecord(parsed.attachmentId, params.stateDir);
  if (!record || record.sessionKey !== params.sessionKey) {
    return null;
  }
  const requestedAgentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
  const recordAgentId = resolveManagedSessionOwnerAgentId(
    record.sessionKey,
    record.agentId,
    params.defaultAgentId,
  );
  if (requestedAgentId && recordAgentId !== requestedAgentId) {
    return null;
  }
  const kind = resolveManagedRecordKind(record);
  if (!kind || (parsed.family === "image") !== (kind === "image")) {
    return null;
  }
  return await resolveManagedOutgoingMediaArtifactDownloadForRecord(record, params.stateDir);
}

/** Upgrade legacy managed-image URLs that predate stable artifact ids. */
export async function resolveManagedOutgoingMediaUrlDownload(params: {
  sessionKey: string;
  url: string;
  stateDir?: string;
}): Promise<ManagedOutgoingMediaArtifactDownload | null> {
  const parsed = parseManagedOutgoingRoute(params.url);
  if (!parsed || parsed.sessionKey !== params.sessionKey) {
    return null;
  }
  const record = readManagedImageRecord(parsed.attachmentId, params.stateDir);
  if (!record || record.sessionKey !== params.sessionKey) {
    return null;
  }
  return await resolveManagedOutgoingMediaArtifactDownloadForRecord(record, params.stateDir);
}

export function attachManagedOutgoingMediaToMessage(params: {
  messageId: string;
  blocks?: readonly Record<string, unknown>[];
  stateDir?: string;
}) {
  const messageId = params.messageId.trim();
  if (!messageId) {
    return false;
  }
  const refs = collectManagedOutgoingAttachmentRefs(params.blocks);
  if (refs.length === 0) {
    return false;
  }
  return refs
    .map(({ attachmentId, sessionKey }) =>
      attachManagedImageRecordToMessage({
        attachmentId,
        sessionKey,
        messageId,
        updatedAt: new Date().toISOString(),
        stateDir: params.stateDir,
      }),
    )
    .every(Boolean);
}

export async function createManagedOutgoingMediaBlocks(params: {
  sessionKey: string;
  agentId?: string;
  mediaUrls?: string[] | null;
  attachments?: readonly ReplyMediaAttachment[] | null;
  stateDir?: string;
  messageId?: string | null;
  limits?: ManagedImageAttachmentLimitsConfig | null;
  localRoots?: readonly string[] | "any";
  allowLocalNonImage?: boolean;
  continueOnPrepareError?: boolean;
  onPrepareError?: (error: Error) => void;
}): Promise<ManagedMediaBlock[]> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return [];
  }
  const mediaUrls = asArray(params.mediaUrls);
  if (mediaUrls.length === 0) {
    return [];
  }
  const stateDir = params.stateDir ?? resolveStateDir();
  const limits = resolveManagedImageAttachmentLimits(params.limits);
  const blocks: ManagedMediaBlock[] = [];
  let resolvedLocalRoots: readonly string[] | undefined;
  for (const [index, mediaUrl] of mediaUrls.entries()) {
    const attachmentMetadata = params.attachments?.[index];
    const trimmedMediaUrl = mediaUrl.trim();
    const dataUrlKind = /^data:(image|audio|video)\//iu.exec(trimmedMediaUrl)?.[1];
    const fallbackLabel = `Generated ${dataUrlKind ?? "media"} ${index + 1}`;
    const isDataUrl = trimmedMediaUrl.startsWith("data:");
    const localMediaPath = isDataUrl ? undefined : resolveLocalMediaPath(mediaUrl);
    const label = isDataUrl ? fallbackLabel : deriveAltText(localMediaPath ?? mediaUrl, index);
    const inferredKind = mediaKindFromMime(mimeTypeFromFilePath(localMediaPath ?? mediaUrl));
    const hintedKind =
      dataUrlKind === "image" || dataUrlKind === "audio" || dataUrlKind === "video"
        ? dataUrlKind
        : inferredKind === "image" || inferredKind === "audio" || inferredKind === "video"
          ? inferredKind
          : "media";

    let savedOriginalPath: string | null = null;
    try {
      const parsedDataUrl = parseMediaDataUrl(mediaUrl, fallbackLabel, limits);
      if (parsedDataUrl.kind === "unsupported-data-url") {
        continue;
      }
      if (
        localMediaPath &&
        (hintedKind === "audio" || hintedKind === "video") &&
        params.allowLocalNonImage !== true
      ) {
        throw new Error("Local audio/video media requires an explicitly trusted reply payload");
      }
      let resizeWarning: ManagedMediaBlock | null = null;
      let savedOriginal =
        parsedDataUrl.kind === "media-data-url"
          ? await saveMediaBuffer(
              parsedDataUrl.buffer,
              parsedDataUrl.contentType,
              "outgoing/originals",
              maxBytesForManagedMediaKind(parsedDataUrl.mediaKind, limits),
              `generated-${parsedDataUrl.mediaKind}-${index + 1}`,
            )
          : await (async () => {
              if (localMediaPath) {
                const localRoots = params.localRoots;
                const localMediaOptions =
                  localRoots === "any"
                    ? undefined
                    : {
                        resolveRoots: async () => {
                          resolvedLocalRoots ??= await resolveLocalMediaRoots(localRoots);
                          return resolvedLocalRoots;
                        },
                      };
                await assertLocalMediaAllowed(localMediaPath, localRoots, localMediaOptions);
              }
              // File URLs have already been normalized for display metadata and policy checks.
              // Pass that path to the store instead of treating URI syntax as a filename.
              const ingestSource = localMediaPath ?? mediaUrl;
              return await saveMediaSource(
                ingestSource,
                undefined,
                "outgoing/originals",
                Math.max(
                  limits.maxBytes,
                  maxBytesForKind("audio"),
                  maxBytesForKind("video"),
                  MEDIA_MAX_BYTES,
                ),
              );
            })();
      savedOriginalPath = savedOriginal.path;
      let savedOriginalContentType = savedOriginal.contentType;
      if (!savedOriginalContentType) {
        await fs.rm(savedOriginal.path, { force: true }).catch(() => {});
        savedOriginalPath = null;
        continue;
      }
      const mediaKind = mediaKindFromMime(savedOriginalContentType);
      if (mediaKind !== "image" && mediaKind !== "audio" && mediaKind !== "video") {
        await fs.rm(savedOriginal.path, { force: true }).catch(() => {});
        savedOriginalPath = null;
        continue;
      }
      if (localMediaPath && mediaKind !== "image" && params.allowLocalNonImage !== true) {
        throw new Error("Local audio/video media requires an explicitly trusted reply payload");
      }
      const maxBytes = maxBytesForManagedMediaKind(mediaKind, limits);
      if (savedOriginal.size > maxBytes) {
        throw createManagedMediaByteLimitError({ kind: mediaKind, label, maxBytes });
      }

      let originalStats: Awaited<ReturnType<typeof getVariantStats>> = {
        width: null as number | null,
        height: null as number | null,
        sizeBytes: savedOriginal.size,
      };
      if (mediaKind === "image") {
        let originalBuffer =
          parsedDataUrl.kind === "media-data-url"
            ? parsedDataUrl.buffer
            : (await readLocalFileSafely({ filePath: savedOriginal.path })).buffer;
        validateManagedImageBuffer(originalBuffer, label, limits);
        originalStats = await getVariantStats({
          filePath: savedOriginal.path,
          buffer: originalBuffer,
          sizeBytes: savedOriginal.size,
        });
        if (originalStats.sizeBytes != null && originalStats.sizeBytes > maxBytes) {
          throw createManagedMediaByteLimitError({ kind: mediaKind, label, maxBytes });
        }

        const originalMetadata =
          originalStats.width != null && originalStats.height != null
            ? { width: originalStats.width, height: originalStats.height }
            : await getImageMetadata(originalBuffer);
        const originalDisplayMetadata = orientManagedImageMetadata(
          originalBuffer,
          originalMetadata,
        );
        let effectiveMetadata = originalDisplayMetadata;
        let metadataLimitError = getManagedImageMetadataLimitError(
          effectiveMetadata,
          label,
          limits,
        );
        for (let resizeAttempt = 0; metadataLimitError; resizeAttempt += 1) {
          if (!effectiveMetadata || resizeAttempt >= 3) {
            throw createManagedImageAttachmentError(metadataLimitError);
          }
          const resized = await resizeManagedImageBufferToLimits({
            buffer: originalBuffer,
            limits,
          });
          validateManagedImageBuffer(resized.buffer, label, limits);
          const replacement = await saveMediaBuffer(
            resized.buffer,
            resized.contentType,
            "outgoing/originals",
            limits.maxBytes,
            toRecordFilename(savedOriginal.path) ?? `generated-image-${index + 1}`,
          );
          await fs.rm(savedOriginal.path, { force: true }).catch(() => {});
          savedOriginal = replacement;
          savedOriginalContentType = replacement.contentType ?? resized.contentType;
          savedOriginalPath = savedOriginal.path;
          originalBuffer = resized.buffer;
          originalStats = await getVariantStats({
            filePath: savedOriginal.path,
            buffer: originalBuffer,
            sizeBytes: savedOriginal.size,
          });
          effectiveMetadata = orientManagedImageMetadata(
            originalBuffer,
            originalStats.width != null && originalStats.height != null
              ? { width: originalStats.width, height: originalStats.height }
              : await getImageMetadata(originalBuffer),
          );
          metadataLimitError = getManagedImageMetadataLimitError(effectiveMetadata, label, limits);
          if (!metadataLimitError) {
            resizeWarning = buildManagedImageResizeWarningBlock({
              alt: label,
              originalWidth:
                originalDisplayMetadata?.width ?? effectiveMetadata?.width ?? resized.width,
              originalHeight:
                originalDisplayMetadata?.height ?? effectiveMetadata?.height ?? resized.height,
              resizedWidth: effectiveMetadata?.width ?? resized.width,
              resizedHeight: effectiveMetadata?.height ?? resized.height,
            });
          }
        }
      }

      const record: ManagedImageRecord = {
        attachmentId: randomUUID(),
        sessionKey,
        ...(sessionKey === "global" && params.agentId?.trim()
          ? { agentId: params.agentId.trim() }
          : {}),
        messageId: params.messageId ?? null,
        createdAt: new Date().toISOString(),
        retentionClass: params.messageId ? "history" : "transient",
        alt: label,
        original: {
          mediaRoot: path.dirname(path.dirname(path.dirname(path.resolve(savedOriginal.path)))),
          mediaId: savedOriginal.id,
          mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
          contentType: savedOriginalContentType,
          width: originalStats.width,
          height: originalStats.height,
          sizeBytes: originalStats.sizeBytes,
          filename:
            mediaKind === "image"
              ? toRecordFilename(savedOriginal.path)
              : attachmentMetadata?.name?.trim() || label,
        },
      };
      let playback: "native" | "transcode" | undefined;
      if (mediaKind === "audio" || mediaKind === "video") {
        const opened = await openLocalFileSafely({ filePath: savedOriginal.path });
        try {
          const probe = await probePlaybackMediaFileDescriptor(opened.handle.fd, mediaKind);
          playback = await resolvePlaybackModeForSource({
            sourcePath: opened.realPath,
            sourceStat: opened.stat,
            mimeType: savedOriginalContentType,
            kind: mediaKind,
            probe,
          });
        } finally {
          await opened.handle.close().catch(() => {});
        }
      }
      const block = buildManagedMediaBlock(record, playback);
      insertManagedImageRecord(record, stateDir);
      const durationMs = asNonNegativeFiniteNumber(attachmentMetadata?.durationMs);
      const width = asNonNegativeFiniteNumber(attachmentMetadata?.width);
      const height = asNonNegativeFiniteNumber(attachmentMetadata?.height);
      blocks.push({
        ...block,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(mediaKind === "video" && width !== undefined ? { width } : {}),
        ...(mediaKind === "video" && height !== undefined ? { height } : {}),
      });
      if (resizeWarning) {
        blocks.push(resizeWarning);
      }
    } catch (error) {
      if (savedOriginalPath) {
        await fs.rm(savedOriginalPath, { force: true }).catch(() => {});
      }
      const sanitizedError = getSanitizedManagedImageAttachmentError(error, label, hintedKind);
      if (params.continueOnPrepareError) {
        params.onPrepareError?.(sanitizedError);
        continue;
      }
      throw sanitizedError;
    }
  }
  return blocks;
}

function sendStatus(res: ServerResponse, statusCode: number, body: string) {
  if (res.writableEnded) {
    return;
  }
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

function buildManagedMediaContentDisposition(value: string | null, contentType: string): string {
  const fallback = contentType.startsWith("image/") ? "generated-image" : "generated-media";
  const base = (value ?? fallback).replace(/[\r\n"\\]/g, "_").trim();
  const filename = base || fallback;
  return /^[\x20-\x7e]+$/u.test(filename)
    ? `inline; filename="${filename}"`
    : buildAssistantMediaContentDisposition(filename, contentType);
}

export async function handleManagedOutgoingMediaHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    basePath?: string;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
    stateDir?: string;
  },
): Promise<boolean> {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const requestPath =
    opts.basePath && requestUrl.pathname.startsWith(`${opts.basePath}/`)
      ? requestUrl.pathname.slice(opts.basePath.length)
      : requestUrl.pathname;
  const match = requestPath.match(
    /^\/api\/chat\/media\/outgoing\/([^/]+)\/([^/]+)\/(full|thumbnail)$/,
  );
  if (!match) {
    return false;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }

  const encodedSessionKey = match[1];
  const attachmentId = match[2];
  const variant = match[3];
  if (!encodedSessionKey || !attachmentId || (variant !== "full" && variant !== "thumbnail")) {
    return false;
  }
  if (!MANAGED_OUTGOING_ATTACHMENT_ID_RE.test(attachmentId)) {
    sendStatus(res, 404, "not found");
    return true;
  }
  let sessionKey: string;
  try {
    sessionKey = decodeURIComponent(encodedSessionKey);
  } catch {
    sendStatus(res, 404, "not found");
    return true;
  }
  const hasValidMediaTicket = verifyManagedOutgoingImageTicket({
    ticket: requestUrl.searchParams.get("mediaTicket"),
    sessionKey,
    attachmentId,
  });
  if (!hasValidMediaTicket) {
    const requestAuth = await authorizeGatewayHttpRequestOrReply({
      req,
      res,
      auth: opts.auth,
      trustedProxies: opts.trustedProxies,
      allowRealIpFallback: opts.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
    });
    if (!requestAuth) {
      return true;
    }

    const requestedScopes = resolveOpenAiCompatibleHttpOperatorScopes(req, requestAuth);
    const scopeAuth = authorizeOperatorScopesForMethod("chat.history", requestedScopes);
    if (!scopeAuth.allowed) {
      sendMissingScopeForbidden(res, scopeAuth.missingScope);
      return true;
    }
    // The reusable shared-secret route remains for older Control UI clients.
    // Ticketed clients prove the exact transcript attachment instead of
    // forwarding an owner credential through another HTTP stack.
    if (!resolveOpenAiCompatibleHttpSenderIsOwner(req, requestAuth)) {
      sendJson(res, 403, {
        ok: false,
        error: {
          type: "forbidden",
          message: "owner access required",
        },
      });
      return true;
    }
  }
  const stateDir = opts.stateDir ?? resolveStateDir();
  const record = readManagedImageRecord(attachmentId, stateDir);
  if (!record || record.sessionKey !== sessionKey) {
    sendStatus(res, 404, "not found");
    return true;
  }
  if (
    (await recordMatchesTranscriptMessage(record, undefined, undefined, undefined, stateDir)) !==
    "match"
  ) {
    sendStatus(res, 404, "not found");
    return true;
  }

  let opened: Awaited<ReturnType<typeof openLocalFileSafely>>;
  try {
    opened = await openLocalFileSafely({
      filePath: resolveManagedImageOriginalPath(record),
    });
  } catch {
    sendStatus(res, 404, "not found");
    return true;
  }
  const respondNotFound = () => sendStatus(res, 404, "not found");

  let responseContentType = record.original.contentType || "application/octet-stream";
  let responseFilename = record.original.filename;
  const mediaKind = resolveManagedRecordKind(record);
  if (variant === "thumbnail") {
    if (mediaKind !== "image") {
      await opened.handle.close();
      sendStatus(res, 404, "not found");
      return true;
    }
    try {
      // A full-image ticket already authorizes these original bytes; the thumbnail
      // is a lower-fidelity representation of the same transcript attachment.
      const cacheKey = `${opened.realPath}\0${opened.stat.mtimeMs}\0${opened.stat.size}`;
      const thumbnail = await resolveManagedImageThumbnail(cacheKey, async () => {
        const source = await opened.handle.readFile();
        return (
          await createImageProcessor().encode(source, {
            format: "png",
            resize: { maxSide: MANAGED_IMAGE_THUMBNAIL_MAX_SIDE, enlarge: false },
            compressionLevel: 8,
          })
        ).data;
      });
      await opened.handle.close();
      const sourceName = path.parse(responseFilename ?? "generated-image").name;
      res.statusCode = 200;
      res.setHeader("content-type", "image/png");
      res.setHeader("content-length", String(thumbnail.byteLength));
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader(
        "cache-control",
        hasValidMediaTicket
          ? `private, max-age=${MANAGED_OUTGOING_IMAGE_TICKET_TTL_MS / 1000}, immutable`
          : "private, max-age=31536000, immutable",
      );
      res.setHeader(
        "content-disposition",
        buildManagedMediaContentDisposition(`${sourceName}-thumbnail.png`, "image/png"),
      );
      res.end(req.method === "HEAD" ? undefined : thumbnail);
      return true;
    } catch {
      await opened.handle.close().catch(() => {});
      sendStatus(res, 404, "not found");
      return true;
    }
  }

  let byteStream = createGatewayByteStream(res, opened.handle, respondNotFound);
  if (
    requestUrl.searchParams.get("playback") === "1" &&
    (mediaKind === "audio" || mediaKind === "video")
  ) {
    const playback = await resolvePlaybackTranscode({
      sourcePath: opened.realPath,
      sourceStat: opened.stat,
      mimeType: responseContentType,
      kind: mediaKind,
    }).catch(async (error: unknown) => {
      await byteStream.close();
      throw error;
    });
    if (playback.kind === "preparing") {
      await byteStream.close();
      sendJson(res, 202, { status: "preparing" });
      return true;
    }
    if (playback.kind === "transcoded") {
      const transcoded = await openLocalFileSafely({ filePath: playback.path }).catch(() => null);
      if (transcoded) {
        await byteStream.close();
        opened = transcoded;
        byteStream = createGatewayByteStream(res, opened.handle, respondNotFound);
        responseContentType = playback.contentType;
        responseFilename = replacePlaybackFileExtension(
          responseFilename ?? "generated-media",
          playback.extension,
        );
      }
    }
  }

  res.setHeader("content-type", responseContentType);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader(
    "cache-control",
    hasValidMediaTicket
      ? `private, max-age=${MANAGED_OUTGOING_IMAGE_TICKET_TTL_MS / 1000}, immutable`
      : "private, max-age=31536000, immutable",
  );
  res.setHeader(
    "content-disposition",
    buildManagedMediaContentDisposition(responseFilename, responseContentType),
  );
  const byteResponse = resolveByteResponse({
    file: opened.stat,
    method: req.method,
    request: req,
  });
  writeByteHeaders(res, byteResponse);
  // Stream from the verified descriptor so a path swap cannot bypass fs-safe after validation.
  await byteStream.pipe(byteResponse, req.method);
  return true;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
