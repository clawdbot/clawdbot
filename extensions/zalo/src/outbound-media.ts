import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { resolveWebhookPath } from "openclaw/plugin-sdk/webhook-ingress";

const ZALO_OUTBOUND_MEDIA_TTL_MS = 2 * 60_000;
const ZALO_OUTBOUND_MEDIA_SEGMENT = "media";
const ZALO_OUTBOUND_MEDIA_PREFIX = `/${ZALO_OUTBOUND_MEDIA_SEGMENT}/`;
const ZALO_OUTBOUND_MEDIA_DIR = join(
  resolvePreferredOpenClawTmpDir(),
  "openclaw-zalo-outbound-media",
);
const ZALO_OUTBOUND_MEDIA_ID_RE = /^[a-f0-9]{24}$/;

type HostedZaloMediaMetadata = {
  routePath: string;
  token: string;
  contentType?: string;
  expiresAt: number;
};

function resolveHostedZaloMediaMetadataPath(id: string): string {
  return join(ZALO_OUTBOUND_MEDIA_DIR, `${id}.json`);
}

function resolveHostedZaloMediaBufferPath(id: string): string {
  return join(ZALO_OUTBOUND_MEDIA_DIR, `${id}.bin`);
}

function createHostedZaloMediaId(): string {
  return randomBytes(12).toString("hex");
}

function createHostedZaloMediaToken(): string {
  return randomBytes(24).toString("hex");
}

async function ensureHostedZaloMediaDir(): Promise<void> {
  await privateFileStore(ZALO_OUTBOUND_MEDIA_DIR).writeText(".ready", "");
  await unlink(join(ZALO_OUTBOUND_MEDIA_DIR, ".ready")).catch(() => undefined);
}

async function deleteHostedZaloMediaEntry(id: string): Promise<void> {
  await Promise.all([
    unlink(resolveHostedZaloMediaMetadataPath(id)).catch(() => undefined),
    unlink(resolveHostedZaloMediaBufferPath(id)).catch(() => undefined),
  ]);
}

async function cleanupExpiredHostedZaloMedia(nowMs = Date.now()): Promise<void> {
  let fileNames: string[];
  try {
    fileNames = await readdir(ZALO_OUTBOUND_MEDIA_DIR);
  } catch {
    return;
  }

  await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith(".json"))
      .map(async (fileName) => {
        const id = fileName.slice(0, -5);
        try {
          const metadataRaw = await readFile(resolveHostedZaloMediaMetadataPath(id), "utf8");
          const metadata = JSON.parse(metadataRaw) as HostedZaloMediaMetadata;
          if (metadata.expiresAt <= nowMs) {
            await deleteHostedZaloMediaEntry(id);
          }
        } catch {
          await deleteHostedZaloMediaEntry(id);
        }
      }),
  );
}

async function readHostedZaloMediaEntry(id: string): Promise<{
  metadata: HostedZaloMediaMetadata;
  buffer: Buffer;
} | null> {
  try {
    const [metadataRaw, buffer] = await Promise.all([
      readFile(resolveHostedZaloMediaMetadataPath(id), "utf8"),
      readFile(resolveHostedZaloMediaBufferPath(id)),
    ]);
    return {
      metadata: JSON.parse(metadataRaw) as HostedZaloMediaMetadata,
      buffer,
    };
  } catch {
    return null;
  }
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
  await ensureHostedZaloMediaDir();
  await cleanupExpiredHostedZaloMedia();

  const media = await loadOutboundMediaFromUrl(params.mediaUrl, {
    maxBytes: params.maxBytes,
    ...(params.proxyUrl ? { proxyUrl: params.proxyUrl } : {}),
  });

  const routePath = resolveHostedZaloMediaRoutePath({
    webhookUrl: params.webhookUrl,
    webhookPath: params.webhookPath,
  });
  const id = createHostedZaloMediaId();
  const token = createHostedZaloMediaToken();
  const publicBaseUrl = new URL(params.webhookUrl).origin;

  const store = privateFileStore(ZALO_OUTBOUND_MEDIA_DIR);
  await store.writeText(`${id}.bin`, media.buffer);
  try {
    await store.writeJson(`${id}.json`, {
      routePath,
      token,
      contentType: media.contentType,
      expiresAt: Date.now() + ZALO_OUTBOUND_MEDIA_TTL_MS,
    } satisfies HostedZaloMediaMetadata);
  } catch (error) {
    await deleteHostedZaloMediaEntry(id);
    throw error;
  }

  return `${publicBaseUrl}${routePath}${id}?token=${token}`;
}

export async function tryHandleHostedZaloMediaRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  await cleanupExpiredHostedZaloMedia();

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

  const entry = await readHostedZaloMediaEntry(id);
  if (!entry || entry.metadata.routePath !== routePath) {
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }

  if (entry.metadata.expiresAt <= Date.now()) {
    await deleteHostedZaloMediaEntry(id);
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
  const bufferStats = await stat(resolveHostedZaloMediaBufferPath(id)).catch(() => null);
  if (bufferStats) {
    res.setHeader("Content-Length", String(bufferStats.size));
  }

  if (method === "HEAD") {
    res.statusCode = 200;
    res.end();
    return true;
  }

  res.statusCode = 200;
  res.end(entry.buffer);
  await deleteHostedZaloMediaEntry(id);
  return true;
}

export function clearHostedZaloMediaForTest(): void {
  rmSync(ZALO_OUTBOUND_MEDIA_DIR, { recursive: true, force: true });
}
