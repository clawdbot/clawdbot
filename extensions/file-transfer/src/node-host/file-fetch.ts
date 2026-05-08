import crypto from "node:crypto";
import path from "node:path";
import { detectMime } from "openclaw/plugin-sdk/media-mime";
import {
  FsSafeError,
  resolveAbsolutePathForRead,
  root,
} from "openclaw/plugin-sdk/security-runtime";

export const FILE_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
export const FILE_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const TEXT_SNIFF_MAX_BYTES = 8192;

type FileFetchParams = {
  path?: unknown;
  maxBytes?: unknown;
  followSymlinks?: unknown;
  preflightOnly?: unknown;
};

type FileFetchOk = {
  ok: true;
  path: string;
  size: number;
  mimeType: string;
  base64: string;
  sha256: string;
  preflightOnly?: boolean;
};

type FileFetchErrCode =
  | "INVALID_PATH"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "IS_DIRECTORY"
  | "FILE_TOO_LARGE"
  | "PATH_TRAVERSAL"
  | "SYMLINK_REDIRECT"
  | "READ_ERROR";

type FileFetchErr = {
  ok: false;
  code: FileFetchErrCode;
  message: string;
  canonicalPath?: string;
};

type FileFetchResult = FileFetchOk | FileFetchErr;

function clampMaxBytes(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return FILE_FETCH_DEFAULT_MAX_BYTES;
  }
  return Math.min(Math.floor(input), FILE_FETCH_HARD_MAX_BYTES);
}

function classifyFsError(err: unknown): FileFetchErrCode {
  if (err instanceof FsSafeError) {
    if (err.code === "not-found") {
      return "NOT_FOUND";
    }
    if (err.code === "symlink") {
      return "SYMLINK_REDIRECT";
    }
    if (err.code === "invalid-path") {
      return "INVALID_PATH";
    }
    if (err.code === "not-file") {
      return "IS_DIRECTORY";
    }
  }
  const code = (err as { code?: string } | null)?.code;
  if (code === "ENOENT") {
    return "NOT_FOUND";
  }
  if (code === "EACCES" || code === "EPERM") {
    return "PERMISSION_DENIED";
  }
  if (code === "EISDIR") {
    return "IS_DIRECTORY";
  }
  return "READ_ERROR";
}

function isLikelyPlainText(buffer: Buffer): boolean {
  if (buffer.byteLength === 0) {
    return true;
  }
  const sample = buffer.subarray(0, TEXT_SNIFF_MAX_BYTES);
  if (sample.includes(0)) {
    return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
  } catch {
    return false;
  }
  let controlBytes = 0;
  for (const byte of sample) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      controlBytes += 1;
    }
  }
  return controlBytes / sample.byteLength < 0.01;
}

async function detectFetchedFileMime(params: {
  buffer: Buffer;
  filePath: string;
}): Promise<string> {
  const detected = await detectMime(params);
  if (detected) {
    return detected;
  }
  return isLikelyPlainText(params.buffer) ? "text/plain" : "application/octet-stream";
}

export async function handleFileFetch(params: FileFetchParams): Promise<FileFetchResult> {
  const requestedPath = params.path;
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    return { ok: false, code: "INVALID_PATH", message: "path required" };
  }
  if (requestedPath.includes("\0")) {
    return { ok: false, code: "INVALID_PATH", message: "path contains NUL byte" };
  }
  if (!path.isAbsolute(requestedPath)) {
    return { ok: false, code: "INVALID_PATH", message: "path must be absolute" };
  }

  const maxBytes = clampMaxBytes(params.maxBytes);
  const followSymlinks = params.followSymlinks === true;
  const preflightOnly = params.preflightOnly === true;

  let canonical: string;
  try {
    canonical = (
      await resolveAbsolutePathForRead(requestedPath, {
        symlinks: followSymlinks ? "follow" : "reject",
      })
    ).canonicalPath;
  } catch (err) {
    const code = classifyFsError(err);
    const canonicalPath =
      err instanceof FsSafeError &&
      err.cause &&
      typeof err.cause === "object" &&
      "canonicalPath" in err.cause &&
      typeof err.cause.canonicalPath === "string"
        ? err.cause.canonicalPath
        : undefined;
    return {
      ok: false,
      code,
      message:
        code === "NOT_FOUND"
          ? "file not found"
          : code === "SYMLINK_REDIRECT"
            ? "path traverses a symlink; refusing because followSymlinks=false (set plugins.entries.file-transfer.config.nodes.<node>.followSymlinks=true to allow, or update allowReadPaths to the canonical path)"
            : `realpath failed: ${String(err)}`,
      ...(canonicalPath ? { canonicalPath } : {}),
    };
  }

  let opened: Awaited<ReturnType<Awaited<ReturnType<typeof root>>["open"]>>;
  try {
    const parentRoot = await root(path.dirname(canonical));
    opened = await parentRoot.open(path.basename(canonical));
  } catch (err) {
    const code = classifyFsError(err);
    return {
      ok: false,
      code,
      message: code === "IS_DIRECTORY" ? "path is a directory" : `open failed: ${String(err)}`,
      canonicalPath: canonical,
    };
  }

  try {
    const stats = opened.stat;
    if (stats.size > maxBytes) {
      return {
        ok: false,
        code: "FILE_TOO_LARGE",
        message: `file size ${stats.size} exceeds limit ${maxBytes}`,
        canonicalPath: opened.realPath,
      };
    }

    if (preflightOnly) {
      return {
        ok: true,
        path: opened.realPath,
        size: stats.size,
        mimeType: "",
        base64: "",
        sha256: "",
        preflightOnly: true,
      };
    }

    const buffer = await opened.handle.readFile();
    if (buffer.byteLength > maxBytes) {
      return {
        ok: false,
        code: "FILE_TOO_LARGE",
        message: `read ${buffer.byteLength} bytes exceeds limit ${maxBytes}`,
        canonicalPath: opened.realPath,
      };
    }

    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const base64 = buffer.toString("base64");
    const mimeType = await detectFetchedFileMime({ buffer, filePath: opened.realPath });

    return {
      ok: true,
      path: opened.realPath,
      size: buffer.byteLength,
      mimeType,
      base64,
      sha256,
    };
  } catch (err) {
    const code = classifyFsError(err);
    return {
      ok: false,
      code,
      message: `read failed: ${String(err)}`,
      canonicalPath: opened.realPath,
    };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}
