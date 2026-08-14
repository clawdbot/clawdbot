// Synology Chat plugin module stages immutable outbound bytes for NAS attachment pickup.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mimeTypeFromFilePath, normalizeMimeType } from "openclaw/plugin-sdk/media-mime";
import { resolveExpiresAtMsFromDurationMs } from "openclaw/plugin-sdk/number-runtime";
import {
  buildHostedOutboundMediaResponseHeaders,
  createHostedOutboundMediaStore,
  type HostedOutboundMediaChunkRecord,
  type HostedOutboundMediaEntry,
  type HostedOutboundMediaMetaRecord,
  type HostedOutboundMediaStore,
  type OutboundMediaLoadOptions,
} from "openclaw/plugin-sdk/outbound-media";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { createWebhookInFlightLimiter } from "openclaw/plugin-sdk/webhook-ingress";
import {
  resolveSynologyHostedMediaRoute,
  SYNOLOGY_HOSTED_MEDIA_TOKEN_PARAM_PREFIX,
  toSynologyHostedMediaStoreRoutePath,
} from "./hosted-media-route.js";
import { getSynologyRuntime } from "./runtime.js";
import type { ResolvedSynologyChatAccount } from "./types.js";

const SYNOLOGY_OUTBOUND_MEDIA_TTL_MS = 10 * 60_000;
const SYNOLOGY_OUTBOUND_MEDIA_MAX_BYTES = 32 * 1024 * 1024;
const SYNOLOGY_OUTBOUND_MEDIA_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const SYNOLOGY_OUTBOUND_MEDIA_MAX_ENTRIES = 16;
const SYNOLOGY_OUTBOUND_MEDIA_MAX_CHUNK_ROWS = 4_096;
const SYNOLOGY_OUTBOUND_MEDIA_ID_RE = /^[a-f0-9]{24}$/;
const SYNOLOGY_OUTBOUND_MEDIA_PREPARE_TIMEOUT_MS = 60_000;
const SYNOLOGY_OUTBOUND_MEDIA_MAX_PREPARATIONS = 2;
const SYNOLOGY_OUTBOUND_MEDIA_MAX_SERVES = 4;
const SYNOLOGY_OUTBOUND_MEDIA_SERVE_TIMEOUT_MS = 2 * 60_000;
const SYNOLOGY_OUTBOUND_MEDIA_POST_EXPIRY_RETENTION_MS =
  SYNOLOGY_OUTBOUND_MEDIA_SERVE_TIMEOUT_MS + 60_000;
const SYNOLOGY_OUTBOUND_MEDIA_SERVED_BYTES_WINDOW_MS = 60_000;
const SYNOLOGY_OUTBOUND_MEDIA_MAX_SERVED_BYTES_PER_WINDOW = 128 * 1024 * 1024;
const SYNOLOGY_OUTBOUND_MEDIA_MAX_BUDGET_ACCOUNTS = 128;
const ACTIVE_CONTENT_TYPES = new Set([
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
]);
const OUTBOUND_MEDIA_NAMESPACE = "hosted-outbound-media";
const OUTBOUND_MEDIA_CHUNKS_NAMESPACE = "hosted-outbound-media-chunks";

declare const synologyHostedMediaUrlBrand: unique symbol;
export type SynologyHostedMediaUrl = string & {
  readonly [synologyHostedMediaUrlBrand]: true;
};

type PreparedSynologyHostedMedia = {
  url: SynologyHostedMediaUrl;
  cleanup: () => Promise<void>;
};

const preparationLimiter = createWebhookInFlightLimiter({
  maxInFlightPerKey: SYNOLOGY_OUTBOUND_MEDIA_MAX_PREPARATIONS,
  maxTrackedKeys: 128,
});
const servingLimiter = createWebhookInFlightLimiter({
  maxInFlightPerKey: SYNOLOGY_OUTBOUND_MEDIA_MAX_SERVES,
  maxTrackedKeys: 128,
});
const hostedMediaStores = new Map<string, HostedOutboundMediaStore>();
const servedByteWindows = new Map<string, { startedAt: number; bytes: number }>();
let hostedMediaRuntime: ReturnType<typeof getSynologyRuntime> | undefined;

