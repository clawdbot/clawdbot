import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { getLatestSubagentRunByChildSessionKey } from "../agents/subagent-registry.js";
import { resolveStateDir } from "../config/paths.js";
import { safeFileURLToPath } from "../infra/local-file-access.js";
import {
  getImageMetadata,
  hasAlphaChannel,
  resizeToJpeg,
  resizeToPng,
} from "../media/image-ops.js";
import { assertLocalMediaAllowed } from "../media/local-media-access.js";
import { isPassThroughRemoteMediaSource } from "../media/media-source-url.js";
import { MEDIA_MAX_BYTES, saveMediaBuffer, saveMediaSource } from "../media/store.js";
import { resolveUserPath } from "../utils.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";
import {
  authorizeGatewayHttpRequestOrReply,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { loadSessionEntry, readSessionMessages } from "./session-utils.js";

const OUTGOING_IMAGE_ROUTE_PREFIX = "/api/chat/media/outgoing";
const DEFAULT_TRANSIENT_OUTGOING_IMAGE_TTL_MS = 15 * 60 * 1000;
const MANAGED_OUTGOING_ATTACHMENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATA_URL_RE = /^data:/i;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

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

type ManagedImageRecordVariant = {
  path: string;
  contentType: string;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  filename: string | null;
};

type ManagedImageRetentionClass = "transient" | "history";

type ManagedImageRecord = {
  attachmentId: string;
  sessionKey: string;
  messageId: string | null;
  createdAt: string;
  updatedAt?: string;
  retentionClass?: ManagedImageRetentionClass;
  alt: string;
  original: ManagedImageRecordVariant;
};

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

const sessionManagedOutgoingAttachmentIndexCache = new Map<
  string,
  SessionManagedOutgoingAttachmentIndexCacheEntry
>();
const MAX_SESSION_MANAGED_OUTGOING_ATTACHMENT_INDEX_CACHE_ENTRIES = 500;

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

function computeManagedImageResizeTarget(
  metadata: { width: number; height: number },
  limits: ManagedImageAttachmentLimits,
): { width: number; height: number } | null {
  const scale = Math.min(
    1,
    limits.maxWidth / metadata.width,
    limits.maxHeight / metadata.height,
    Math.sqrt(limits.maxPixels / (metadata.width * metadata.height)),
  );
  if (!Number.isFinite(scale) || scale >= 1) {
    return null;
  }

  let width = Math.max(1, Math.floor(metadata.width * scale));
  let height = Math.max(1, Math.floor(metadata.height * scale));
  while (
    width > limits.maxWidth ||
    height > limits.maxHeight ||
    width * height > limits.maxPixels
  ) {
    if (width >= height && width > 1) {
      width -= 1;
    } else if (height > 1) {
      height -= 1;
    } else {
      break;
    }
  }
  return { width, height };
}

async function resizeManagedImageBufferToLimits(params: {
  buffer: Buffer;
  contentType: string;
  metadata: { width: number; height: number };
  limits: ManagedImageAttachmentLimits;
}): Promise<{ buffer: Buffer; contentType: string; width: number; height: number }> {
  const target = computeManagedImageResizeTarget(params.metadata, params.limits);
  if (!target) {
    return {
      buffer: params.buffer,
      contentType: params.contentType,
      width: params.metadata.width,
      height: params.metadata.height,
    };
  }

  const preserveAlpha = await hasAlphaChannel(params.buffer).catch(() => false);
  const resizedBuffer = preserveAlpha
    ? await resizeToPng({
        buffer: params.buffer,
        maxSide: Math.max(target.width, target.height),
        compressionLevel: 9,
        withoutEnlargement: true,
      })
    : await resizeToJpeg({
        buffer: params.buffer,
        maxSide: Math.max(target.width, target.height),
        quality: 92,
        withoutEnlargement: true,
      });

  return {
    buffer: resizedBuffer,
    contentType: preserveAlpha ? "image/png" : "image/jpeg",
    width: target.width,
    height: target.height,
  };
}

function resolveOutgoingRecordsDir(stateDir = resolveStateDir()) {
  return path.join(stateDir, "media", "outgoing", "records");
}

function resolveOutgoingOriginalsDir(stateDir = resolveStateDir()) {
  return path.join(stateDir, "media", "outgoing", "originals");
}

function resolveOutgoingRecordPath(attachmentId: string, stateDir = resolveStateDir()) {
  return path.join(resolveOutgoingRecordsDir(stateDir), `${attachmentId}.json`);
}

function buildOutgoingVariantUrl(sessionKey: string, attachmentId: string, variant: "full") {
  return `${OUTGOING_IMAGE_ROUTE_PREFIX}/${encodeURIComponent(sessionKey)}/${attachmentId}/${variant}`;
}

function resolveRequesterSessionKey(req: IncomingMessage) {
  const raw = req.headers["x-openclaw-requester-session-key"];
  if (Array.isArray(raw)) {
    return raw[0]?.trim() || null;
  }
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

async function requesterOwnsManagedImageSession(params: {
  requesterSessionKey: string;
  targetSessionKey: string;
}) {
  if (params.requesterSessionKey === params.targetSessionKey) {
    return true;
  }
  const subagentRun = getLatestSubagentRunByChildSessionKey(params.targetSessionKey);
  if (!subagentRun) {
    return false;
  }
  return (
    subagentRun.requesterSessionKey === params.requesterSessionKey ||
    subagentRun.controllerSessionKey === params.requesterSessionKey
  );
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

function resolveLocalMediaPath(source: string): string | undefined {
  const trimmed = source.trim();
  if (!trimmed || isPassThroughRemoteMediaSource(trimmed) || DATA_URL_RE.test(trimmed)) {
    return undefined;
  }
  if (trimmed.startsWith("file://")) {
    try {
      return safeFileURLToPath(trimmed);
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("~")) {
    return resolveUserPath(trimmed);
  }
  if (path.isAbsolute(trimmed) || WINDOWS_DRIVE_RE.test(trimmed)) {
    return path.resolve(trimmed);
  }
  return undefined;
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
  const match = /^data:([^;,]+)(?:;[^,]*)*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed);
  if (!match) {
    throw new Error("Invalid image data URL");
  }
  const contentType = match[1]?.trim().toLowerCase() ?? "";
  if (!contentType.startsWith("image/")) {
    return { kind: "non-image-data-url" };
  }
  if (estimateBase64DecodedByteLength(match[2]) > limits.maxBytes) {
    throw createManagedImageAttachmentError(
      `Managed image attachment ${JSON.stringify(alt)} exceeds the ${formatLimitMiB(limits.maxBytes)} byte limit`,
    );
  }
  return {
    kind: "image-data-url",
    buffer: Buffer.from(match[2].replace(/\s+/g, ""), "base64"),
    contentType,
  };
}

async function getVariantStats(filePath: string) {
  const [stats, metadataBuffer] = await Promise.all([fs.stat(filePath), fs.readFile(filePath)]);
  const metadata = (await getImageMetadata(metadataBuffer).catch(() => null)) ?? {
    width: null,
    height: null,
  };
  return {
    width: metadata.width ?? null,
    height: metadata.height ?? null,
    sizeBytes: Number.isFinite(stats.size) ? stats.size : null,
  };
}

async function writeManagedImageRecord(record: ManagedImageRecord, stateDir = resolveStateDir()) {
  const recordPath = resolveOutgoingRecordPath(record.attachmentId, stateDir);
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(recordPath, JSON.stringify(record, null, 2), "utf-8");
}

async function deleteManagedImageRecordArtifacts(
  record: ManagedImageRecord,
  stateDir = resolveStateDir(),
) {
  const files = new Set<string>();
  if (record.original?.path) {
    files.add(record.original.path);
  }
  let deletedFileCount = 0;
  for (const filePath of files) {
    try {
      await fs.rm(filePath, { force: true });
      deletedFileCount += 1;
    } catch {
      // Ignore cleanup races or already-missing files.
    }
  }
  try {
    await fs.rm(resolveOutgoingRecordPath(record.attachmentId, stateDir), { force: true });
  } catch {
    // Ignore cleanup races or already-missing records.
  }
  return deletedFileCount;
}

async function deleteOrphanManagedImageFiles(params: {
  stateDir: string;
  referencedPaths: ReadonlySet<string>;
}) {
  let deletedFileCount = 0;
  for (const dir of [resolveOutgoingOriginalsDir(params.stateDir)]) {
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const filePath = path.join(dir, name);
      if (params.referencedPaths.has(filePath)) {
        continue;
      }
      try {
        const stats = await fs.stat(filePath);
        if (!stats.isFile()) {
          continue;
        }
      } catch {
        continue;
      }
      try {
        await fs.rm(filePath, { force: true });
        deletedFileCount += 1;
      } catch {
        // Ignore cleanup races or already-missing files.
      }
    }
  }
  return deletedFileCount;
}

export async function cleanupManagedOutgoingImageRecords(params?: {
  stateDir?: string;
  nowMs?: number;
  transientMaxAgeMs?: number;
  sessionKey?: string;
  forceDeleteSessionRecords?: boolean;
}): Promise<CleanupManagedOutgoingImageRecordsResult> {
  const stateDir = params?.stateDir ?? resolveStateDir();
  const nowMs = params?.nowMs ?? Date.now();
  const transientMaxAgeMs = params?.transientMaxAgeMs ?? DEFAULT_TRANSIENT_OUTGOING_IMAGE_TTL_MS;
  const sessionKeyFilter = params?.sessionKey ?? null;
  const forceDeleteSessionRecords = params?.forceDeleteSessionRecords === true;
  const recordsDir = resolveOutgoingRecordsDir(stateDir);
  let names: string[] = [];
  try {
    names = await fs.readdir(recordsDir);
  } catch {
    names = [];
  }

  let deletedRecordCount = 0;
  let deletedFileCount = 0;
  let retainedCount = 0;
  const retainedReferencedPaths = new Set<string>();
  const transcriptAttachmentIndexCache = new Map<
    string,
    SessionManagedOutgoingAttachmentIndex | null
  >();
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const recordPath = path.join(recordsDir, name);
    let record: ManagedImageRecord;
    try {
      record = JSON.parse(await fs.readFile(recordPath, "utf-8")) as ManagedImageRecord;
    } catch {
      try {
        await fs.rm(recordPath, { force: true });
      } catch {
        // Ignore cleanup races or already-missing records.
      }
      deletedRecordCount += 1;
      continue;
    }
    if (sessionKeyFilter && record.sessionKey !== sessionKeyFilter) {
      if (record.original?.path) {
        retainedReferencedPaths.add(record.original.path);
      }
      retainedCount += 1;
      continue;
    }

    let shouldDelete = false;
    if (
      forceDeleteSessionRecords &&
      (!sessionKeyFilter || record.sessionKey === sessionKeyFilter)
    ) {
      shouldDelete = true;
    } else if (record.messageId) {
      shouldDelete = !(await recordMatchesTranscriptMessage(
        record,
        transcriptAttachmentIndexCache,
      ));
    } else {
      const createdAtMs = Date.parse(record.createdAt);
      shouldDelete = Number.isFinite(createdAtMs) && nowMs - createdAtMs >= transientMaxAgeMs;
    }

    if (shouldDelete) {
      deletedRecordCount += 1;
      deletedFileCount += await deleteManagedImageRecordArtifacts(record, stateDir);
    } else {
      if (record.original?.path) {
        retainedReferencedPaths.add(record.original.path);
      }
      retainedCount += 1;
    }
  }

  deletedFileCount += await deleteOrphanManagedImageFiles({
    stateDir,
    referencedPaths: retainedReferencedPaths,
  });

  return { deletedRecordCount, deletedFileCount, retainedCount };
}

async function readManagedImageRecord(
  attachmentId: string,
  stateDir = resolveStateDir(),
): Promise<ManagedImageRecord | null> {
  try {
    const raw = await fs.readFile(resolveOutgoingRecordPath(attachmentId, stateDir), "utf-8");
    return JSON.parse(raw) as ManagedImageRecord;
  } catch {
    return null;
  }
}

function buildManagedImageBlock(record: ManagedImageRecord): ManagedImageBlock {
  const fullUrl = buildOutgoingVariantUrl(record.sessionKey, record.attachmentId, "full");
  return {
    type: "image",
    url: fullUrl,
    openUrl: fullUrl,
    alt: record.alt,
    mimeType: record.original.contentType,
    width: record.original.width,
    height: record.original.height,
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
    if (!MANAGED_OUTGOING_ATTACHMENT_ID_RE.test(match[2])) {
      return null;
    }
    return {
      sessionKey: decodeURIComponent(match[1]),
      attachmentId: match[2],
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
      refs.set(parsed.attachmentId, {
        attachmentId: parsed.attachmentId,
        sessionKey: parsed.sessionKey,
      });
    }
  }
  return [...refs.values()];
}

function getCachedSessionManagedOutgoingAttachmentIndex(
  sessionKey: string,
  stat: { transcriptPath: string; mtimeMs: number; size: number },
) {
  const cached = sessionManagedOutgoingAttachmentIndexCache.get(sessionKey);
  if (!cached) {
    return null;
  }
  if (
    cached.transcriptPath !== stat.transcriptPath ||
    cached.mtimeMs !== stat.mtimeMs ||
    cached.size !== stat.size
  ) {
    sessionManagedOutgoingAttachmentIndexCache.delete(sessionKey);
    return null;
  }
  sessionManagedOutgoingAttachmentIndexCache.delete(sessionKey);
  sessionManagedOutgoingAttachmentIndexCache.set(sessionKey, cached);
  return cached.index;
}

function setCachedSessionManagedOutgoingAttachmentIndex(
  sessionKey: string,
  stat: { transcriptPath: string; mtimeMs: number; size: number },
  index: SessionManagedOutgoingAttachmentIndex,
) {
  sessionManagedOutgoingAttachmentIndexCache.set(sessionKey, {
    transcriptPath: stat.transcriptPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    index,
  });
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

async function getSessionManagedOutgoingAttachmentIndex(
  sessionKey: string,
  cache?: Map<string, SessionManagedOutgoingAttachmentIndex | null>,
) {
  if (cache?.has(sessionKey)) {
    return cache.get(sessionKey) ?? null;
  }
  const { storePath, entry } = loadSessionEntry(sessionKey);
  const sessionId = entry?.sessionId;
  if (!sessionId) {
    cache?.set(sessionKey, null);
    return null;
  }

  let transcriptStat: { transcriptPath: string; mtimeMs: number; size: number } | null = null;
  const transcriptPath = typeof entry?.sessionFile === "string" ? entry.sessionFile.trim() : "";
  if (transcriptPath) {
    try {
      const stat = await fs.stat(transcriptPath);
      transcriptStat = {
        transcriptPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
      const cachedIndex = getCachedSessionManagedOutgoingAttachmentIndex(
        sessionKey,
        transcriptStat,
      );
      if (cachedIndex) {
        cache?.set(sessionKey, cachedIndex);
        return cachedIndex;
      }
    } catch {
      sessionManagedOutgoingAttachmentIndexCache.delete(sessionKey);
    }
  }

  const messages = readSessionMessages(sessionId, storePath, entry.sessionFile);
  const index: SessionManagedOutgoingAttachmentIndex = new Set();
  for (const message of messages) {
    const meta = (message as { __openclaw?: { id?: string } } | null)?.__openclaw;
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
    setCachedSessionManagedOutgoingAttachmentIndex(sessionKey, transcriptStat, index);
  }
  cache?.set(sessionKey, index);
  return index;
}

async function recordMatchesTranscriptMessage(
  record: ManagedImageRecord,
  cache?: Map<string, SessionManagedOutgoingAttachmentIndex | null>,
) {
  if (!record.messageId) {
    return false;
  }
  const index = await getSessionManagedOutgoingAttachmentIndex(record.sessionKey, cache);
  return (
    index?.has(buildManagedOutgoingAttachmentRefKey(record.messageId, record.attachmentId)) ?? false
  );
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
      const record = await readManagedImageRecord(attachmentId, params.stateDir);
      if (!record || record.sessionKey !== sessionKey) {
        return;
      }
      if (record.messageId === messageId && record.retentionClass === "history") {
        return;
      }
      await writeManagedImageRecord(
        {
          ...record,
          messageId,
          retentionClass: "history",
          updatedAt: new Date().toISOString(),
        },
        params.stateDir,
      );
    }),
  );
}

