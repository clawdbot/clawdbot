import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/media-runtime";
import { lowercasePreservingWhitespace } from "openclaw/plugin-sdk/text-runtime";
import { resolveBlueBubblesAccount } from "./accounts.js";
import { sendBlueBubblesAttachment } from "./attachments.js";
import { basenameFromMediaSource, safeFileURLToPath } from "./local-file-access.js";
import { resolveBlueBubblesMessageId } from "./monitor-reply-cache.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { getBlueBubblesRuntime } from "./runtime.js";
import { sendMessageBlueBubbles } from "./send.js";

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

function resolveLocalMediaPath(source: string): string {
  if (!source.startsWith("file://")) {
    return source;
  }
  try {
    return safeFileURLToPath(source);
  } catch {
    throw new Error(`Invalid file:// URL: ${source}`);
  }
}

function expandHomePath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolveConfiguredPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Empty mediaLocalRoots entry is not allowed");
  }
  if (trimmed.startsWith("file://")) {
    try {
      return safeFileURLToPath(trimmed);
    } catch {
      throw new Error(`Invalid file:// URL in mediaLocalRoots: ${input}`);
    }
  }
  const resolved = expandHomePath(trimmed);
  if (!path.isAbsolute(resolved)) {
    throw new Error(`mediaLocalRoots entries must be absolute paths: ${input}`);
  }
  return resolved;
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = path.normalize(candidate);
  const normalizedRoot = path.normalize(root);
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;
  if (process.platform === "win32") {
    const candidateLower = lowercasePreservingWhitespace(normalizedCandidate);
    const rootLower = lowercasePreservingWhitespace(normalizedRoot);
    const rootWithSepLower = lowercasePreservingWhitespace(rootWithSep);
    return candidateLower === rootLower || candidateLower.startsWith(rootWithSepLower);
  }
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(rootWithSep);
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

  const resolvedLocalPath = path.resolve(params.localPath);
  const supportsNoFollow = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
  const openFlags = fsConstants.O_RDONLY | (supportsNoFollow ? fsConstants.O_NOFOLLOW : 0);

  for (const rootEntry of params.localRoots) {
    const resolvedRootInput = resolveConfiguredPath(rootEntry);
    const relativeToRoot = path.relative(resolvedRootInput, resolvedLocalPath);
    if (
      relativeToRoot.startsWith("..") ||
      path.isAbsolute(relativeToRoot) ||
      relativeToRoot === ""
    ) {
      continue;
    }

    let rootReal: string;
    try {
      rootReal = await fs.realpath(resolvedRootInput);
    } catch {
      rootReal = path.resolve(resolvedRootInput);
    }
    const candidatePath = path.resolve(rootReal, relativeToRoot);

    if (!isPathInsideRoot(candidatePath, rootReal)) {
      continue;
    }

    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(candidatePath, openFlags);
      const realPath = await fs.realpath(candidatePath);
      if (!isPathInsideRoot(realPath, rootReal)) {
        continue;
      }

      const stat = await handle.stat();
      if (!stat.isFile()) {
        continue;
      }
      const realStat = await fs.stat(realPath);
      if (stat.ino !== realStat.ino || stat.dev !== realStat.dev) {
        continue;
      }

      const data = await handle.readFile();
      return { data, realPath, sizeBytes: stat.size };
    } catch {
      // Try next configured root.
      continue;
    } finally {
      if (handle) {
        await handle.close().catch(() => {});
      }
    }
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
      const localPath = expandHomePath(resolveLocalMediaPath(source));
      const localFile = await assertLocalMediaPathAllowed({
        localPath,
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
