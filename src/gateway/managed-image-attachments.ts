// Gateway managed image attachment store.
// Validates, stores, serves, and cleans up outgoing image attachments.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  asDateTimestampMs,
  resolveTimestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { readLocalFileSafely } from "../infra/fs-safe.js";
import { assertLocalMediaAllowed, resolveLocalMediaRoots } from "../media/local-media-access.js";
import { resolveLocalMediaPath } from "../media/local-media-path.js";
import {
  createImageProcessor,
  getImageMetadata,
  readImageProbeFromHeader,
} from "../media/media-services.js";
import { getMediaDir, MEDIA_MAX_BYTES, saveMediaBuffer, saveMediaSource } from "../media/store.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
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
import { readSessionMessagesWithSourceAsync } from "./session-transcript-readers.js";
import {
  loadSessionEntryReadOnly,
  resolveSessionHistoryTranscriptPathAsync,
} from "./session-utils.js";

const OUTGOING_IMAGE_ROUTE_PREFIX = "/api/chat/media/outgoing";
const DEFAULT_TRANSIENT_OUTGOING_IMAGE_TTL_MS = 15 * 60 * 1000;
const MANAGED_OUTGOING_IMAGE_TICKET_SCOPE = "managed-outgoing-image";
export const MANAGED_OUTGOING_IMAGE_TICKET_TTL_MS = 5 * 60 * 1000;
export const MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX = "artifact_managed_image_";
const MANAGED_OUTGOING_ATTACHMENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const managedOutgoingImageTicketSecret = randomBytes(32);

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

type ParsedImageDataUrl =
  | { kind: "not-data-url" }
  | { kind: "non-image-data-url" }
  | { kind: "image-data-url"; buffer: Buffer; contentType: string };

type ManagedImageBlock = Record<string, unknown>;

type CleanupManagedOutgoingImageRecordsResult = {
  deletedRecordCount: number;
  deletedFileCount: number;
  retainedCount: number;
};

type SessionManagedOutgoingAttachmentIndex = Set<string>;

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

export type ManagedOutgoingImageArtifactDownload = {
  artifactId: string;
  sessionKey: string;
  title: string;
  mimeType?: string;
  sizeBytes?: number;
  url: string;
  expiresAt: string;
};
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

