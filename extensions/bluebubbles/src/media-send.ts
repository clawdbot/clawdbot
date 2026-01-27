import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveChannelMediaMaxBytes, type MoltbotConfig } from "clawdbot/plugin-sdk";

import { sendBlueBubblesAttachment } from "./attachments.js";
import { resolveBlueBubblesMessageId } from "./monitor.js";
import { getBlueBubblesRuntime } from "./runtime.js";
import { sendMessageBlueBubbles } from "./send.js";

const HTTP_URL_RE = /^https?:\/\//i;
const MB = 1024 * 1024;

function assertMediaWithinLimit(sizeBytes: number, maxBytes?: number): void {
  if (typeof maxBytes !== "number" || maxBytes <= 0) return;
  if (sizeBytes <= maxBytes) return;
  const maxLabel = (maxBytes / MB).toFixed(0);
  const sizeLabel = (sizeBytes / MB).toFixed(2);
  throw new Error(`Media exceeds ${maxLabel}MB limit (got ${sizeLabel}MB)`);
}

function resolveLocalMediaPath(source: string): string {
  if (!source.startsWith("file://")) return source;
  try {
    return fileURLToPath(source);
  } catch {
    throw new Error(`Invalid file:// URL: ${source}`);
  }
}

function resolveFilenameFromSource(source?: string): string | undefined {
  if (!source) return undefined;
  if (source.startsWith("file://")) {
    try {
      return path.basename(fileURLToPath(source)) || undefined;
    } catch {
      return undefined;
    }
  }
  if (HTTP_URL_RE.test(source)) {
    try {
      return path.basename(new URL(source).pathname) || undefined;
    } catch {
      return undefined;
    }
  }
  const base = path.basename(source);
  return base || undefined;
}

export async function sendBlueBubblesMedia(params: {
  cfg: MoltbotConfig;
  to: string;
  mediaUrl?: string;
  mediaPath?: string;
  mediaBuffer?: Uint8Array;
  contentType?: string;
  filename?: string;
  caption?: string;
  replyToId?: string | null;
  accountId?: string;
  asVoice?: boolean;
}) {
  const {
    cfg,
    to,
    mediaUrl,
    mediaPath,
    mediaBuffer,
    contentType,
    filename,
    caption,
    replyToId,
    accountId,
    asVoice,
  } = params;
  const core = getBlueBubblesRuntime();
  const maxBytes = resolveChannelMediaMaxBytes({
    cfg,
    resolveChannelLimitMb: ({ cfg, accountId }) =>
      cfg.channels?.bluebubbles?.accounts?.[accountId]?.mediaMaxMb ??
      cfg.channels?.bluebubbles?.mediaMaxMb,
    accountId,
  });

  let buffer: Uint8Array;
  let resolvedContentType = contentType ?? undefined;
  let resolvedFilename = filename ?? undefined;

  if (mediaBuffer) {
    assertMediaWithinLimit(mediaBuffer.byteLength, maxBytes);
    buffer = mediaBuffer;
    if (!resolvedContentType) {
      const hint = mediaPath ?? mediaUrl;
      const detected = await core.media.detectMime({
        buffer: Buffer.isBuffer(mediaBuffer) ? mediaBuffer : Buffer.from(mediaBuffer),
        filePath: hint,
      });
      resolvedContentType = detected ?? undefined;
    }
    if (!resolvedFilename) {
      resolvedFilename = resolveFilenameFromSource(mediaPath ?? mediaUrl);
    }
  } else {
    const source = mediaPath ?? mediaUrl;
    if (!source) {
      throw new Error("BlueBubbles media delivery requires mediaUrl, mediaPath, or mediaBuffer.");
    }
    if (HTTP_URL_RE.test(source)) {
      const fetched = await core.channel.media.fetchRemoteMedia({
        url: source,
        maxBytes: typeof maxBytes === "number" && maxBytes > 0 ? maxBytes : undefined,
      });
      buffer = fetched.buffer;
      resolvedContentType = resolvedContentType ?? fetched.contentType ?? undefined;
      resolvedFilename = resolvedFilename ?? fetched.fileName;
    } else {
      const localPath = resolveLocalMediaPath(source);
      const fs = await import("node:fs/promises");
      if (typeof maxBytes === "number" && maxBytes > 0) {
        const stats = await fs.stat(localPath);
        assertMediaWithinLimit(stats.size, maxBytes);
      }
      const data = await fs.readFile(localPath);
      assertMediaWithinLimit(data.byteLength, maxBytes);
      buffer = new Uint8Array(data);
      if (!resolvedContentType) {
        const detected = await core.media.detectMime({
          buffer: data,
          filePath: localPath,
        });
        resolvedContentType = detected ?? undefined;
      }
      if (!resolvedFilename) {
        resolvedFilename = resolveFilenameFromSource(localPath);
      }
    }
  }

  // Resolve short ID (e.g., "5") to full UUID
  const replyToMessageGuid = replyToId?.trim()
    ? resolveBlueBubblesMessageId(replyToId.trim(), { requireKnownShortId: true })
    : undefined;

  const attachmentResult = await sendBlueBubblesAttachment({
    to,
    buffer,
    filename: resolvedFilename ?? "attachment",
    contentType: resolvedContentType ?? undefined,
    replyToMessageGuid,
    asVoice,
    opts: {
      cfg,
      accountId,
    },
  });

  const trimmedCaption = caption?.trim();
  if (trimmedCaption) {
    await sendMessageBlueBubbles(to, trimmedCaption, {
      cfg,
      accountId,
      replyToMessageGuid,
    });
  }

  return attachmentResult;
}
