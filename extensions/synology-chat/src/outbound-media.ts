// Synology Chat plugin module stages immutable outbound bytes for NAS attachment pickup.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mimeTypeFromFilePath, normalizeMimeType } from "openclaw/plugin-sdk/media-mime";
import { resolveExpiresAtMsFromDurationMs } from "openclaw/plugin-sdk/number-runtime";
import {
  buildHostedOutboundMediaResponseHeaders,
  createHostedOutboundMediaStore,
  type HostedOutboundMediaChunkRecord,
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
const ACTIVE_CONTENT_TYPES = new Set(["image/svg+xml", "text/html", "application/xhtml+xml"]);
const HTML_ACTIVE_PREFIX_TAGS = [
  "html",
  "head",
  "script",
  "iframe",
  "body",
  "style",
  "title",
] as const;
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
let hostedMediaRuntime: ReturnType<typeof getSynologyRuntime> | undefined;

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

function startsWithHtmlTag(value: string, tag: string): boolean {
  if (!value.startsWith(`<${tag}`)) {
    return false;
  }
  const boundary = value.at(tag.length + 1);
  return boundary === ">" || boundary === "/" || /\s/u.test(boundary ?? "");
}

function sniffActiveTextContent(buffer: Buffer): string | undefined {
  let prefix = buffer
    .subarray(0, 4_096)
    .toString("utf8")
    .replace(/^\uFEFF/u, "")
    .trimStart();
  // XML declarations and comments commonly precede SVG roots, so skip only
  // bounded leading wrappers before inspecting the actual document element.
  for (let index = 0; index < 4; index += 1) {
    if (prefix.startsWith("<?xml")) {
      const end = prefix.indexOf("?>");
      if (end === -1) {
        break;
      }
      prefix = prefix.slice(end + 2).trimStart();
      continue;
    }
    if (prefix.startsWith("<!--")) {
      const end = prefix.indexOf("-->");
      if (end === -1) {
        break;
      }
      prefix = prefix.slice(end + 3).trimStart();
      continue;
    }
    break;
  }
  const normalized = prefix.toLowerCase();
  if (startsWithHtmlTag(normalized, "svg")) {
    return "image/svg+xml";
  }
  if (
    normalized.startsWith("<!doctype html") ||
    HTML_ACTIVE_PREFIX_TAGS.some((tag) => startsWithHtmlTag(normalized, tag))
  ) {
    return "text/html";
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
  if (!preparationLimiter.tryAcquire(params.account.accountId)) {
    throw new Error(
      "Synology Chat attachment preparation is busy. Retry after the current attachments finish preparing.",
    );
  }
  try {
    const store = getHostedMediaStore(params.account.accountId);
    await store.cleanupExpired();
    const stagedUrl = new URL(
      await store.prepareUrl({
        mediaUrl: params.mediaUrl,
        routePath: route.localRoutePath,
        publicBaseUrl: route.publicBaseUrl,
        maxBytes: SYNOLOGY_OUTBOUND_MEDIA_MAX_BYTES,
        mediaAccess: normalizeMediaAccess(params),
        requestInit: { signal: AbortSignal.timeout(SYNOLOGY_OUTBOUND_MEDIA_PREPARE_TIMEOUT_MS) },
      }),
    );
    const id = stagedUrl.pathname.split("/").at(-1) ?? "";
    const token = stagedUrl.searchParams.get("token");
    if (!SYNOLOGY_OUTBOUND_MEDIA_ID_RE.test(id) || !token) {
      throw new Error("Synology Chat attachment capability could not be prepared.");
    }
    const cleanup = createCleanup(store, id);
    // Inspect the exact frozen object that the NAS will receive. Remote MIME
    // metadata is attacker-controlled and cannot establish a passive payload.
    const staged = await store.read(id);
    if (!staged) {
      await cleanup();
      throw new Error("Synology Chat attachment expired before it could be sent.");
    }
    const activeContentType = detectActiveContentType({
      buffer: staged.buffer,
      contentType: staged.metadata.contentType,
      fileName: staged.metadata.fileName,
    });
    if (activeContentType) {
      await cleanup();
      throw new Error(
        `Synology Chat attachments do not support active content type ${activeContentType}.`,
      );
    }

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

  const store = getHostedMediaStore(account.accountId);
  const candidate = tokenCandidates[0];
  if (!candidate) {
    return false;
  }
  const routePath = toSynologyHostedMediaStoreRoutePath(url.pathname);
  const metadata = await store.readMetadata(candidate.id);
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
  if (!servingLimiter.tryAcquire(account.accountId)) {
    res.statusCode = 503;
    res.setHeader("Retry-After", "1");
    res.end("Attachment temporarily unavailable");
    return true;
  }
  try {
    let servedMetadata = metadata;
    let body: Buffer | undefined;
    if (method === "GET") {
      const entry = await store.read(candidate.id);
      if (
        !entry ||
        entry.metadata.routePath !== routePath ||
        !safeEqualSecret(candidate.token, entry.metadata.token)
      ) {
        res.statusCode = 404;
        res.end("Not Found");
        return true;
      }
      servedMetadata = entry.metadata;
      body = entry.buffer;
    }
    for (const [name, value] of Object.entries(
      buildHostedOutboundMediaResponseHeaders(servedMetadata, {
        fallbackFileName: `attachment-${candidate.id.slice(0, 10)}.bin`,
      }),
    )) {
      res.setHeader(name, value);
    }
    res.statusCode = 200;
    res.end(body);
    return true;
  } finally {
    servingLimiter.release(account.accountId);
  }
}