function reserveServedBytes(
  accountId: string,
  byteLength: number,
  now = Date.now(),
): (() => void) | undefined {
  const existing = servedByteWindows.get(accountId);
  const active =
    existing && now - existing.startedAt < SYNOLOGY_OUTBOUND_MEDIA_SERVED_BYTES_WINDOW_MS
      ? existing
      : { startedAt: now, bytes: 0 };
  if (active.bytes + byteLength > SYNOLOGY_OUTBOUND_MEDIA_MAX_SERVED_BYTES_PER_WINDOW) {
    return undefined;
  }
  servedByteWindows.delete(accountId);
  servedByteWindows.set(accountId, {
    startedAt: active.startedAt,
    bytes: active.bytes + byteLength,
  });
  while (servedByteWindows.size > SYNOLOGY_OUTBOUND_MEDIA_MAX_BUDGET_ACCOUNTS) {
    const oldest = servedByteWindows.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    servedByteWindows.delete(oldest);
  }
  return () => {
    const current = servedByteWindows.get(accountId);
    if (!current || current.startedAt !== active.startedAt) {
      return;
    }
    current.bytes = Math.max(0, current.bytes - byteLength);
    if (current.bytes === 0) {
      servedByteWindows.delete(accountId);
    }
  };
}

function holdServingLeaseUntilResponseDone(
  res: ServerResponse,
  accountId: string,
): { isActive: () => boolean; release: () => void } {
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    clearTimeout(timeout);
    res.off("finish", release);
    res.off("close", release);
    servingLimiter.release(accountId);
  };
  // `res.end()` only queues the body. Keep the account slot until the socket
  // finishes or closes so slow readers cannot bypass the response concurrency cap.
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      res.statusCode = 504;
      res.end("Attachment response timed out");
    } else {
      res.destroy();
    }
    release();
  }, SYNOLOGY_OUTBOUND_MEDIA_SERVE_TIMEOUT_MS);
  timeout.unref?.();
  res.once("finish", release);
  res.once("close", release);
  return { isActive: () => !released, release };
}

async function writeHostedMediaChunk(res: ServerResponse, chunk: Buffer): Promise<void> {
  if (res.destroyed) {
    throw new Error("Synology Chat attachment response closed before completion.");
  }
  if (res.write(chunk)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Synology Chat attachment response closed before completion."));
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
    if (res.destroyed) {
      onClose();
    }
  });
}

