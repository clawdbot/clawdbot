// File Transfer plugin module implements dir fetch behavior.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import { root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import {
  matchesFileIdentity,
  readPathBinding,
  type FileIdentity,
  type PathBinding,
} from "../shared/path-binding.js";
import { createTarArchive } from "./dir-fetch-archive.js";
import {
  classifyFsSafeReadError,
  readAbsolutePath,
  rejectCanonicalPathChange,
  resolveCanonicalReadPath,
  statRequiredDirectory,
} from "./path-errors.js";

const DIR_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
const DIR_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

type DirFetchParams = {
  path?: unknown;
  maxBytes?: unknown;
  includeDotfiles?: unknown;
  followSymlinks?: unknown;
  preflightOnly?: unknown;
  expectedCanonicalPath?: unknown;
  expectedBinding?: unknown;
};

type DirFetchOk = {
  ok: true;
  path: string;
  tarBase64: string;
  tarBytes: number;
  sha256: string;
  fileCount: number;
  entries?: string[];
  preflightOnly?: boolean;
  binding: PathBinding;
};

type DirFetchErrCode =
  | "INVALID_PATH"
  | "NOT_FOUND"
  | "IS_FILE"
  | "TREE_TOO_LARGE"
  | "SYMLINK_REDIRECT"
  | "CANONICAL_PATH_CHANGED"
  | "READ_ERROR";

type DirFetchErr = {
  ok: false;
  code: DirFetchErrCode;
  message: string;
  canonicalPath?: string;
};

type DirFetchResult = DirFetchOk | DirFetchErr;

function clampMaxBytes(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return DIR_FETCH_DEFAULT_MAX_BYTES;
  }
  return Math.min(Math.floor(input), DIR_FETCH_HARD_MAX_BYTES);
}

function classifyFsError(err: unknown): DirFetchErrCode {
  const safeCode = classifyFsSafeReadError(err);
  if (safeCode) {
    return safeCode;
  }
  const code = (err as { code?: string } | null)?.code;
  if (code === "ENOENT") {
    return "NOT_FOUND";
  }
  return "READ_ERROR";
}

async function preflightDu(dirPath: string, maxBytes: number): Promise<boolean> {
  // du -sk gives size in 1KB blocks (512-byte blocks on macOS with -k)
  // We use maxBytes * 4 as the rough heuristic ceiling (generous, gzip compresses)
  const heuristicKb = Math.ceil((maxBytes * 4) / 1024);
  const result = await runCommandBuffered(["du", "-sk", dirPath], {
    discardOutput: { stderr: true },
    maxOutputBytes: 64 * 1024,
    timeoutMs: 10_000,
  }).catch(() => null);
  if (!result || result.termination !== "exit" || result.code !== 0) {
    // `du` is optional; the capped tar command remains authoritative.
    return true;
  }
  const match = /^(\d+)/.exec(result.stdout.toString("utf8").trim());
  return match ? Number.parseInt(match[0], 10) <= heuristicKb : true;
}

async function listTarEntries(tarBuffer: Buffer): Promise<string[] | null> {
  const result = await runCommandBuffered(["tar", "-tzf", "-"], {
    discardOutput: { stderr: true },
    input: tarBuffer,
    maxOutputBytes: { stdout: 32 * 1024 * 1024, stderr: 64 * 1024 },
    timeoutMs: 10_000,
  }).catch(() => null);
  if (!result || result.termination !== "exit" || result.code !== 0) {
    return null;
  }
  const entries: string[] = [];
  const output = result.stdout.toString("utf8");
  let start = 0;
  while (start <= output.length) {
    const end = output.indexOf("\n", start);
    const rawLine = output.slice(start, end === -1 ? output.length : end);
    const line = rawLine.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
    if (line.length > 0) {
      entries.push(line);
    }
    if (end === -1) {
      break;
    }
    start = end + 1;
  }
  return entries.toSorted((left, right) => left.localeCompare(right));
}

