import path from "node:path";
import { root } from "openclaw/plugin-sdk/security-runtime";
import { mimeFromExtension } from "../shared/mime.js";
import {
  classifyFsSafeReadError,
  readAbsolutePath,
  resolveCanonicalReadPath,
  statRequiredDirectory,
} from "./path-errors.js";

export const DIR_LIST_DEFAULT_MAX_ENTRIES = 200;
export const DIR_LIST_HARD_MAX_ENTRIES = 5000;

type DirListParams = {
  path?: unknown;
  pageToken?: unknown;
  maxEntries?: unknown;
  followSymlinks?: unknown;
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
};

type DirListErrCode =
  | "INVALID_PATH"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "IS_FILE"
  | "SYMLINK_REDIRECT"
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
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) {
    return 0;
  }
  const offset = Number(trimmed);
  return Number.isSafeInteger(offset) ? offset : 0;
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

  const canonical = await resolveCanonicalReadPath({
    requestedPath,
    followSymlinks,
    classifyError: classifyFsError,
    notFoundMessage: "path not found",
  });
  if (typeof canonical !== "string") {
    return canonical;
  }

  const directory = await statRequiredDirectory(canonical, classifyFsError);
  if (!directory.ok) {
    return directory;
  }

  let listedEntries: { name: string; isDirectory: boolean; size: number; mtimeMs: number }[];
  try {
    const dirRoot = await root(canonical);
    listedEntries = await dirRoot.list(".", { withFileTypes: true });
  } catch (err) {
    const code = classifyFsError(err);
    return {
      ok: false,
      code,
      message: `list failed: ${String(err)}`,
      canonicalPath: canonical,
    };
  }

  listedEntries.sort((a, b) => a.name.localeCompare(b.name));

  const total = listedEntries.length;
  const page = listedEntries.slice(offset, offset + maxEntries);
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
  };
}