function createHostedMediaStore(accountId: string): HostedOutboundMediaStore {
  const runtime = getSynologyRuntime();
  const accountScope = createHash("sha256").update(accountId).digest("hex").slice(0, 16);
  return createHostedOutboundMediaStore({
    metadataStore: runtime.state.openKeyedStore<HostedOutboundMediaMetaRecord>({
      namespace: `${OUTBOUND_MEDIA_NAMESPACE}-${accountScope}`,
      maxEntries: SYNOLOGY_OUTBOUND_MEDIA_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
    chunkStore: runtime.state.openKeyedStore<HostedOutboundMediaChunkRecord>({
      namespace: `${OUTBOUND_MEDIA_CHUNKS_NAMESPACE}-${accountScope}`,
      maxEntries: SYNOLOGY_OUTBOUND_MEDIA_MAX_CHUNK_ROWS,
      overflowPolicy: "reject-new",
    }),
    ttlMs: SYNOLOGY_OUTBOUND_MEDIA_TTL_MS,
    maxEntries: SYNOLOGY_OUTBOUND_MEDIA_MAX_ENTRIES,
    maxChunkRows: SYNOLOGY_OUTBOUND_MEDIA_MAX_CHUNK_ROWS,
    maxTotalBytes: SYNOLOGY_OUTBOUND_MEDIA_MAX_TOTAL_BYTES,
    postExpiryRetentionMs: SYNOLOGY_OUTBOUND_MEDIA_POST_EXPIRY_RETENTION_MS,
    overflowPolicy: "reject-new",
    resolveExpiresAtMs: (ttlMs) => resolveExpiresAtMsFromDurationMs(ttlMs),
  });
}

function getHostedMediaStore(accountId: string): HostedOutboundMediaStore {
  const runtime = getSynologyRuntime();
  if (hostedMediaRuntime !== runtime) {
    hostedMediaRuntime = runtime;
    hostedMediaStores.clear();
    preparationLimiter.clear();
    servingLimiter.clear();
    servedByteWindows.clear();
  }
  const existing = hostedMediaStores.get(accountId);
  if (existing) {
    return existing;
  }
  const created = createHostedMediaStore(accountId);
  hostedMediaStores.set(accountId, created);
  return created;
}

function createCleanup(store: HostedOutboundMediaStore, id: string): () => Promise<void> {
  let cleanup: Promise<void> | undefined;
  return async () => {
    const activeCleanup = cleanup ?? store.delete(id);
    cleanup = activeCleanup;
    try {
      await activeCleanup;
    } catch (error) {
      if (cleanup === activeCleanup) {
        cleanup = undefined;
      }
      throw error;
    }
  };
}

function normalizeMediaAccess(params: {
  mediaAccess?: OutboundMediaLoadOptions["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
}): OutboundMediaLoadOptions["mediaAccess"] {
  const localRoots = params.mediaAccess?.localRoots ?? params.mediaLocalRoots;
  const readFile = params.mediaAccess?.readFile ?? params.mediaReadFile;
  const workspaceDir = params.mediaAccess?.workspaceDir;
  if (!localRoots && !readFile && !workspaceDir) {
    return undefined;
  }
  return {
    ...(localRoots ? { localRoots } : {}),
    ...(readFile ? { readFile } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
  };
}

function skipAsciiWhitespace(buffer: Buffer, start: number): number {
  let cursor = start;
  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d && byte !== 0x20) {
      break;
    }
    cursor += 1;
  }
  return cursor;
}

function isAsciiMarkupStart(byte: number | undefined): boolean {
  return (
    byte === 0x21 ||
    byte === 0x3f ||
    (byte !== undefined && ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)))
  );
}

type UnicodeMarkupEncoding = "utf-16le" | "utf-16be" | "utf-32le" | "utf-32be";

function readUnicodeCodePoint(
  buffer: Buffer,
  offset: number,
  width: 2 | 4,
  littleEndian: boolean,
): number {
  if (width === 2) {
    return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  }
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function containsEncodedMarkupStart(
  buffer: Buffer,
  width: 2 | 4,
  littleEndian: boolean,
  offset = 0,
): boolean {
  for (let cursor = offset; cursor + width * 2 <= buffer.length; cursor += width) {
    if (
      readUnicodeCodePoint(buffer, cursor, width, littleEndian) === 0x3c &&
      isAsciiMarkupStart(readUnicodeCodePoint(buffer, cursor + width, width, littleEndian))
    ) {
      return true;
    }
  }
  return false;
}

function detectBomlessUnicodeMarkupEncoding(buffer: Buffer): UnicodeMarkupEncoding | undefined {
  // Only consider code-unit-aligned openers. Decoding then applies the same
  // root-document policy as ordinary UTF-8, so embedded markup in source text
  // remains a passive attachment.
  if (containsEncodedMarkupStart(buffer, 4, true)) {
    return "utf-32le";
  }
  if (containsEncodedMarkupStart(buffer, 4, false)) {
    return "utf-32be";
  }
  if (containsEncodedMarkupStart(buffer, 2, true)) {
    return "utf-16le";
  }
  if (containsEncodedMarkupStart(buffer, 2, false)) {
    return "utf-16be";
  }
  return undefined;
}

function decodeUtf32(buffer: Buffer, littleEndian: boolean, offset: number): Buffer {
  const chunks: string[] = [];
  let codePoints: number[] = [];
  for (let cursor = offset; cursor + 4 <= buffer.length; cursor += 4) {
    const decoded = readUnicodeCodePoint(buffer, cursor, 4, littleEndian);
    codePoints.push(
      decoded <= 0x10ffff && (decoded < 0xd800 || decoded > 0xdfff) ? decoded : 0xfffd,
    );
    if (codePoints.length === 1_024) {
      chunks.push(String.fromCodePoint(...codePoints));
      codePoints = [];
    }
  }
  if (codePoints.length > 0) {
    chunks.push(String.fromCodePoint(...codePoints));
  }
  return Buffer.from(chunks.join(""));
}

function decodeTextForActiveContentSniffing(buffer: Buffer): Buffer {
  if (buffer[0] === 0xff && buffer[1] === 0xfe && buffer[2] === 0x00 && buffer[3] === 0x00) {
    return decodeUtf32(buffer, true, 4);
  }
  if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0xfe && buffer[3] === 0xff) {
    return decodeUtf32(buffer, false, 4);
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return Buffer.from(buffer.subarray(2).toString("utf16le"));
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return Buffer.from(new TextDecoder("utf-16be").decode(buffer.subarray(2)));
  }

  const bomlessEncoding = detectBomlessUnicodeMarkupEncoding(buffer);
  if (bomlessEncoding === "utf-32le") {
    return decodeUtf32(buffer, true, 0);
  }
  if (bomlessEncoding === "utf-32be") {
    return decodeUtf32(buffer, false, 0);
  }
  if (bomlessEncoding === "utf-16le") {
    return Buffer.from(buffer.toString("utf16le"));
  }
  if (bomlessEncoding === "utf-16be") {
    return Buffer.from(new TextDecoder("utf-16be").decode(buffer));
  }
  return buffer;
}

