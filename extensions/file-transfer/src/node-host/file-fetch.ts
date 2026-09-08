// File Transfer plugin module implements file fetch behavior.
import crypto from "node:crypto";
import path from "node:path";
import { detectMime } from "openclaw/plugin-sdk/media-mime";
import { root } from "openclaw/plugin-sdk/security-runtime";
import {
  fileIdentity,
  matchesFileIdentity,
  readPathBinding,
  type PathBinding,
} from "../shared/path-binding.js";
import {
  classifyFsSafeReadError,
  readAbsolutePath,
  rejectCanonicalPathChange,
  resolveCanonicalReadPath,
} from "./path-errors.js";

const FILE_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
const FILE_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const TEXT_SNIFF_MAX_BYTES = 8192;

type FileFetchParams = {
  path?: unknown;
  maxBytes?: unknown;
  followSymlinks?: unknown;
  preflightOnly?: unknown;
  expectedCanonicalPath?: unknown;
  expectedBinding?: unknown;
};

type FileFetchOk = {
  ok: true;
  path: string;
  size: number;
  mimeType: string;
  base64: string;
  sha256: string;
  preflightOnly?: boolean;
  binding: PathBinding;
};

type FileFetchErrCode =
  | "INVALID_PATH"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "IS_DIRECTORY"
  | "FILE_TOO_LARGE"
  | "PATH_TRAVERSAL"
  | "SYMLINK_REDIRECT"
  | "CANONICAL_PATH_CHANGED"
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
  const safeCode = classifyFsSafeReadError(err);
  if (safeCode) {
    return safeCode;
  }
  const code = (err as { code?: string } | null)?.code;
  if (code === "not-file") {
    return "IS_DIRECTORY";
  }
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
  const requestedPath = readAbsolutePath(params.path);
  if (typeof requestedPath !== "string") {
    return requestedPath;
  }

  const maxBytes = clampMaxBytes(params.maxBytes);
  const followSymlinks = params.followSymlinks === true;
  const preflightOnly = params.preflightOnly === true;

  const canonical = await resolveCanonicalReadPath({
    requestedPath,
    followSymlinks,
    classifyError: classifyFsError,
    notFoundMessage: "file not found",
  });
  if (typeof canonical !== "string") {
    return canonical;
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
    const canonicalPathChange = rejectCanonicalPathChange(
      params.expectedCanonicalPath,
      opened.realPath,
    );
    if (canonicalPathChange) {
      return canonicalPathChange;
    }
    const stats = opened.stat;
    const identityStats = await opened.handle.stat({ bigint: true });
    const identity = fileIdentity(identityStats);
    const expectedBinding = readPathBinding(params.expectedBinding);
    if (
      (params.expectedBinding !== undefined && expectedBinding?.kind !== "existing") ||
      (expectedBinding?.kind === "existing" && !matchesFileIdentity(identityStats, expectedBinding))
    ) {
      return {
        ok: false,
        code: "CANONICAL_PATH_CHANGED",
        message: "filesystem identity differs from the authorized target",
        canonicalPath: opened.realPath,
      };
    }
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
        binding: { kind: "existing", ...identity },
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
      binding: { kind: "existing", ...identity },
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
