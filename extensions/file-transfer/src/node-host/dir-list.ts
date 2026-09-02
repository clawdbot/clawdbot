// File Transfer plugin module implements dir list behavior.
import path from "node:path";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { mimeFromExtension } from "../shared/mime.js";
import type { PathBinding } from "../shared/path-binding.js";
import { listCanonicalDirectory } from "./dir-list-worker.js";
import {
  classifyFsSafeReadError,
  readAbsolutePath,
  resolveBoundReadDirectory,
  statRequiredDirectory,
} from "./path-errors.js";

const DIR_LIST_DEFAULT_MAX_ENTRIES = 200;
const DIR_LIST_HARD_MAX_ENTRIES = 5000;

type DirListParams = {
  path?: unknown;
  pageToken?: unknown;
  maxEntries?: unknown;
  followSymlinks?: unknown;
  preflightOnly?: unknown;
  expectedCanonicalPath?: unknown;
  expectedBinding?: unknown;
};

type DirListEntry = {
  name: string;
  path: string;
  size: number;
  mimeType: string;
  isDir: boolean;
  mtime: number;
};

type DirListOk = {
  ok: true;
  path: string;
  entries: DirListEntry[];
  nextPageToken?: string;
  truncated: boolean;
  preflight?: true;
  binding: PathBinding;
};

type DirListErrCode =
  | "INVALID_PATH"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "IS_FILE"
  | "SYMLINK_REDIRECT"
  | "CANONICAL_PATH_CHANGED"
  | "READ_ERROR";

type DirListErr = {
  ok: false;
  code: DirListErrCode;
  message: string;
  canonicalPath?: string;
};

type DirListResult = DirListOk | DirListErr;

function clampMaxEntries(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return DIR_LIST_DEFAULT_MAX_ENTRIES;
  }
  return Math.min(Math.floor(input), DIR_LIST_HARD_MAX_ENTRIES);
}

function parsePageOffset(input: unknown): number {
  if (typeof input !== "string") {
    return 0;
  }
  return parseStrictNonNegativeInteger(input) ?? 0;
}

function classifyFsError(err: unknown): DirListErrCode {
  const safeCode = classifyFsSafeReadError(err);
  if (safeCode) {
    return safeCode;
  }
  const code = (err as { code?: string } | null)?.code;
  if (code === "ENOENT") {
    return "NOT_FOUND";
  }
  if (code === "EACCES" || code === "EPERM") {
    return "PERMISSION_DENIED";
  }
  return "READ_ERROR";
}

export async function handleDirList(params: DirListParams): Promise<DirListResult> {
  const requestedPath = readAbsolutePath(params.path);
  if (typeof requestedPath !== "string") {
    return requestedPath;
  }

  const maxEntries = clampMaxEntries(params.maxEntries);
  const offset = parsePageOffset(params.pageToken);

  const followSymlinks = params.followSymlinks === true;

  const directory = await resolveBoundReadDirectory({
    requestedPath,
    followSymlinks,
    classifyError: classifyFsError,
    notFoundMessage: "path not found",
    expectedCanonicalPath: params.expectedCanonicalPath,
    expectedBinding: params.expectedBinding,
  });
  if (!directory.ok) {
    return directory;
  }
  const { canonicalPath: canonical, identity } = directory;
  if (params.preflightOnly === true) {
    return {
      ok: true,
      path: canonical,
      entries: [],
      truncated: false,
      preflight: true,
      binding: { kind: "existing", ...identity },
    };
  }

  const listing = await listCanonicalDirectory({
    directoryPath: canonical,
    expectedCanonicalPath: canonical,
    expectedDevice: identity.device,
    expectedInode: identity.inode,
    maxEntries,
    offset,
  });
  if (!listing.ok) {
    if (listing.code === "CANONICAL_PATH_CHANGED") {
      return {
        ok: false,
        code: "CANONICAL_PATH_CHANGED",
        message: "canonical path differs from the authorized target",
        canonicalPath: canonical,
      };
    }
    const currentDirectory = await statRequiredDirectory(canonical, classifyFsError);
    if (!currentDirectory.ok) {
      return currentDirectory;
    }
    return {
      ok: false,
      code: "READ_ERROR",
      message: "list failed",
      canonicalPath: canonical,
    };
  }
  const total = listing.total;
  const page = listing.entries;
  const truncated = offset + maxEntries < total;
  const nextPageToken = truncated ? String(offset + maxEntries) : undefined;

  const entries: DirListEntry[] = [];
  for (const entry of page) {
    const entryPath = path.join(canonical, entry.name);
    const isDir = entry.isDirectory;

    entries.push({
      name: entry.name,
      path: entryPath,
      size: isDir ? 0 : entry.size,
      mimeType: isDir ? "inode/directory" : mimeFromExtension(entry.name),
      isDir,
      mtime: entry.mtimeMs,
    });
  }

  return {
    ok: true,
    path: canonical,
    entries,
    nextPageToken,
    truncated,
    binding: { kind: "existing", ...identity },
  };
}