function startsWithAsciiIgnoreCase(buffer: Buffer, start: number, expected: string): boolean {
  if (start + expected.length > buffer.length) {
    return false;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const byte = buffer[start + index]!;
    const lower = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
    if (lower !== expected.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

function readAsciiRootTag(buffer: Buffer, start: number): string | undefined {
  if (buffer[start] !== 0x3c) {
    return undefined;
  }
  let cursor = start + 1;
  const first = buffer[cursor];
  if (
    first === undefined ||
    !(
      (first >= 0x41 && first <= 0x5a) ||
      (first >= 0x61 && first <= 0x7a) ||
      first === 0x3a ||
      first === 0x5f ||
      first >= 0x80
    )
  ) {
    return undefined;
  }
  cursor += 1;
  while (cursor < buffer.length) {
    const byte = buffer[cursor]!;
    if (
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x3a ||
      byte === 0x5f ||
      byte >= 0x80
    ) {
      cursor += 1;
      continue;
    }
    if (byte === 0x2f || byte === 0x3e || skipAsciiWhitespace(buffer, cursor) > cursor) {
      return buffer
        .subarray(start + 1, cursor)
        .toString("utf8")
        .toLowerCase();
    }
    return undefined;
  }
  return undefined;
}

function skipRootHtmlComment(buffer: Buffer, start: number): number | undefined {
  let cursor = start + 4;
  // HTML closes an empty `<!-->` comment abruptly at the first `>`.
  if (buffer[cursor] === 0x3e) {
    return cursor + 1;
  }
  // The comment-start-dash state likewise closes `<!--->` at `>`.
  if (buffer[cursor] === 0x2d && buffer[cursor + 1] === 0x3e) {
    return cursor + 2;
  }
  while (cursor < buffer.length) {
    if (buffer[cursor] !== 0x2d || buffer[cursor + 1] !== 0x2d) {
      cursor += 1;
      continue;
    }
    if (buffer[cursor + 2] === 0x3e) {
      return cursor + 3;
    }
    // HTML also recovers `--!>` as an incorrectly closed comment.
    if (buffer[cursor + 2] === 0x21 && buffer[cursor + 3] === 0x3e) {
      return cursor + 4;
    }
    cursor += 2;
  }
  return undefined;
}

function sniffActiveTextContent(buffer: Buffer): string | undefined {
  const decoded = decodeTextForActiveContentSniffing(buffer);
  let cursor =
    decoded.length >= 3 && decoded[0] === 0xef && decoded[1] === 0xbb && decoded[2] === 0xbf
      ? 3
      : 0;
  // A payload is treated as an active document only when markup is its root,
  // after optional whitespace/comments. This avoids rejecting passive source
  // and prose files merely because they contain a literal tag later on.
  while (cursor < decoded.length) {
    cursor = skipAsciiWhitespace(decoded, cursor);
    if (decoded[cursor] === 0x3c && decoded[cursor + 1] === 0x3f) {
      return "application/xml";
    }
    if (startsWithAsciiIgnoreCase(decoded, cursor, "<!--")) {
      const end = skipRootHtmlComment(decoded, cursor);
      if (end === undefined) {
        return undefined;
      }
      cursor = end;
      continue;
    }
    if (startsWithAsciiIgnoreCase(decoded, cursor, "<!doctype")) {
      return "application/xml";
    }
    const rootTag = readAsciiRootTag(decoded, cursor);
    if (rootTag) {
      return rootTag === "svg" ? "image/svg+xml" : "text/html";
    }
    // A declaration or closing tag is still a markup-document root even when
    // it is malformed or precedes a later executable element. Reject every
    // remaining root-level opener instead of trying to parse HTML recovery.
    if (decoded[cursor] === 0x3c) {
      return "text/html";
    }
    return undefined;
  }
  return undefined;
}

function detectActiveContentType(params: {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
}): string | undefined {
  const declaredType = normalizeMimeType(params.contentType);
  if (declaredType && ACTIVE_CONTENT_TYPES.has(declaredType)) {
    return declaredType;
  }
  const fileNameType = normalizeMimeType(mimeTypeFromFilePath(params.fileName));
  if (fileNameType && ACTIVE_CONTENT_TYPES.has(fileNameType)) {
    return fileNameType;
  }
  return sniffActiveTextContent(params.buffer);
}

export async function prepareSynologyHostedMedia(params: {
  account: ResolvedSynologyChatAccount;
  mediaUrl: string;
  mediaAccess?: OutboundMediaLoadOptions["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
}): Promise<PreparedSynologyHostedMedia> {
  const route = resolveSynologyHostedMediaRoute(params.account);
  // Synchronize runtime-owned stores and counters before admitting work. A
  // runtime change clears stale leases, so doing this after acquisition would
  // erase the current request's slot.
  const store = getHostedMediaStore(params.account.accountId);
  if (!preparationLimiter.tryAcquire(params.account.accountId)) {
    throw new Error(
      "Synology Chat attachment preparation is busy. Retry after the current attachments finish preparing.",
    );
  }
  try {
    await store.cleanupExpired();
    const stagedUrl = new URL(
      await store.prepareUrl({
        mediaUrl: params.mediaUrl,
        routePath: route.localRoutePath,
        publicBaseUrl: route.publicBaseUrl,
        maxBytes: SYNOLOGY_OUTBOUND_MEDIA_MAX_BYTES,
        mediaAccess: normalizeMediaAccess(params),
        requestInit: { signal: AbortSignal.timeout(SYNOLOGY_OUTBOUND_MEDIA_PREPARE_TIMEOUT_MS) },
        validateBeforePersist: (media) => {
          const activeContentType = detectActiveContentType(media);
          if (activeContentType) {
            throw new Error(
              `Synology Chat attachments do not support active content type ${activeContentType}.`,
            );
          }
        },
      }),
    );
    const id = stagedUrl.pathname.split("/").at(-1) ?? "";
    const token = stagedUrl.searchParams.get("token");
    if (!SYNOLOGY_OUTBOUND_MEDIA_ID_RE.test(id) || !token) {
      throw new Error("Synology Chat attachment capability could not be prepared.");
    }
    const cleanup = createCleanup(store, id);
    const tokenParam = `${SYNOLOGY_HOSTED_MEDIA_TOKEN_PARAM_PREFIX}_${id}`;
    const querySeparator = route.publicSearch ? "&" : "?";
    return {
      url: `${route.publicBaseUrl}${route.publicRoutePath}${route.publicSearch}${querySeparator}${tokenParam}=${encodeURIComponent(token)}` as SynologyHostedMediaUrl,
      cleanup,
    };
  } finally {
    preparationLimiter.release(params.account.accountId);
  }
}

export async function tryHandleSynologyHostedMediaRequest(
  req: IncomingMessage,
  res: ServerResponse,
  account: ResolvedSynologyChatAccount,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    return false;
  }
  const tokenCandidates = [...url.searchParams.entries()]
    .filter(([key]) => key.startsWith(`${SYNOLOGY_HOSTED_MEDIA_TOKEN_PARAM_PREFIX}_`))
    .map(([key, token]) => ({
      id: key.slice(SYNOLOGY_HOSTED_MEDIA_TOKEN_PARAM_PREFIX.length + 1),
      token,
    }))
    .filter((candidate) => SYNOLOGY_OUTBOUND_MEDIA_ID_RE.test(candidate.id));
  if (tokenCandidates.length === 0) {
    return false;
  }
  if (tokenCandidates.length !== 1) {
    res.statusCode = 400;
    res.end("Bad Request");
    return true;
  }
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end("Method Not Allowed");
    return true;
  }

  const candidate = tokenCandidates[0];
  if (!candidate) {
    return false;
  }
  // Runtime replacement resets the process-local limiter state. Resolve the
  // matching store first so the lease acquired below belongs to that runtime.
  const store = getHostedMediaStore(account.accountId);
  if (!servingLimiter.tryAcquire(account.accountId)) {
    res.statusCode = 503;
    res.setHeader("Retry-After", "1");
    res.end("Attachment temporarily unavailable");
    return true;
  }
  let responseOwnsServingLease = false;
  let rollbackServedBytes: (() => void) | undefined;
  let entry: HostedOutboundMediaEntry | null | undefined;
  const servingLease = holdServingLeaseUntilResponseDone(res, account.accountId);
  try {
    const routePath = toSynologyHostedMediaStoreRoutePath(url.pathname);
    const metadata = await store.readMetadata(candidate.id);
    if (!servingLease.isActive() || res.destroyed || res.writableEnded) {
      return true;
    }
    if (!metadata || metadata.routePath !== routePath) {
      res.statusCode = 404;
      res.end("Not Found");
      return true;
    }
    if (!safeEqualSecret(candidate.token, metadata.token)) {
      res.statusCode = 401;
      res.end("Unauthorized");
      return true;
    }
    if (method === "GET") {
      // Authenticate and reserve from metadata before reading stored chunks.
      // Rejected over-budget requests must not force SQLite payload reads.
      rollbackServedBytes = reserveServedBytes(account.accountId, metadata.byteLength);
      if (!rollbackServedBytes) {
        res.statusCode = 429;
        res.setHeader("Retry-After", "60");
        res.end("Attachment download limit exceeded");
        return true;
      }
      entry = await store.read(candidate.id);
      if (!servingLease.isActive() || res.destroyed || res.writableEnded) {
        return true;
      }
      if (!entry) {
        res.statusCode = 404;
        res.end("Not Found");
        return true;
      }
    }
    for (const [name, value] of Object.entries(
      buildHostedOutboundMediaResponseHeaders(metadata, {
        fallbackFileName: `attachment-${candidate.id.slice(0, 10)}.bin`,
      }),
    )) {
      res.setHeader(name, value);
    }
    res.statusCode = 200;
    res.setHeader("Accept-Ranges", "none");
    responseOwnsServingLease = true;
    // An authenticated GET consumes its bandwidth budget even if the client
    // disconnects mid-stream; otherwise retries can bypass the served-byte cap.
    rollbackServedBytes = undefined;
    if (entry) {
      try {
        await writeHostedMediaChunk(res, entry.buffer);
      } catch {
        if (!res.destroyed) {
          res.destroy();
        }
        return true;
      }
    }
    res.end();
    return true;
  } finally {
    rollbackServedBytes?.();
    if (!responseOwnsServingLease) {
      servingLease.release();
    }
  }
}
