// Zalo plugin module implements outbound media behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import {
  createHostedOutboundMediaStore,
  type HostedOutboundMediaChunkRecord,
  type HostedOutboundMediaMetaRecord,
  type HostedOutboundMediaStore,
} from "openclaw/plugin-sdk/outbound-media";
import { resolveWebhookPath } from "openclaw/plugin-sdk/webhook-ingress";
import { getZaloRuntime } from "./runtime.js";

const ZALO_OUTBOUND_MEDIA_TTL_MS = 2 * 60_000;
const ZALO_OUTBOUND_MEDIA_SEGMENT = "media";
const ZALO_OUTBOUND_MEDIA_PREFIX = `/${ZALO_OUTBOUND_MEDIA_SEGMENT}/`;
const ZALO_OUTBOUND_MEDIA_ID_RE = /^[a-f0-9]{24}$/;
const ZALO_OUTBOUND_MEDIA_NAMESPACE = "hosted-outbound-media";
const ZALO_OUTBOUND_MEDIA_CHUNKS_NAMESPACE = "hosted-outbound-media-chunks";
const ZALO_OUTBOUND_MEDIA_MAX_ENTRIES = 64;
const ZALO_OUTBOUND_MEDIA_CHUNK_ROWS_PER_ENTRY_BUDGET = 256;
const ZALO_OUTBOUND_MEDIA_MAX_CHUNK_ROWS =
  ZALO_OUTBOUND_MEDIA_MAX_ENTRIES * ZALO_OUTBOUND_MEDIA_CHUNK_ROWS_PER_ENTRY_BUDGET;

let hostedZaloMediaStore: HostedOutboundMediaStore | undefined;

function createHostedZaloMediaStore(): HostedOutboundMediaStore {
  const runtime = getZaloRuntime();
  return createHostedOutboundMediaStore({
    metadataStore: runtime.state.openKeyedStore<HostedOutboundMediaMetaRecord>({
      namespace: ZALO_OUTBOUND_MEDIA_NAMESPACE,
      maxEntries: ZALO_OUTBOUND_MEDIA_MAX_ENTRIES + 16,
    }),
    chunkStore: runtime.state.openKeyedStore<HostedOutboundMediaChunkRecord>({
      namespace: ZALO_OUTBOUND_MEDIA_CHUNKS_NAMESPACE,
      maxEntries: ZALO_OUTBOUND_MEDIA_MAX_CHUNK_ROWS,
    }),
    ttlMs: ZALO_OUTBOUND_MEDIA_TTL_MS,
    maxEntries: ZALO_OUTBOUND_MEDIA_MAX_ENTRIES,
    maxChunkRows: ZALO_OUTBOUND_MEDIA_MAX_CHUNK_ROWS,
    resolveExpiresAtMs: (ttlMs) => resolveExpiresAtMsFromDurationMs(ttlMs),
  });
}

function getHostedZaloMediaStore(): HostedOutboundMediaStore {
  hostedZaloMediaStore ??= createHostedZaloMediaStore();
  return hostedZaloMediaStore;
}

export function resolveHostedZaloMediaRoutePrefix(params: {
  webhookUrl: string;
  webhookPath?: string;
}): string {
  const webhookRoutePath = resolveWebhookPath({
    webhookPath: params.webhookPath,
    webhookUrl: params.webhookUrl,
    defaultPath: null,
  });
  if (!webhookRoutePath) {
    throw new Error("Zalo webhookPath could not be derived for outbound media hosting");
  }
  return webhookRoutePath === "/"
    ? `/${ZALO_OUTBOUND_MEDIA_SEGMENT}`
    : `${webhookRoutePath}/${ZALO_OUTBOUND_MEDIA_SEGMENT}`;
}

function resolveHostedZaloMediaRoutePath(params: {
  webhookUrl: string;
  webhookPath?: string;
}): string {
  return `${resolveHostedZaloMediaRoutePrefix(params)}/`;
}

export async function prepareHostedZaloMediaUrl(params: {
  mediaUrl: string;
  webhookUrl: string;
  webhookPath?: string;
  maxBytes: number;
  proxyUrl?: string;
}): Promise<string> {
  const now = asDateTimestampMs(Date.now());
  const expiresAt =
    now === undefined
      ? undefined
      : resolveExpiresAtMsFromDurationMs(ZALO_OUTBOUND_MEDIA_TTL_MS, { nowMs: now });
  if (expiresAt === undefined) {
    throw new Error("Zalo outbound media expiry could not be resolved");
  }

  const routePath = resolveHostedZaloMediaRoutePath({
    webhookUrl: params.webhookUrl,
    webhookPath: params.webhookPath,
  });
  const publicBaseUrl = new URL(params.webhookUrl).origin;

  return await getHostedZaloMediaStore().prepareUrl({
    mediaUrl: params.mediaUrl,
    routePath,
    publicBaseUrl,
    maxBytes: params.maxBytes,
    ...(params.proxyUrl ? { proxyUrl: params.proxyUrl } : {}),
  });
}

export async function tryHandleHostedZaloMediaRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const store = getHostedZaloMediaStore();
  await store.cleanupExpired();

  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }

  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    return false;
  }

  const mediaPath = url.pathname;
  const prefixIndex = mediaPath.lastIndexOf(ZALO_OUTBOUND_MEDIA_PREFIX);
  if (prefixIndex < 0) {
    return false;
  }

  const routePath = mediaPath.slice(0, prefixIndex + ZALO_OUTBOUND_MEDIA_PREFIX.length);
  const id = mediaPath.slice(prefixIndex + ZALO_OUTBOUND_MEDIA_PREFIX.length);
  if (!id || !ZALO_OUTBOUND_MEDIA_ID_RE.test(id)) {
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }

  const now = asDateTimestampMs(Date.now());
  if (now === undefined) {
    await store.delete(id);
    res.statusCode = 410;
    res.end("Expired");
    return true;
  }

  const entry = await store.read(id, now);
  if (!entry || entry.metadata.routePath !== routePath) {
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }

  const expiresAt = asDateTimestampMs(entry.metadata.expiresAt);
  if (expiresAt === undefined || expiresAt <= now) {
    await store.delete(id);
    res.statusCode = 410;
    res.end("Expired");
    return true;
  }

  if (url.searchParams.get("token") !== entry.metadata.token) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return true;
  }

  if (entry.metadata.contentType) {
    res.setHeader("Content-Type", entry.metadata.contentType);
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Length", String(entry.metadata.byteLength));

  if (method === "HEAD") {
    res.statusCode = 200;
    res.end();
    return true;
  }

  res.statusCode = 200;
  res.end(entry.buffer);
  await store.delete(id);
  return true;
}