async function listTreeEntries(
  root: string,
  maxEntries: number,
  expectedIdentity: FileIdentity,
): Promise<string[] | "TOO_MANY"> {
  const results: string[] = [];
  const rootHandle = await fsRoot(root);
  const boundStats = await fs.stat(rootHandle.rootReal, { bigint: true });
  if (!matchesFileIdentity(boundStats, expectedIdentity)) {
    throw Object.assign(new Error("filesystem identity differs from the authorized target"), {
      code: "CANONICAL_PATH_CHANGED",
    });
  }
  async function visit(relativeDir: string): Promise<boolean> {
    const entries = await rootHandle.list(relativeDir, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const rel = path.posix.join(relativeDir === "." ? "" : relativeDir, entry.name);
      results.push(rel);
      if (results.length > maxEntries) {
        return false;
      }
      if (entry.isDirectory) {
        const ok = await visit(rel);
        if (!ok) {
          return false;
        }
      }
    }
    return true;
  }
  return (await visit(".")) ? results : "TOO_MANY";
}

export async function handleDirFetch(params: DirFetchParams): Promise<DirFetchResult> {
  const requestedPath = readAbsolutePath(params.path);
  if (typeof requestedPath !== "string") {
    return requestedPath;
  }

  const maxBytes = clampMaxBytes(params.maxBytes);
  const includeDotfiles = params.includeDotfiles === true;
  const followSymlinks = params.followSymlinks === true;
  const preflightOnly = params.preflightOnly === true;

  const canonical = await resolveCanonicalReadPath({
    requestedPath,
    followSymlinks,
    classifyError: classifyFsError,
    notFoundMessage: "directory not found",
  });
  if (typeof canonical !== "string") {
    return canonical;
  }

  const canonicalPathChange = rejectCanonicalPathChange(params.expectedCanonicalPath, canonical);
  if (canonicalPathChange) {
    return canonicalPathChange;
  }

  const directory = await statRequiredDirectory(canonical, classifyFsError);
  if (!directory.ok) {
    return directory;
  }
  const expectedBinding = readPathBinding(params.expectedBinding);
  if (params.expectedBinding !== undefined && expectedBinding?.kind !== "existing") {
    return {
      ok: false,
      code: "CANONICAL_PATH_CHANGED",
      message: "filesystem identity differs from the authorized target",
      canonicalPath: canonical,
    };
  }
  if (
    expectedBinding?.kind === "existing" &&
    (expectedBinding.device !== directory.identity.device ||
      expectedBinding.inode !== directory.identity.inode)
  ) {
    return {
      ok: false,
      code: "CANONICAL_PATH_CHANGED",
      message: "filesystem identity differs from the authorized target",
      canonicalPath: canonical,
    };
  }
  const boundIdentity: FileIdentity =
    expectedBinding?.kind === "existing" ? expectedBinding : directory.identity;

  if (preflightOnly) {
    let entries: string[] | "TOO_MANY";
    try {
      entries = await listTreeEntries(canonical, 5000, boundIdentity);
    } catch (err) {
      const errorCode = err && typeof err === "object" && "code" in err ? err.code : undefined;
      const code =
        errorCode === "CANONICAL_PATH_CHANGED" ? "CANONICAL_PATH_CHANGED" : classifyFsError(err);
      return {
        ok: false,
        code,
        message: `preflight readdir failed: ${String(err)}`,
        canonicalPath: canonical,
      };
    }
    if (entries === "TOO_MANY") {
      return {
        ok: false,
        code: "TREE_TOO_LARGE",
        message: "directory tree exceeds 5000 entries during preflight",
        canonicalPath: canonical,
      };
    }

    const tarBuffer = await createTarArchive(
      canonical,
      canonical,
      boundIdentity.device,
      boundIdentity.inode,
      maxBytes,
    );
    if (tarBuffer === "TOO_LARGE") {
      return {
        ok: false,
        code: "TREE_TOO_LARGE",
        message: `tarball exceeded ${maxBytes} byte limit during preflight`,
        canonicalPath: canonical,
      };
    }
    if (tarBuffer === "TIMEOUT") {
      return {
        ok: false,
        code: "READ_ERROR",
        message: "tar command exceeded 60s wall-clock timeout (slow filesystem or symlink loop?)",
        canonicalPath: canonical,
      };
    }
    if (tarBuffer === "CANONICAL_PATH_CHANGED") {
      return {
        ok: false,
        code: "CANONICAL_PATH_CHANGED",
        message: "canonical path differs from the authorized target",
        canonicalPath: canonical,
      };
    }
    if (tarBuffer === "ERROR") {
      const currentDirectory = await statRequiredDirectory(canonical, classifyFsError);
      if (!currentDirectory.ok) {
        return currentDirectory;
      }
      return {
        ok: false,
        code: "READ_ERROR",
        message: "tar command failed",
        canonicalPath: canonical,
      };
    }
    return {
      ok: true,
      path: canonical,
      tarBase64: "",
      tarBytes: 0,
      sha256: "",
      fileCount: entries.length,
      entries,
      preflightOnly: true,
      binding: { kind: "existing", ...directory.identity },
    };
  }

  // Preflight size check using du
  const withinBudget = await preflightDu(canonical, maxBytes);
  if (!withinBudget) {
    return {
      ok: false,
      code: "TREE_TOO_LARGE",
      message: `directory tree exceeds estimated size limit (${maxBytes} bytes raw)`,
      canonicalPath: canonical,
    };
  }

  // Build tar args. Shell out to /usr/bin/tar for portability.
  // -cz: create + gzip
  // -C <dir>: change to directory so paths in archive are relative
  // .: include everything from that directory
  // v1: includeDotfiles is accepted in the API but not enforced. BSD tar's
  // --exclude pattern matching is unreliable for dotfiles (every plausible
  // pattern except "*/.*" collapses the archive on macOS). Reliable filtering
  // requires a `find ! -name '.*' | tar -T -` pipeline; deferred to v2.
  // For now we always archive everything in the directory.
  void includeDotfiles;
  // Capture tar output with a hard byte cap and a wall-clock timeout.
  // SIGTERM if the byte cap is exceeded; SIGKILL if the timeout fires
  // (covers tar hanging on a slow filesystem or symlink loop).
  const tarBuffer = await createTarArchive(
    canonical,
    canonical,
    boundIdentity.device,
    boundIdentity.inode,
    maxBytes,
  );

  if (tarBuffer === "TOO_LARGE") {
    return {
      ok: false,
      code: "TREE_TOO_LARGE",
      message: `tarball exceeded ${maxBytes} byte limit mid-stream`,
      canonicalPath: canonical,
    };
  }
  if (tarBuffer === "TIMEOUT") {
    return {
      ok: false,
      code: "READ_ERROR",
      message: "tar command exceeded 60s wall-clock timeout (slow filesystem or symlink loop?)",
      canonicalPath: canonical,
    };
  }
  if (tarBuffer === "CANONICAL_PATH_CHANGED") {
    return {
      ok: false,
      code: "CANONICAL_PATH_CHANGED",
      message: "canonical path differs from the authorized target",
      canonicalPath: canonical,
    };
  }
  if (tarBuffer === "ERROR") {
    return {
      ok: false,
      code: "READ_ERROR",
      message: "tar command failed",
      canonicalPath: canonical,
    };
  }

  const sha256 = crypto.createHash("sha256").update(tarBuffer).digest("hex");
  const tarBase64 = tarBuffer.toString("base64");
  const tarBytes = tarBuffer.byteLength;
  const entries = await listTarEntries(tarBuffer);
  if (entries === null) {
    return {
      ok: false,
      code: "READ_ERROR",
      message: "tar entry listing failed",
      canonicalPath: canonical,
    };
  }

  return {
    ok: true,
    path: canonical,
    tarBase64,
    tarBytes,
    sha256,
    fileCount: entries.length,
    entries,
    binding: { kind: "existing", ...directory.identity },
  };
}
