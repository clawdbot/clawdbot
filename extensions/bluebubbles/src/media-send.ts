import {
  basenameFromMediaSource,
  readLocalFileFromRoots,
} from "openclaw/plugin-sdk/file-access-runtime";
import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/media-runtime";
import { resolveBlueBubblesAccount } from "./accounts.js";
import { sendBlueBubblesAttachment } from "./attachments.js";
import { resolveBlueBubblesMessageId } from "./monitor-reply-cache.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { getBlueBubblesRuntime } from "./runtime.js";
import { sendMessageBlueBubbles } from "./send.js";
import { buildBlueBubblesChatContextFromTarget } from "./targets.js";

const HTTP_URL_RE = /^https?:\/\//i;
const MB = 1024 * 1024;

function assertMediaWithinLimit(sizeBytes: number, maxBytes?: number): void {
  if (typeof maxBytes !== "number" || maxBytes <= 0) {
    return;
  }
  if (sizeBytes <= maxBytes) {
    return;
  }
  const maxLabel = (maxBytes / MB).toFixed(0);
  const sizeLabel = (sizeBytes / MB).toFixed(2);
  throw new Error(`Media exceeds ${maxLabel}MB limit (got ${sizeLabel}MB)`);
}

function resolveMediaLocalRoots(params: { cfg: OpenClawConfig; accountId?: string }): string[] {
  const account = resolveBlueBubblesAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  return (account.config.mediaLocalRoots ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function assertLocalMediaPathAllowed(params: {
  localPath: string;
  localRoots: string[];
  accountId?: string;
}): Promise<{ data: Buffer; realPath: string; sizeBytes: number }> {
  if (params.localRoots.length === 0) {
    throw new Error(
      `Local BlueBubbles media paths are disabled by default. Set channels.bluebubbles.mediaLocalRoots${
        params.accountId
          ? ` or channels.bluebubbles.accounts.${params.accountId}.mediaLocalRoots`
          : ""
      } to explicitly allow local file directories.`,
    );
  }

  const localFile = await readLocalFileFromRoots({
    filePath: params.localPath,
    roots: params.localRoots,
    label: "mediaLocalRoots",
  });
  if (localFile) {
    return {
      data: localFile.buffer,
      realPath: localFile.realPath,
      sizeBytes: localFile.stat.size,
    };
  }

  throw new Error(
    `Local media path is not under any configured mediaLocalRoots entry: ${params.localPath}`,
  );
}

function resolveFilenameFromSource(source?: string): string | undefined {
  return basenameFromMediaSource(source);
}

export async function sendBlueBubblesMedia(params: {
  cfg: OpenClawConfig;
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
      (cfg.channels?.bluebubbles?.accounts?.[accountId] as { mediaMaxMb?: number } | undefined)
        ?.mediaMaxMb ?? cfg.channels?.bluebubbles?.mediaMaxMb,
    accountId,
  });
  const mediaLocalRoots = resolveMediaLocalRoots({ cfg, accountId });

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
      const localFile = await assertLocalMediaPathAllowed({
        localPath: source,
        localRoots: mediaLocalRoots,
        accountId,
      });
      if (typeof maxBytes === "number" && maxBytes > 0) {
        assertMediaWithinLimit(localFile.sizeBytes, maxBytes);
      }
      const data = localFile.data;
      assertMediaWithinLimit(data.byteLength, maxBytes);
      buffer = new Uint8Array(data);
      if (!resolvedContentType) {
        const detected = await core.media.detectMime({
          buffer: data,
          filePath: localFile.realPath,
        });
        resolvedContentType = detected ?? undefined;
      }
      if (!resolvedFilename) {
        resolvedFilename = resolveFilenameFromSource(localFile.realPath);
      }
    }
  }

  // Resolve short ID (e.g., "5") to full UUID, scoped to `to` so a short ID
  // tied to a message in a different chat cannot silently redirect the media
  // reply into the wrong conversation (cross-chat guard).
  const replyToMessageGuid = replyToId?.trim()
    ? resolveBlueBubblesMessageId(replyToId.trim(), {
        requireKnownShortId: true,
        chatContext: buildBlueBubblesChatContextFromTarget(to),
      })
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
