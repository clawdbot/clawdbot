import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isInboundPathAllowed } from "openclaw/plugin-sdk/media-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { buildRandomTempFilePath } from "openclaw/plugin-sdk/temp-path";
import type { IMessageAttachment } from "./types.js";

const execFileAsync = promisify(execFile);

const HEIC_CONVERSION_TIMEOUT_MS = 15_000;
const HEIC_CONVERSION_MAX_BUFFER_BYTES = 64 * 1024;

export type StagedIMessageAttachment = {
  path: string;
  contentType?: string;
};

type SaveMediaBufferImpl = typeof saveMediaBuffer;

type StageIMessageAttachmentsDeps = {
  saveMediaBuffer?: SaveMediaBufferImpl;
  convertHeicToJpeg?: (sourcePath: string, maxBytes: number) => Promise<Buffer>;
  logVerbose?: (message: string) => void;
};

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

async function resolveAllowedCanonicalAttachmentPath(params: {
  attachmentPath: string;
  allowedRoots?: readonly string[];
}): Promise<string> {
  if (!params.allowedRoots) {
    return params.attachmentPath;
  }
  const canonicalPath = await fs.realpath(params.attachmentPath);
  const canonicalRoots = await canonicalizeAllowedRoots(params.allowedRoots);
  if (!isInboundPathAllowed({ filePath: canonicalPath, roots: canonicalRoots })) {
    throw new Error("attachment path resolves outside allowed roots");
  }
  return canonicalPath;
}

async function convertHeicToJpegWithSips(sourcePath: string, maxBytes: number): Promise<Buffer> {
  const tempPath = buildRandomTempFilePath({
    prefix: "openclaw-imessage",
    extension: "jpg",
  });
  try {
    await execFileAsync(
      "sips",
      [
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        "90",
        "-Z",
        "4096",
        sourcePath,
        "--out",
        tempPath,
      ],
      {
        timeout: HEIC_CONVERSION_TIMEOUT_MS,
        maxBuffer: HEIC_CONVERSION_MAX_BUFFER_BYTES,
        killSignal: "SIGKILL",
      },
    );
    const stat = await fs.stat(tempPath);
    if (stat.size > maxBytes) {
      throw new Error(`converted media exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
    }
    return await fs.readFile(tempPath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function readAttachmentBuffer(params: {
  attachmentPath: string;
  mimeType?: string | null;
  maxBytes: number;
  allowedRoots?: readonly string[];
  deps: StageIMessageAttachmentsDeps;
}): Promise<{ buffer: Buffer; contentType?: string; originalFilename?: string }> {
  const stat = await fs.lstat(params.attachmentPath);
  if (stat.isSymbolicLink()) {
    throw new Error("attachment path is a symlink");
  }
  if (!stat.isFile()) {
    throw new Error("attachment path is not a file");
  }
  if (stat.size > params.maxBytes) {
    throw new Error(`attachment exceeds ${Math.round(params.maxBytes / (1024 * 1024))}MB limit`);
  }

  const canonicalPath = await resolveAllowedCanonicalAttachmentPath({
    attachmentPath: params.attachmentPath,
    allowedRoots: params.allowedRoots,
  });
  const canonicalStat = await fs.stat(canonicalPath);
  if (!canonicalStat.isFile()) {
    throw new Error("attachment path is not a file");
  }
  if (canonicalStat.size > params.maxBytes) {
    throw new Error(`attachment exceeds ${Math.round(params.maxBytes / (1024 * 1024))}MB limit`);
  }

  if (isHeicAttachment(params.attachmentPath, params.mimeType)) {
    try {
      const convert = params.deps.convertHeicToJpeg ?? convertHeicToJpegWithSips;
      return {
        buffer: await convert(canonicalPath, params.maxBytes),
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
    buffer: await fs.readFile(canonicalPath),
    contentType: params.mimeType ?? undefined,
    originalFilename: path.basename(params.attachmentPath),
  };
}

export async function stageIMessageAttachments(
  attachments: IMessageAttachment[],
  params: {
    maxBytes: number;
    allowedRoots?: readonly string[];
    deps?: StageIMessageAttachmentsDeps;
  },
): Promise<StagedIMessageAttachment[]> {
  const deps = params.deps ?? {};
  const save = deps.saveMediaBuffer ?? saveMediaBuffer;
  const staged: StagedIMessageAttachment[] = [];

  for (const attachment of attachments) {
    const attachmentPath = attachment.original_path?.trim();
    if (!attachmentPath || attachment.missing) {
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
      staged.push({ path: saved.path, contentType: saved.contentType });
    } catch (err) {
      deps.logVerbose?.(`imessage: failed to stage inbound attachment: ${String(err)}`);
    }
  }

  return staged;
}
