import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  isPathInside,
  resolveOpenedFileRealPathForHandle,
  root as fsRoot,
} from "../../infra/fs-safe.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { createStagedInputPathMatcher } from "../../media/staged-inputs.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { activeWorkspaceHashContext, workspaceStatIdentity } from "./workspace-hash-memo.js";
import {
  MAX_WORKSPACE_INVENTORY_ENTRIES,
  MAX_WORKSPACE_INVENTORY_PATH_BYTES,
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
} from "./workspace-inventory-limits.js";
import {
  gitFileMode,
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { isDerivedWorkspacePath } from "./workspace-path-exclusions.js";

type WorkspaceFileSnapshot =
  | { type: "file"; mode: number; size: number; sha256: string }
  | { type: "unsupported" };

function localPath(root: string, relative: string): string {
  return path.join(root, ...relative.split("/"));
}

export function isPortableRootContainedSymlink(
  root: string,
  entryPath: string,
  target: string,
): boolean {
  if (
    !target ||
    target.includes("\\") ||
    path.posix.isAbsolute(target) ||
    path.win32.parse(target).root !== ""
  ) {
    return false;
  }
  const resolved = path.resolve(path.dirname(localPath(root, entryPath)), target);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

export async function readWorkspaceFileSnapshotWithLimit(
  expectedPath: string,
  maxBytes: number | ((openedSize: number) => number),
  root?: string,
  signal?: AbortSignal,
): Promise<WorkspaceFileSnapshot> {
  signal?.throwIfAborted();
  const handle = await fs.open(
    expectedPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    signal?.throwIfAborted();
    const { memo: hashMemo, metrics, owner = "gateway" } = activeWorkspaceHashContext() ?? {};
    const before = await handle.stat({ bigint: true });
    const realPath = await resolveOpenedFileRealPathForHandle(handle, expectedPath);
    if (!before.isFile() || (root && !isPathInside(root, realPath))) {
      throw new Error("Gateway workspace file changed while it was being read");
    }
    // Reserve from the opened descriptor: path metadata can race replacement,
    // and concurrent memo hits must consume the same aggregate byte budget.
    const byteLimit = typeof maxBytes === "number" ? maxBytes : maxBytes(Number(before.size));
    if (before.size > BigInt(byteLimit)) {
      return { type: "unsupported" };
    }
    const identity = workspaceStatIdentity(owner, before);
    let sha256 = hashMemo?.get(identity);
    let size = Number(before.size);
    if (sha256) {
      if (metrics) {
        metrics.memoHitCount += 1;
      }
    } else {
      const hashStartedAt = performance.now();
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      size = 0;
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
        if (bytesRead === 0) {
          break;
        }
        size += bytesRead;
        if (size > byteLimit) {
          if (typeof maxBytes !== "number") {
            throw new Error("Gateway workspace file changed while it was being read");
          }
          return { type: "unsupported" };
        }
        hash.update(buffer.subarray(0, bytesRead));
      }
      sha256 = hash.digest("hex");
      if (metrics) {
        metrics.contentHashCount += 1;
        metrics.contentHashDurationMs += performance.now() - hashStartedAt;
      }
    }
    const after = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (after.size !== BigInt(size) || workspaceStatIdentity(owner, after) !== identity) {
      throw new Error("Gateway workspace file changed while it was being read");
    }
    hashMemo?.set(identity, sha256);
    return {
      type: "file",
      mode: gitFileMode(Number(after.mode & 0o777n)),
      size,
      sha256,
    };
  } finally {
    await handle.close();
  }
}

export async function readActualWorkspaceManifestImpl(params: {
  root: string;
  baseCommit: string | null;
  preserveDirectories?: ReadonlySet<string>;
  includePaths?: ReadonlySet<string>;
}): Promise<{ manifest: WorkerWorkspaceManifest; manifestRef: string }> {
  const root = await fs.realpath(params.root);
  const isStagedInput = createStagedInputPathMatcher(await fsRoot(root));
  const rawEntries: Array<
    WorkerWorkspaceManifestEntry | { path: string; type: "directory"; mode: number }
  > = [];
  let totalBytes = 0;
  let manifestPathBytes = 0;
  let traversedEntries = 0;
  let traversedPathBytes = 0;
  const addBytes = (bytes: number): void => {
    totalBytes += bytes;
    if (totalBytes > MAX_WORKSPACE_INVENTORY_TOTAL_BYTES) {
      throw new Error("Gateway workspace manifest exceeds its eligible byte limit");
    }
  };
  const addEntry = (entry: (typeof rawEntries)[number], bytes = 0): void => {
    addBytes(bytes);
    manifestPathBytes += Buffer.byteLength(entry.path);
    if (manifestPathBytes > MAX_WORKSPACE_INVENTORY_PATH_BYTES) {
      throw new Error("Gateway workspace manifest paths exceed their byte limit");
    }
    rawEntries.push(entry);
    if (rawEntries.length > MAX_WORKSPACE_INVENTORY_ENTRIES) {
      throw new Error("Gateway workspace manifest has too many entries");
    }
  };
  const scanController = new AbortController();
  const checkTraversal = (relative: string): void => {
    scanController.signal.throwIfAborted();
    traversedEntries += 1;
    traversedPathBytes += Buffer.byteLength(relative);
    if (traversedEntries > MAX_WORKSPACE_INVENTORY_ENTRIES) {
      throw new Error("Gateway workspace manifest has too many entries");
    }
    if (traversedPathBytes > MAX_WORKSPACE_INVENTORY_PATH_BYTES) {
      throw new Error("Gateway workspace manifest paths exceed their byte limit");
    }
  };
  const filePaths: string[] = [];
  const runScans = async (
    start: number,
    end: number,
    scan: (index: number) => Promise<void>,
  ): Promise<void> => {
    let next = start;
    const result = await runTasksWithConcurrency({
      // Keep the queued graph bounded too: each worker claims an index before
      // awaiting I/O, rather than retaining one task per inventory entry.
      tasks: Array.from({ length: Math.min(4, end - start) }, () => async () => {
        while (next < end && !scanController.signal.aborted) {
          await scan(next++);
        }
      }),
      limit: 4,
      errorMode: "stop",
      onTaskError: (error) => scanController.abort(error),
    });
    if (result.hasError) {
      throw result.firstError;
    }
  };
  const addFile = async (relative: string): Promise<void> => {
    const snapshot = await readWorkspaceFileSnapshotWithLimit(
      localPath(root, relative),
      (size) => {
        addBytes(size);
        return size;
      },
      root,
      scanController.signal,
    );
    if (snapshot.type === "file") {
      addEntry({
        path: relative,
        type: "file",
        mode: snapshot.mode,
        size: snapshot.size,
        sha256: snapshot.sha256,
      });
      return;
    }
    throw new Error("Gateway workspace manifest exceeds its eligible byte limit");
  };
  const addIncludedPath = async (
    relative: string,
    includedNodes: ReadonlySet<string>,
    derivedOnlyDirectories: ReadonlySet<string>,
  ): Promise<"included" | "derived-only" | "absent"> => {
    if (isDerivedWorkspacePath(relative, await isStagedInput(relative))) {
      return "derived-only";
    }
    checkTraversal(relative);
    const absolute = localPath(root, relative);
    const stats = await fs.lstat(absolute).catch((error: unknown) => {
      if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ENOTDIR")) {
        return undefined;
      }
      throw error;
    });
    if (!stats) {
      return "absent";
    }
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      if (params.preserveDirectories?.has(relative)) {
        addEntry({ path: relative, type: "directory", mode: stats.mode & 0o777 });
        return "included";
      }
      let hasDerivedEntry = false;
      let hasIncludedEntry = false;
      for await (const entry of await fs.opendir(absolute)) {
        const child = `${relative}/${entry.name}`;
        if (
          isDerivedWorkspacePath(child, await isStagedInput(child)) ||
          derivedOnlyDirectories.has(child)
        ) {
          hasDerivedEntry = true;
        } else if (includedNodes.has(child)) {
          hasIncludedEntry = true;
        }
      }
      if (hasIncludedEntry || !hasDerivedEntry) {
        addEntry({ path: relative, type: "directory", mode: stats.mode & 0o777 });
        return "included";
      }
      return "derived-only";
    }
    if (stats.isSymbolicLink()) {
      const target = await fs.readlink(absolute);
      if (isPortableRootContainedSymlink(root, relative, target)) {
        addEntry(
          { path: relative, type: "symlink", mode: 0o777, target },
          Buffer.byteLength(target),
        );
        return "included";
      }
      return "absent";
    }
    if (stats.isFile()) {
      filePaths.push(relative);
      return "included";
    }
    return "absent";
  };
  const walk = async (
    relativeDirectory: string,
  ): Promise<{ hasDerivedEntry: boolean; included: boolean }> => {
    const absoluteDirectory = relativeDirectory ? localPath(root, relativeDirectory) : root;
    let hasDerivedEntry = false;
    let hasNonDerivedEntry = false;
    for await (const directoryEntry of await fs.opendir(absoluteDirectory)) {
      const name = directoryEntry.name;
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      checkTraversal(relative);
      if (!relativeDirectory && name === ".git") {
        continue;
      }
      if (isDerivedWorkspacePath(relative, await isStagedInput(relative))) {
        hasDerivedEntry = true;
        continue;
      }
      const absolute = localPath(root, relative);
      const stats = await fs.lstat(absolute);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        const child = await walk(relative);
        if (child.included || params.preserveDirectories?.has(relative)) {
          addEntry({ path: relative, type: "directory", mode: stats.mode & 0o777 });
          hasNonDerivedEntry = true;
        } else {
          hasDerivedEntry ||= child.hasDerivedEntry;
        }
      } else if (stats.isSymbolicLink()) {
        hasNonDerivedEntry = true;
        const target = await fs.readlink(absolute);
        if (!isPortableRootContainedSymlink(root, relative, target)) {
          // Like other unsupported local nodes, an escaping symlink is retained
          // as a conflict but omitted from the canonical cloud manifest.
          continue;
        }
        addEntry(
          {
            path: relative,
            type: "symlink",
            mode: 0o777,
            target,
          },
          Buffer.byteLength(target),
        );
      } else if (stats.isFile()) {
        hasNonDerivedEntry = true;
        filePaths.push(relative);
      } else {
        hasNonDerivedEntry = true;
        // Special local nodes cannot be represented in a cloud manifest. They
        // remain in place and are surfaced as conflicts when the worker changed
        // the same path; omitting them lets that conflicted turn still finish.
        continue;
      }
    }
    return {
      hasDerivedEntry,
      // Preserve real empty directories, but omit a directory whose only
      // physical contents are excluded derived paths.
      included: hasNonDerivedEntry || !hasDerivedEntry,
    };
  };
  if (params.includePaths) {
    const includedNodes = new Set<string>();
    const derivedOnlyDirectories = new Set<string>();
    const paths = [...params.includePaths]
      .map((relative) => ({ relative, depth: relative.split("/").length }))
      .toSorted(
        (left, right) => right.depth - left.depth || left.relative.localeCompare(right.relative),
      );
    // Siblings are independent, but parent classification needs every deeper
    // membership result. Join each depth before admitting the next one.
    for (let start = 0; start < paths.length;) {
      let end = start + 1;
      while (end < paths.length && paths[end]!.depth === paths[start]!.depth) {
        end++;
      }
      await runScans(start, end, async (index) => {
        const { relative } = paths[index]!;
        const state = await addIncludedPath(relative, includedNodes, derivedOnlyDirectories);
        if (state === "included") {
          includedNodes.add(relative);
        } else if (state === "derived-only") {
          derivedOnlyDirectories.add(relative);
        }
      });
      start = end;
    }
  } else {
    await walk("");
  }
  // No file readers overlap metadata selection; failures stop new admission
  // and join all opened handles before any manifest can be returned.
  await runScans(0, filePaths.length, (index) => addFile(filePaths[index]!));
  const directories = rawEntries
    .filter((entry) => entry.type === "directory")
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const manifest: WorkerWorkspaceManifest = {
    version: 1,
    baseCommit: params.baseCommit,
    entries: rawEntries
      .filter((entry): entry is WorkerWorkspaceManifestEntry => entry.type !== "directory")
      .toSorted((left, right) => left.path.localeCompare(right.path)),
    directories: directories.map((entry) => entry.path),
  };
  const raw = serializeWorkerWorkspaceManifest(manifest);
  const manifestRef = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  return {
    manifestRef,
    manifest,
  };
}