export async function createManagedOutgoingImageBlocks(params: {
  sessionKey: string;
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
  for (const [index, mediaUrl] of mediaUrls.entries()) {
    const fallbackAlt = `Generated image ${index + 1}`;
    const parsedDataUrl = parseImageDataUrl(mediaUrl, fallbackAlt, limits);
    const alt =
      parsedDataUrl.kind === "image-data-url" ? fallbackAlt : deriveAltText(mediaUrl, index);
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
              const localMediaPath = resolveLocalMediaPath(mediaUrl);
              if (localMediaPath) {
                await assertLocalMediaAllowed(localMediaPath, params.localRoots);
              }
              return await saveMediaSource(
                mediaUrl,
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
          : await fs.readFile(savedOriginal.path);
      validateManagedImageBuffer(originalBuffer, alt, limits);

      let originalStats = await getVariantStats(savedOriginal.path);
      if (originalStats.sizeBytes != null && originalStats.sizeBytes > limits.maxBytes) {
        throw createManagedImageAttachmentError(
          `Managed image attachment ${JSON.stringify(alt)} exceeds the ${formatLimitMiB(limits.maxBytes)} byte limit`,
        );
      }

      const originalMetadata =
        originalStats.width != null && originalStats.height != null
          ? { width: originalStats.width, height: originalStats.height }
          : await getImageMetadata(originalBuffer);
      let effectiveMetadata = originalMetadata;
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
          contentType: savedOriginalContentType,
          metadata: effectiveMetadata,
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
        originalStats = await getVariantStats(savedOriginal.path);
        effectiveMetadata =
          originalStats.width != null && originalStats.height != null
            ? { width: originalStats.width, height: originalStats.height }
            : await getImageMetadata(originalBuffer);
        metadataLimitError = getManagedImageMetadataLimitError(effectiveMetadata, alt, limits);
        if (!metadataLimitError) {
          resizeWarning = buildManagedImageResizeWarningBlock({
            alt,
            originalWidth: originalMetadata?.width ?? effectiveMetadata?.width ?? resized.width,
            originalHeight: originalMetadata?.height ?? effectiveMetadata?.height ?? resized.height,
            resizedWidth: effectiveMetadata?.width ?? resized.width,
            resizedHeight: effectiveMetadata?.height ?? resized.height,
          });
        }
      }

      const record: ManagedImageRecord = {
        attachmentId: randomUUID(),
        sessionKey,
        messageId: params.messageId ?? null,
        createdAt: new Date().toISOString(),
        retentionClass: params.messageId ? "history" : "transient",
        alt,
        original: {
          path: savedOriginal.path,
          contentType: savedOriginalContentType,
          width: originalStats.width,
          height: originalStats.height,
          sizeBytes: originalStats.sizeBytes,
          filename: toRecordFilename(savedOriginal.path),
        },
      };
      await writeManagedImageRecord(record, stateDir);
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

  const privilegedAccess =
    requestAuth.trustDeclaredOperatorScopes || requestAuth.authMethod === "device-token";

  const requestedScopes = resolveOpenAiCompatibleHttpOperatorScopes(req, requestAuth);
  const scopeAuth = authorizeOperatorScopesForMethod("chat.history", requestedScopes);
  if (!scopeAuth.allowed) {
    sendJson(res, 403, {
      ok: false,
      error: {
        type: "forbidden",
        message: `missing scope: ${scopeAuth.missingScope}`,
      },
    });
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
  const record = await readManagedImageRecord(attachmentId, opts.stateDir);
  if (!record || record.sessionKey !== sessionKey) {
    sendStatus(res, 404, "not found");
    return true;
  }
  if (!privilegedAccess) {
    const requesterSessionKey = resolveRequesterSessionKey(req);
    if (!requesterSessionKey) {
      sendJson(res, 403, {
        ok: false,
        error: {
          type: "forbidden",
          message: "requester session ownership required",
        },
      });
      return true;
    }
    const ownsSession = await requesterOwnsManagedImageSession({
      requesterSessionKey,
      targetSessionKey: record.sessionKey,
    });
    if (!ownsSession) {
      sendJson(res, 403, {
        ok: false,
        error: {
          type: "forbidden",
          message: "requester session does not own attachment session",
        },
      });
      return true;
    }
  }
  if (!(await recordMatchesTranscriptMessage(record))) {
    sendStatus(res, 404, "not found");
    return true;
  }

  let body: Buffer;
  try {
    body = await fs.readFile(record.original.path);
  } catch {
    sendStatus(res, 404, "not found");
    return true;
  }

  res.statusCode = 200;
  res.setHeader("content-type", record.original.contentType || "application/octet-stream");
  res.setHeader("content-length", String(body.byteLength));
  res.setHeader("cache-control", "private, max-age=31536000, immutable");
  res.setHeader(
    "content-disposition",
    `inline; filename="${safeAttachmentFilename(record.original.filename)}"`,
  );
  res.end(body);
  return true;
}