function getSanitizedManagedImageAttachmentError(error: unknown, alt: string): Error {
  if (isManagedImageAttachmentSafeError(error)) {
    return error;
  }
  return createManagedImageAttachmentError(
    `Managed image attachment ${JSON.stringify(alt)} could not be prepared`,
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

function buildManagedOutgoingImageArtifactId(attachmentId: string): string {
  return `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${attachmentId}`;
}

export function parseManagedOutgoingImageArtifactId(value: string): string | null {
  if (!value.startsWith(MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX)) {
    return null;
  }
  const attachmentId = value.slice(MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX.length);
  return MANAGED_OUTGOING_ATTACHMENT_ID_RE.test(attachmentId) ? attachmentId : null;
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

function parseImageDataUrl(
  source: string,
  alt: string,
  limits: ManagedImageAttachmentLimits,
): ParsedImageDataUrl {
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

  if (!contentType.startsWith("image/")) {
    return { kind: "non-image-data-url" };
  }

  if (estimateBase64DecodedByteLength(base64Part) > limits.maxBytes) {
    throw createManagedImageAttachmentError(
      `Managed image attachment ${JSON.stringify(alt)} exceeds the ${formatLimitMiB(limits.maxBytes)} byte limit`,
    );
  }

  return {
    kind: "image-data-url",
    buffer: Buffer.from(base64Part.replace(/\s+/g, ""), "base64"),
    contentType,
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

export async function cleanupManagedOutgoingImageRecords(params?: {
  stateDir?: string;
  nowMs?: number;
  transientMaxAgeMs?: number;
  sessionKey?: string;
  agentId?: string;
  forceDeleteSessionRecords?: boolean;
}): Promise<CleanupManagedOutgoingImageRecordsResult> {
  const stateDir = params?.stateDir ?? resolveStateDir();
  const nowMs = params?.nowMs ?? Date.now();
  const transientMaxAgeMs = params?.transientMaxAgeMs ?? DEFAULT_TRANSIENT_OUTGOING_IMAGE_TTL_MS;
  const sessionKeyFilter = params?.sessionKey ?? null;
  const agentIdFilter = params?.agentId?.trim() || undefined;
  const defaultAgentId =
    sessionKeyFilter === "global" ? resolveDefaultAgentId(getRuntimeConfig()) : undefined;
  const forceDeleteSessionRecords = params?.forceDeleteSessionRecords === true;
  const entries = listManagedImageRecordEntries({ stateDir });

  let deletedRecordCount = 0;
  let deletedFileCount = 0;
  let retainedCount = 0;
  const transcriptAttachmentIndexCache = new Map<
    string,
    SessionManagedOutgoingAttachmentIndex | null
  >();
  for (const entry of entries) {
    const { record } = entry;
    if (sessionKeyFilter && record.sessionKey !== sessionKeyFilter) {
      retainedCount += 1;
      continue;
    }
    if (
      sessionKeyFilter === "global" &&
      record.sessionKey === "global" &&
      ((agentIdFilter &&
        resolveManagedImageRecordAgentId(record, defaultAgentId) !== agentIdFilter) ||
        (!agentIdFilter && typeof record.agentId === "string" && record.agentId.trim()))
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
      shouldDelete = !(await recordMatchesTranscriptMessage(
        record,
        transcriptAttachmentIndexCache,
      ));
    } else if (!entry.cleanupPending) {
      const createdAtMs = Date.parse(record.createdAt);
      shouldDelete = Number.isFinite(createdAtMs) && nowMs - createdAtMs >= transientMaxAgeMs;
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

function resolveManagedImageRecordAgentId(
  record: ManagedImageRecord,
  defaultAgentId: string | undefined,
): string | undefined {
  const explicitAgentId = record.agentId?.trim();
  return explicitAgentId || defaultAgentId;
}

function buildManagedImageBlock(record: ManagedImageRecord): ManagedImageBlock {
  const fullUrl = buildOutgoingVariantUrl(record.sessionKey, record.attachmentId, "full");
  return {
    type: "image",
    artifactId: buildManagedOutgoingImageArtifactId(record.attachmentId),
    url: fullUrl,
    openUrl: fullUrl,
    alt: record.alt,
    mimeType: record.original.contentType,
    width: record.original.width,
    height: record.original.height,
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
}): ManagedImageBlock {
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
    if (block?.type !== "image") {
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
  while (
    sessionManagedOutgoingAttachmentIndexCache.size >
    MAX_SESSION_MANAGED_OUTGOING_ATTACHMENT_INDEX_CACHE_ENTRIES
  ) {
    const oldestKey = sessionManagedOutgoingAttachmentIndexCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    sessionManagedOutgoingAttachmentIndexCache.delete(oldestKey);
  }
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
) {
  const cacheKey = buildSessionManagedOutgoingAttachmentIndexCacheKey(sessionKey, agentId);
  if (cache?.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }
  const { storePath, entry } = loadSessionEntryReadOnly(
    sessionKey,
    sessionKey === "global" && agentId ? { agentId } : undefined,
  );
  const sessionId = entry?.sessionId;
  if (!sessionId) {
    cache?.set(cacheKey, null);
    return null;
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
        return cachedIndex;
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
  return index;
}

async function recordMatchesTranscriptMessage(
  record: ManagedImageRecord,
  cache?: Map<string, SessionManagedOutgoingAttachmentIndex | null>,
) {
  if (!record.messageId) {
    return false;
  }
  const index = await getSessionManagedOutgoingAttachmentIndex(
    record.sessionKey,
    cache,
    record.agentId,
  );
  return (
    index?.has(buildManagedOutgoingAttachmentRefKey(record.messageId, record.attachmentId)) ?? false
  );
}

async function resolveManagedOutgoingImageArtifactDownloadForRecord(
  record: ManagedImageRecord,
): Promise<ManagedOutgoingImageArtifactDownload | null> {
  if (!(await recordMatchesTranscriptMessage(record))) {
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
    artifactId: buildManagedOutgoingImageArtifactId(record.attachmentId),
    sessionKey: record.sessionKey,
    title: record.alt,
    ...(record.original.contentType ? { mimeType: record.original.contentType } : {}),
    ...(record.original.sizeBytes != null ? { sizeBytes: record.original.sizeBytes } : {}),
    url: `${canonicalUrl}?${params.toString()}`,
    expiresAt: ticket.expiresAt,
  };
}

/** Resolve one transcript-backed image to a short-lived HTTP capability. */
export async function resolveManagedOutgoingImageArtifactDownload(params: {
  sessionKey: string;
  artifactId: string;
  stateDir?: string;
}): Promise<ManagedOutgoingImageArtifactDownload | null> {
  const attachmentId = parseManagedOutgoingImageArtifactId(params.artifactId);
  if (!attachmentId) {
    return null;
  }
  const record = readManagedImageRecord(attachmentId, params.stateDir);
  if (!record || record.sessionKey !== params.sessionKey) {
    return null;
  }
  return await resolveManagedOutgoingImageArtifactDownloadForRecord(record);
}

/** Upgrade legacy managed-image URLs that predate stable artifact ids. */
export async function resolveManagedOutgoingImageUrlDownload(params: {
  sessionKey: string;
  url: string;
  stateDir?: string;
}): Promise<ManagedOutgoingImageArtifactDownload | null> {
  const parsed = parseManagedOutgoingRoute(params.url);
  if (!parsed || parsed.sessionKey !== params.sessionKey) {
    return null;
  }
  const record = readManagedImageRecord(parsed.attachmentId, params.stateDir);
  if (!record || record.sessionKey !== params.sessionKey) {
    return null;
  }
  return await resolveManagedOutgoingImageArtifactDownloadForRecord(record);
}

export async function attachManagedOutgoingImagesToMessage(params: {
  messageId: string;
  blocks?: readonly Record<string, unknown>[];
  stateDir?: string;
}) {
  const messageId = params.messageId.trim();
  if (!messageId) {
    return;
  }
  const refs = collectManagedOutgoingAttachmentRefs(params.blocks);
  if (refs.length === 0) {
    return;
  }
  await Promise.all(
    refs.map(async ({ attachmentId, sessionKey }) => {
      attachManagedImageRecordToMessage({
        attachmentId,
        sessionKey,
        messageId,
        updatedAt: new Date().toISOString(),
        stateDir: params.stateDir,
      });
    }),
  );
}

export async function createManagedOutgoingImageBlocks(params: {
  sessionKey: string;
  agentId?: string;
  mediaUrls?: string[] | null;
  stateDir?: string;
  messageId?: string | null;
  limits?: ManagedImageAttachmentLimitsConfig | null;
  localRoots?: readonly string[] | "any";
  continueOnPrepareError?: boolean;
  onPrepareError?: (error: Error) => void;
}): Promise<ManagedImageBlock[]> {
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
  const blocks: ManagedImageBlock[] = [];
  let resolvedLocalRoots: readonly string[] | undefined;
  for (const [index, mediaUrl] of mediaUrls.entries()) {
    const fallbackAlt = `Generated image ${index + 1}`;
    const parsedDataUrl = parseImageDataUrl(mediaUrl, fallbackAlt, limits);
    const localMediaPath =
      parsedDataUrl.kind === "image-data-url" ? undefined : resolveLocalMediaPath(mediaUrl);
    const alt =
      parsedDataUrl.kind === "image-data-url"
        ? fallbackAlt
        : deriveAltText(localMediaPath ?? mediaUrl, index);
    if (parsedDataUrl.kind === "non-image-data-url") {
      continue;
    }

    let savedOriginalPath: string | null = null;
    try {
      let resizeWarning: ManagedImageBlock | null = null;
      if (parsedDataUrl.kind === "image-data-url") {
        validateManagedImageBuffer(parsedDataUrl.buffer, alt, limits);
      }
      let savedOriginal =
        parsedDataUrl.kind === "image-data-url"
          ? await saveMediaBuffer(
              parsedDataUrl.buffer,
              parsedDataUrl.contentType,
              "outgoing/originals",
              limits.maxBytes,
              `generated-image-${index + 1}`,
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
                Math.max(limits.maxBytes, MEDIA_MAX_BYTES),
              );
            })();
      savedOriginalPath = savedOriginal.path;
      let savedOriginalContentType = savedOriginal.contentType;
      if (!savedOriginalContentType?.startsWith("image/")) {
        await fs.rm(savedOriginal.path, { force: true }).catch(() => {});
        savedOriginalPath = null;
        continue;
      }
      if (savedOriginal.size > limits.maxBytes) {
        throw createManagedImageAttachmentError(
          `Managed image attachment ${JSON.stringify(alt)} exceeds the ${formatLimitMiB(limits.maxBytes)} byte limit`,
        );
      }

      let originalBuffer =
        parsedDataUrl.kind === "image-data-url"
          ? parsedDataUrl.buffer
          : (await readLocalFileSafely({ filePath: savedOriginal.path })).buffer;
      validateManagedImageBuffer(originalBuffer, alt, limits);

      let originalStats = await getVariantStats({
        filePath: savedOriginal.path,
        buffer: originalBuffer,
        sizeBytes: savedOriginal.size,
      });
      if (originalStats.sizeBytes != null && originalStats.sizeBytes > limits.maxBytes) {
        throw createManagedImageAttachmentError(
          `Managed image attachment ${JSON.stringify(alt)} exceeds the ${formatLimitMiB(limits.maxBytes)} byte limit`,
        );
      }

      const originalMetadata =
        originalStats.width != null && originalStats.height != null
          ? { width: originalStats.width, height: originalStats.height }
          : await getImageMetadata(originalBuffer);
      const originalDisplayMetadata = orientManagedImageMetadata(originalBuffer, originalMetadata);
      let effectiveMetadata = originalDisplayMetadata;
      let metadataLimitError = getManagedImageMetadataLimitError(effectiveMetadata, alt, limits);
      for (let resizeAttempt = 0; metadataLimitError; resizeAttempt += 1) {
        if (!effectiveMetadata) {
          throw createManagedImageAttachmentError(metadataLimitError);
        }
        if (resizeAttempt >= 3) {
          throw createManagedImageAttachmentError(metadataLimitError);
        }
        const resized = await resizeManagedImageBufferToLimits({
          buffer: originalBuffer,
          limits,
        });
        validateManagedImageBuffer(resized.buffer, alt, limits);
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
        metadataLimitError = getManagedImageMetadataLimitError(effectiveMetadata, alt, limits);
        if (!metadataLimitError) {
          resizeWarning = buildManagedImageResizeWarningBlock({
            alt,
            originalWidth:
              originalDisplayMetadata?.width ?? effectiveMetadata?.width ?? resized.width,
            originalHeight:
              originalDisplayMetadata?.height ?? effectiveMetadata?.height ?? resized.height,
            resizedWidth: effectiveMetadata?.width ?? resized.width,
            resizedHeight: effectiveMetadata?.height ?? resized.height,
          });
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
        alt,
        original: {
          mediaRoot: path.dirname(path.dirname(path.dirname(path.resolve(savedOriginal.path)))),
          mediaId: savedOriginal.id,
          mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
          contentType: savedOriginalContentType,
          width: originalStats.width,
          height: originalStats.height,
          sizeBytes: originalStats.sizeBytes,
          filename: toRecordFilename(savedOriginal.path),
        },
      };
      insertManagedImageRecord(record, stateDir);
      blocks.push(buildManagedImageBlock(record));
      if (resizeWarning) {
        blocks.push(resizeWarning);
      }
    } catch (error) {
      if (savedOriginalPath) {
        await fs.rm(savedOriginalPath, { force: true }).catch(() => {});
      }
      const sanitizedError = getSanitizedManagedImageAttachmentError(error, alt);
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

function safeAttachmentFilename(value: string | null) {
  const fallback = "generated-image";
  const base = (value ?? fallback).replace(/[\r\n"\\]/g, "_").trim();
  return base || fallback;
}

export async function handleManagedOutgoingImageHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
    stateDir?: string;
  },
): Promise<boolean> {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const match = requestUrl.pathname.match(/^\/api\/chat\/media\/outgoing\/([^/]+)\/([^/]+)\/full$/);
  if (!match) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  const encodedSessionKey = match[1];
  const attachmentId = match[2];
  if (!encodedSessionKey || !attachmentId) {
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
  const record = readManagedImageRecord(attachmentId, opts.stateDir);
  if (!record || record.sessionKey !== sessionKey) {
    sendStatus(res, 404, "not found");
    return true;
  }
  if (!(await recordMatchesTranscriptMessage(record))) {
    sendStatus(res, 404, "not found");
    return true;
  }

  let body: Buffer;
  try {
    body = (
      await readLocalFileSafely({
        filePath: resolveManagedImageOriginalPath(record),
      })
    ).buffer;
  } catch {
    sendStatus(res, 404, "not found");
    return true;
  }

  res.statusCode = 200;
  res.setHeader("content-type", record.original.contentType || "application/octet-stream");
  res.setHeader("content-length", String(body.byteLength));
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
    `inline; filename="${safeAttachmentFilename(record.original.filename)}"`,
  );
  res.end(body);
  return true;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
