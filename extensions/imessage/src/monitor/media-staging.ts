// Imessage plugin module implements media staging behavior.
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ChannelInboundMediaInput } from "openclaw/plugin-sdk/channel-inbound";
import { isInboundPathAllowed, kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { openLocalFileSafely } from "openclaw/plugin-sdk/security-runtime";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import type { IMessageAttachment } from "./types.js";

type StagedIMessageAttachment = ChannelInboundMediaInput;

type StagedIMessageAttachments = {
  attachments: StagedIMessageAttachment[];
  unavailableCount: number;
};

type SaveMediaBufferImpl = typeof saveMediaBuffer;

type StageIMessageAttachmentsDeps = {
  saveMediaBuffer?: SaveMediaBufferImpl;
  convertHeicToJpeg?: (sourcePath: string, maxBytes: number) => Promise<Buffer>;
  openLocalFileSafely?: typeof openLocalFileSafely;
  logVerbose?: (message: string) => void;
};

function createTypeOnlyIMessageAttachment(
  attachment: IMessageAttachment,
): StagedIMessageAttachment {
  const contentType = attachment.mime_type?.trim() || undefined;
  return { contentType, kind: kindFromMime(contentType) ?? "unknown" };
}

function isHeicAttachment(attachmentPath: string, mimeType?: string | null): boolean {
  const normalizedMime = mimeType?.toLowerCase();
  if (normalizedMime === "image/heic" || normalizedMime === "image/heif") {
    return true;
  }
  const ext = path.extname(attachmentPath).toLowerCase();
  return ext === ".heic" || ext === ".heif";
}

function jpegFilenameForAttachment(attachmentPath: string): string {
  const parsed = path.parse(attachmentPath);
  return `${parsed.name || "imessage-attachment"}.jpg`;
}

function hasWildcardSegment(root: string): boolean {
  return root.replaceAll("\\", "/").split("/").includes("*");
}

async function canonicalizeAllowedRoots(roots: readonly string[]): Promise<string[]> {
  const canonicalRoots: string[] = [];
  for (const root of roots) {
    canonicalRoots.push(root);
    if (hasWildcardSegment(root)) {
      continue;
    }
    const canonicalRoot = await fs.realpath(root).catch(() => undefined);
    if (canonicalRoot && canonicalRoot !== root) {
      canonicalRoots.push(canonicalRoot);
    }
  }
  return canonicalRoots;
}

async function assertAllowedCanonicalAttachmentPath(params: {
  canonicalPath: string;
  allowedRoots?: readonly string[];
}): Promise<void> {
  if (!params.allowedRoots) {
    return;
  }
  const canonicalRoots = await canonicalizeAllowedRoots(params.allowedRoots);
  if (!isInboundPathAllowed({ filePath: params.canonicalPath, roots: canonicalRoots })) {
    throw new Error("attachment path resolves outside allowed roots");
  }
}

async function readPinnedAttachmentBytes(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes <= maxBytes) {
    const remaining = maxBytes + 1 - totalBytes;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) {
      return Buffer.concat(chunks, totalBytes);
    }
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  throw new Error(`attachment exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
}

async function readAttachmentBuffer(params: {
  attachmentPath: string;
  mimeType?: string | null;
  maxBytes: number;
  allowedRoots?: readonly string[];
  deps: StageIMessageAttachmentsDeps;
}): Promise<{ buffer: Buffer; contentType?: string; originalFilename?: string }> {
  const opened = await (params.deps.openLocalFileSafely ?? openLocalFileSafely)({
    filePath: params.attachmentPath,
  });
  try {
    if (opened.stat.size > params.maxBytes) {
      throw new Error(`attachment exceeds ${Math.round(params.maxBytes / (1024 * 1024))}MB limit`);
    }
    await assertAllowedCanonicalAttachmentPath({
      canonicalPath: opened.realPath,
      allowedRoots: params.allowedRoots,
    });
    // The inode can grow after the pinned open; keep the allocation bounded as well as the stat.
    const buffer = await readPinnedAttachmentBytes(opened.handle, params.maxBytes);

    if (isHeicAttachment(params.attachmentPath, params.mimeType)) {
      try {
        const convert = params.deps.convertHeicToJpeg;
        const converted = await withTempWorkspace(
          { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-imessage-heic-" },
          async (workspace) => {
            const pinnedPath = await workspace.write("attachment.heic", buffer);
            return convert
              ? {
                  buffer: await convert(pinnedPath, params.maxBytes),
                }
              : await loadWebMedia(pinnedPath, {
                  maxBytes: params.maxBytes,
                  localRoots: [workspace.dir],
                });
          },
        );
        return {
          buffer: converted.buffer,
          contentType: "image/jpeg",
          originalFilename: jpegFilenameForAttachment(params.attachmentPath),
        };
      } catch (err) {
        params.deps.logVerbose?.(
          `imessage: HEIC attachment conversion failed; staging original instead: ${String(err)}`,
        );
      }
    }

    return {
      buffer,
      contentType: params.mimeType ?? undefined,
      originalFilename: path.basename(params.attachmentPath),
    };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

export async function stageIMessageAttachments(
  attachments: IMessageAttachment[],
  params: {
    maxBytes: number;
    allowedRoots?: readonly string[];
    deps?: StageIMessageAttachmentsDeps;
  },
): Promise<StagedIMessageAttachments> {
  const deps = params.deps ?? {};
  const save = deps.saveMediaBuffer ?? saveMediaBuffer;
  const staged: StagedIMessageAttachment[] = [];
  let unavailableCount = 0;

  for (const attachment of attachments) {
    const attachmentPath = attachment.original_path?.trim();
    if (!attachmentPath || attachment.missing) {
      unavailableCount += 1;
      staged.push(createTypeOnlyIMessageAttachment(attachment));
      continue;
    }

    try {
      const media = await readAttachmentBuffer({
        attachmentPath,
        mimeType: attachment.mime_type,
        maxBytes: params.maxBytes,
        allowedRoots: params.allowedRoots,
        deps,
      });
      const saved = await save(
        media.buffer,
        media.contentType,
        "inbound",
        params.maxBytes,
        media.originalFilename,
      );
      const contentType = saved.contentType ?? media.contentType;
      staged.push({
        path: saved.path,
        contentType,
        kind: kindFromMime(contentType) ?? "unknown",
      });
    } catch (err) {
      unavailableCount += 1;
      staged.push(createTypeOnlyIMessageAttachment(attachment));
      deps.logVerbose?.(`imessage: failed to stage inbound attachment: ${String(err)}`);
    }
  }

  return { attachments: staged, unavailableCount };
}
