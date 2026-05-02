import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EXTENSION_MIME } from "../shared/mime.js";

export const FILE_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
export const FILE_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

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

function detectMimeType(filePath: string): string {
  if (process.platform !== "win32") {
    try {
      const result = spawnSync("file", ["-b", "--mime-type", filePath], {
        encoding: "utf-8",
        timeout: 2000,
      });
      const stdout = result.stdout?.trim();
      if (result.status === 0 && stdout) {
        return stdout;
      }
    } catch {
      // fall through to extension fallback
    }
  }
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MIME[ext] ?? "application/octet-stream";
}

function clampMaxBytes(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return FILE_FETCH_DEFAULT_MAX_BYTES;
  }
  return Math.min(Math.floor(input), FILE_FETCH_HARD_MAX_BYTES);
}

function classifyFsError(err: unknown): FileFetchErrCode {
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
    canonical = await fs.realpath(requestedPath);
  } catch (err) {
    const code = classifyFsError(err);
    return {
      ok: false,
      code,
      message: code === "NOT_FOUND" ? "file not found" : `realpath failed: ${String(err)}`,
    };
  }

  // Refuse to follow symlinks anywhere in the path unless the operator
  // has explicitly opted in. A symlink in user-controlled territory
  // (e.g. ~/Downloads/evil → /etc) could redirect an allowed-looking
  // request to a disallowed canonical target. The error includes the
  // canonical path so the operator can either update their allowlist
  // to the canonical form or set followSymlinks=true on this node.
  if (!followSymlinks && canonical !== requestedPath) {
    return {
      ok: false,
      code: "SYMLINK_REDIRECT",
      message: `path traverses a symlink; refusing because followSymlinks=false (set plugins.entries.file-transfer.config.nodes.<node>.followSymlinks=true to allow, or update allowReadPaths to the canonical path)`,
      canonicalPath: canonical,
    };
  }

  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(canonical);
  } catch (err) {
    const code = classifyFsError(err);
    return { ok: false, code, message: `stat failed: ${String(err)}`, canonicalPath: canonical };
  }

  if (stats.isDirectory()) {
    return {
      ok: false,
      code: "IS_DIRECTORY",
      message: "path is a directory",
      canonicalPath: canonical,
    };
  }
  if (!stats.isFile()) {
    return {
      ok: false,
      code: "READ_ERROR",
      message: "path is not a regular file",
      canonicalPath: canonical,
    };
  }
  if (stats.size > maxBytes) {
    return {
      ok: false,
      code: "FILE_TOO_LARGE",
      message: `file size ${stats.size} exceeds limit ${maxBytes}`,
      canonicalPath: canonical,
    };
  }

  if (preflightOnly) {
    return {
      ok: true,
      path: canonical,
      size: stats.size,
      mimeType: "",
      base64: "",
      sha256: "",
      preflightOnly: true,
    };
  }

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(canonical);
  } catch (err) {
    const code = classifyFsError(err);
    return { ok: false, code, message: `read failed: ${String(err)}`, canonicalPath: canonical };
  }

  if (buffer.byteLength > maxBytes) {
    return {
      ok: false,
      code: "FILE_TOO_LARGE",
      message: `read ${buffer.byteLength} bytes exceeds limit ${maxBytes}`,
      canonicalPath: canonical,
    };
  }

  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const base64 = buffer.toString("base64");
  const mimeType = detectMimeType(canonical);

  return {
    ok: true,
    path: canonical,
    size: buffer.byteLength,
    mimeType,
    base64,
    sha256,
  };
}
