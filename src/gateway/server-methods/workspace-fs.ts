// Shared workspace filesystem access for gateway file browsers and editors.
// All entry points route through fs-safe roots (realpathed root, symlink and
// hardlink rejection) so no caller can access files outside a workspace root.
import { createHash } from "node:crypto";
import path from "node:path";
import { root as fsSafeRoot, FsSafeError, type ReadResult } from "../../infra/fs-safe.js";

type WorkspaceRoot = Awaited<ReturnType<typeof fsSafeRoot>>;
type WorkspacePathStat = Awaited<ReturnType<WorkspaceRoot["stat"]>>;
export type WorkspaceDirEntry = WorkspacePathStat & { name: string };
type WorkspaceFileReadResult = ReadResult & { canonicalPath: string };

/** Shared preview cap: keeps file payloads comfortably under client WS limits. */
export const WORKSPACE_PREVIEW_MAX_BYTES = 256 * 1024;

let workspaceFileUpdateQueue: Promise<void> = Promise.resolve();

async function openWorkspaceRoot(rootDir: string): Promise<WorkspaceRoot | undefined> {
  try {
    return await fsSafeRoot(rootDir, {
      hardlinks: "reject",
      maxBytes: WORKSPACE_PREVIEW_MAX_BYTES,
      nonBlockingRead: true,
      symlinks: "reject",
    });
  } catch {
    return undefined;
  }
}

export async function statWorkspacePath(
  rootDir: string,
  browserPath: string,
): Promise<WorkspacePathStat | undefined> {
  const workspaceRoot = await openWorkspaceRoot(rootDir);
  if (!workspaceRoot) {
    return undefined;
  }
  try {
    return await workspaceRoot.stat(browserPath || ".");
  } catch {
    return undefined;
  }
}

export async function listWorkspacePath(
  rootDir: string,
  browserPath: string,
): Promise<WorkspaceDirEntry[] | undefined> {
  const workspaceRoot = await openWorkspaceRoot(rootDir);
  if (!workspaceRoot) {
    return undefined;
  }
  try {
    return await workspaceRoot.list(browserPath || ".", { withFileTypes: true });
  } catch {
    return undefined;
  }
}

export async function readWorkspaceFile(
  rootDir: string,
  browserPath: string,
  opts?: { maxBytes?: number },
): Promise<WorkspaceFileReadResult | undefined | "too-large"> {
  const workspaceRoot = await openWorkspaceRoot(rootDir);
  if (!workspaceRoot) {
    return undefined;
  }
  try {
    const read = await workspaceRoot.read(browserPath, {
      hardlinks: "reject",
      maxBytes: opts?.maxBytes ?? WORKSPACE_PREVIEW_MAX_BYTES,
      nonBlockingRead: true,
      symlinks: "reject",
    });
    return {
      ...read,
      canonicalPath: path.relative(workspaceRoot.rootReal, read.realPath).split(path.sep).join("/"),
    };
  } catch (err) {
    if (err instanceof FsSafeError && err.code === "too-large") {
      return "too-large";
    }
    return undefined;
  }
}

export type WorkspaceFileUpdateResult =
  | { status: "updated"; canonicalPath: string; hash: string; stat: WorkspacePathStat }
  | { status: "conflict"; currentHash: string }
  | { status: "unsafe" };

function enqueueWorkspaceFileUpdate<T>(update: () => Promise<T>): Promise<T> {
  const result = workspaceFileUpdateQueue.then(update, update);
  workspaceFileUpdateQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function updateWorkspaceFile(
  rootDir: string,
  browserPath: string,
  content: string,
  expectedHash: string,
): Promise<WorkspaceFileUpdateResult> {
  const workspaceRoot = await openWorkspaceRoot(rootDir);
  if (!workspaceRoot) {
    return { status: "unsafe" };
  }
  // Serialize every low-frequency editor save. The same physical file can be
  // exposed through path aliases or nested workspace roots, so narrower queue
  // keys can let two routes accept one stale hash and overwrite each other.
  return await enqueueWorkspaceFileUpdate<WorkspaceFileUpdateResult>(async () => {
    let current: ReadResult;
    try {
      current = await workspaceRoot.read(browserPath, {
        hardlinks: "reject",
        maxBytes: WORKSPACE_PREVIEW_MAX_BYTES,
        nonBlockingRead: true,
        symlinks: "reject",
      });
    } catch {
      return { status: "unsafe" };
    }
    if (decodeUtf8Strict(current.buffer) === undefined) {
      return { status: "unsafe" };
    }
    const currentHash = createHash("sha256").update(current.buffer).digest("hex");
    if (currentHash !== expectedHash) {
      return { status: "conflict", currentHash };
    }
    await workspaceRoot.write(browserPath, content, {
      encoding: "utf8",
      renameIdentity: "strict",
    });
    const stat = await workspaceRoot.stat(browserPath);
    if (workspaceStatKind(stat) !== "file") {
      return { status: "unsafe" };
    }
    return {
      status: "updated",
      canonicalPath: path
        .relative(workspaceRoot.rootReal, current.realPath)
        .split(path.sep)
        .join("/"),
      hash: createHash("sha256").update(content, "utf8").digest("hex"),
      stat,
    };
  });
}

export function decodeUtf8Strict(buffer: Buffer): string | undefined {
  // NUL bytes are valid UTF-8 but mark binary payloads we refuse to inline.
  if (buffer.includes(0)) {
    return undefined;
  }
  try {
    // ignoreBOM keeps a leading BOM in the decoded string so editor saves
    // round-trip the original bytes instead of silently dropping it.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

/** Collapses `.` segments and separators into a canonical root-relative path. */
export function normalizeRelativePath(value: string | undefined): string {
  if (!value) {
    return "";
  }
  return value
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}

/**
 * Lexical containment pre-check before any fs access; fs-safe re-verifies
 * against the realpathed root so symlinked escapes still fail later.
 */
export function resolveWorkspacePath(
  root: string | undefined,
  filePath: string,
): string | undefined {
  if (!root) {
    return undefined;
  }
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(root, filePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return resolved;
}

export function workspaceStatKind(
  stat: WorkspacePathStat,
): "file" | "directory" | "symlink" | undefined {
  const kind = (stat as { kind?: unknown }).kind;
  if (kind === "file" || kind === "directory" || kind === "symlink") {
    return kind;
  }
  const nodeStat = stat as {
    isDirectory?: boolean | (() => boolean);
    isFile?: boolean | (() => boolean);
    isSymbolicLink?: boolean | (() => boolean);
  };
  const isFile = typeof nodeStat.isFile === "function" ? nodeStat.isFile() : nodeStat.isFile;
  if (isFile) {
    return "file";
  }
  const isDirectory =
    typeof nodeStat.isDirectory === "function" ? nodeStat.isDirectory() : nodeStat.isDirectory;
  if (isDirectory) {
    return "directory";
  }
  const isSymbolicLink =
    typeof nodeStat.isSymbolicLink === "function"
      ? nodeStat.isSymbolicLink()
      : nodeStat.isSymbolicLink;
  return isSymbolicLink ? "symlink" : undefined;
}

/** Protocol timestamps are integer milliseconds. */
export function toUpdatedAtMs(mtimeMs: number): number {
  return Math.floor(mtimeMs);
}

export function sortDirents<T extends { name: string }>(dirents: readonly T[]): T[] {
  return dirents.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Directories first, then name order — the shared browser display order. */
export function sortWorkspaceEntries<T extends { kind: "file" | "directory"; name: string }>(
  entries: readonly T[],
): T[] {
  return entries.toSorted((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}
