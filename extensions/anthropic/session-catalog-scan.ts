import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import {
  createDirtyDirectoryWatch,
  type DirtyDirectoryWatch,
} from "./session-catalog-tree-watch.js";

export const CLAUDE_PARTIAL_SCAN_TTL_MS = 15_000;
export const CLAUDE_SESSION_SCAN_HARD_TTL_MS = 5 * 60_000;
const MAX_CATALOG_JSON_CACHE_ENTRIES = 4_000;
const CLAUDE_METADATA_WINDOW_BYTES = 1024 * 1024;
const CLAUDE_METADATA_READ_CHUNK_BYTES = 16 * 1024;
export const CLAUDE_CATALOG_IO_CONCURRENCY = 32;

export async function readClaudeCatalogMetadata(
  handle: FileHandle,
  fileSize: number,
  maxBytes: number,
  inspectLine: (line: Buffer, metadataOnly: boolean) => boolean,
): Promise<{ scannedBytes: number; complete: boolean }> {
  let pending = Buffer.alloc(0);
  let fileOffset = 0;
  let scannedBytes = 0;
  let stopDiscovery = false;
  let skipPartial = false;
  const readWindow = async (end: number, metadataOnly: boolean) => {
    while (fileOffset < end && scannedBytes < maxBytes) {
      const size = Math.min(
        CLAUDE_METADATA_READ_CHUNK_BYTES,
        end - fileOffset,
        maxBytes - scannedBytes,
      );
      const chunk = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(chunk, 0, size, fileOffset);
      if (bytesRead === 0) {
        return;
      }
      fileOffset += bytesRead;
      scannedBytes += bytesRead;
      pending = pending.length
        ? Buffer.concat([pending, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      let newline: number;
      while ((newline = pending.indexOf(0x0a)) >= 0) {
        if (!skipPartial) {
          stopDiscovery =
            inspectLine(pending.subarray(0, newline), metadataOnly || stopDiscovery) ||
            stopDiscovery;
        }
        skipPartial = false;
        pending = pending.subarray(newline + 1);
      }
      if (stopDiscovery && !metadataOnly) {
        return;
      }
    }
  };
  await readWindow(Math.min(fileSize, CLAUDE_METADATA_WINDOW_BYTES), false);
  const prefixReadToEnd = fileOffset >= fileSize;
  // Commands append metadata after conversation rows. Read at most the last MiB too,
  // charging the same budget; never interpret a clipped JSONL line as a record.
  const tailOffset = Math.max(fileOffset, fileSize - CLAUDE_METADATA_WINDOW_BYTES);
  skipPartial = tailOffset > fileOffset;
  if (skipPartial) {
    fileOffset = tailOffset - 1;
    pending = Buffer.alloc(0);
  }
  await readWindow(fileSize, true);
  if (fileOffset >= fileSize && !skipPartial && pending.length > 0) {
    inspectLine(pending, stopDiscovery || !prefixReadToEnd);
  }
  return { scannedBytes, complete: fileOffset >= fileSize };
}

type CatalogJsonCacheEntry = {
  mtimeMs: number;
  size: number;
  ino?: number;
  value: unknown;
};

type FileSignature = { mtimeMs: number; size: number; ino: number };
type SafeSessionFile = ({ filePath: string } & FileSignature) | undefined;

type ClaudeProjectDirectorySnapshot = {
  name: string;
  directory: string;
  resolvedDirectory: string;
  childNames: string[];
  files: ReadonlyMap<string, FileSignature>;
  stamp: string;
};

const projectTreeSlots = new Map<
  string,
  {
    snapshot?: ClaudeProjectsTreeSnapshot;
    pending?: Promise<ClaudeProjectsTreeSnapshot>;
    watch: DirtyDirectoryWatch;
    hardExpiresAt: number;
  }
>();

export type ClaudeProjectsTreeSnapshot = {
  root: string;
  resolvedRoot?: string;
  projectDirectories: ClaudeProjectDirectorySnapshot[];
  treeStamp: string;
};

export type ClaudeSessionScanContext = ClaudeProjectsTreeSnapshot & {
  directoriesByPath: Map<string, ClaudeProjectDirectorySnapshot>;
  complete: boolean;
  safeFiles: Map<string, Promise<SafeSessionFile>>;
};

// Parsed index/Desktop JSON stays valid for one path+mtime+size and is LRU-bounded; read failures are
// never cached, so transient metadata I/O cannot hide a later successful read.
const catalogJsonCache = new Map<string, CatalogJsonCacheEntry>();

export function setBoundedCache<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number,
  onEvict?: (value: V) => void,
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldest = cache.entries().next();
    if (oldest.done) {
      break;
    }
    onEvict?.(oldest.value[1]);
    cache.delete(oldest.value[0]);
  }
}

async function safeSessionFile(
  root: string,
  resolvedRoot: string,
  candidate: string,
  sessionId: string,
): Promise<SafeSessionFile> {
  if (!isPathInside(root, candidate) || path.basename(candidate) !== `${sessionId}.jsonl`) {
    return undefined;
  }
  try {
    const resolvedCandidate = await fs.realpath(candidate);
    if (!isPathInside(resolvedRoot, resolvedCandidate)) {
      return undefined;
    }
    const stat = await fs.stat(resolvedCandidate);
    return stat.isFile()
      ? { filePath: resolvedCandidate, mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino }
      : undefined;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw new Error("Claude session file validation failed", { cause: error });
  }
}

export function safeSessionFileForScan(
  context: ClaudeSessionScanContext,
  candidate: string,
  sessionId: string,
): Promise<SafeSessionFile> {
  if (!context.resolvedRoot) {
    return Promise.resolve(undefined);
  }
  const resolved = path.resolve(candidate);
  const name = path.basename(resolved);
  const directory = context.directoriesByPath.get(path.dirname(resolved));
  const signature = directory?.files.get(name);
  if (directory && signature && name === `${sessionId}.jsonl`) {
    return Promise.resolve({
      filePath: path.join(directory.resolvedDirectory, name),
      ...signature,
    });
  }
  const key = `${sessionId}\0${resolved}`;
  let pending = context.safeFiles.get(key);
  if (!pending) {
    // Canonical path + stat are valid only for this assembled scan. Sharing the promise prevents
    // index fallback and discovery from serially resolving the same file twice.
    const request = safeSessionFile(context.root, context.resolvedRoot, candidate, sessionId);
    pending = request.catch(() => {
      context.complete = false;
      if (context.safeFiles.get(key) === pending) {
        context.safeFiles.delete(key);
      }
      return undefined;
    });
    context.safeFiles.set(key, pending);
  }
  return pending;
}

export async function readJsonFile(
  filePath: string,
  options: {
    onIoFailure?: () => void;
    signature?: { mtimeMs: number; size: number; ino?: number };
  } = {},
): Promise<unknown> {
  const stat =
    options.signature ??
    (await fs.stat(filePath).then(
      (value) => (value.isFile() ? value : undefined),
      () => {
        options.onIoFailure?.();
        return undefined;
      },
    ));
  if (!stat) {
    catalogJsonCache.delete(filePath);
    return undefined;
  }
  const cached = catalogJsonCache.get(filePath);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    cached.ino === stat.ino
  ) {
    setBoundedCache(catalogJsonCache, filePath, cached, MAX_CATALOG_JSON_CACHE_ENTRIES);
    return cached.value;
  }
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    options.onIoFailure?.();
    return undefined;
  }
  try {
    const value = JSON.parse(content) as unknown;
    setBoundedCache(
      catalogJsonCache,
      filePath,
      { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, value },
      MAX_CATALOG_JSON_CACHE_ENTRIES,
    );
    return value;
  } catch {
    return undefined;
  }
}

export async function childDirectories(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

export function projectsDir(homeDir: string, configDir?: string): string {
  return path.join(configDir ?? path.join(homeDir, ".claude"), "projects");
}

export async function readProjectsTreeSnapshot(
  root: string,
  options: { forceRefresh?: boolean } = {},
): Promise<ClaudeProjectsTreeSnapshot> {
  let slot = projectTreeSlots.get(root);
  if (slot?.pending) {
    // An in-flight read is as fresh as any poll that arrives during it; only a forced refresh
    // (just-created session lookups) must observe writes that landed after that read began.
    if (!options.forceRefresh) {
      return slot.pending;
    }
    await slot.pending;
    return readProjectsTreeSnapshot(root, options);
  }
  if (!slot) {
    // Reserve the watcher owner before yielding so concurrent cold polls share the full read.
    slot = { watch: createDirtyDirectoryWatch(root), hardExpiresAt: 0 };
  }
  const current = slot;
  const previous = current.snapshot;
  const dirty = current.watch.takeDirty();
  const full =
    !previous?.resolvedRoot ||
    options.forceRefresh ||
    current.hardExpiresAt <= Date.now() ||
    dirty === "all";
  setBoundedCache(projectTreeSlots, root, current, 8, (evicted) => evicted.watch.close());
  if (!full && dirty.size === 0 && previous) {
    return previous;
  }
  // Attach before reading: concurrent writes remain dirty for the next snapshot.
  current.pending = (async () => {
    let complete = true;
    const onReadFailure = () => {
      complete = false;
      return undefined;
    };
    const entries = full
      ? await fs.readdir(root, { withFileTypes: true }).catch(() => undefined)
      : undefined;
    const resolvedRoot = full
      ? await fs.realpath(root).catch(() => undefined)
      : previous?.resolvedRoot;
    if (!resolvedRoot || (full && !entries)) {
      current.watch.close();
      if (projectTreeSlots.get(root) === current) {
        projectTreeSlots.delete(root);
      }
      return { root, projectDirectories: [], treeStamp: "unavailable" };
    }
    const directories = new Map(
      full ? [] : previous?.projectDirectories.map((dir) => [dir.name, dir]),
    );
    const names = entries
      ? entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      : dirty === "all"
        ? []
        : [...dirty];
    current.watch.observeChildDirectories(new Set([...directories.keys(), ...names]));
    const { results } = await runTasksWithConcurrency({
      tasks: names.map((name) => async () => {
        const directory = path.join(root, name);
        const stat = await fs.lstat(directory).catch(onReadFailure);
        if (!stat?.isDirectory()) {
          directories.delete(name);
          return undefined;
        }
        const childNames = (await fs.readdir(directory).catch(onReadFailure)) ?? [];
        return {
          name,
          directory,
          resolvedDirectory: path.join(resolvedRoot, name),
          childNames,
          mtimeMs: stat.mtimeMs,
          files: new Map<string, FileSignature>(),
        };
      }),
      limit: CLAUDE_CATALOG_IO_CONCURRENCY,
      throwOnError: true,
    });
    await runTasksWithConcurrency({
      tasks: results.flatMap((dir) =>
        dir
          ? dir.childNames.map((name) => async () => {
              const stat = await fs.lstat(path.join(dir.directory, name)).catch(onReadFailure);
              if (stat?.isFile()) {
                dir.files.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino });
              }
            })
          : [],
      ),
      limit: CLAUDE_CATALOG_IO_CONCURRENCY,
      throwOnError: true,
    });
    for (const dir of results) {
      if (dir) {
        // Include inode so atomic replacements invalidate even with identical size and mtime.
        const files = dir.childNames.map((name) => [name, dir.files.get(name)]);
        directories.set(dir.name, {
          ...dir,
          stamp: JSON.stringify([dir.name, dir.mtimeMs, files]),
        });
      }
    }
    const projectDirectories = [...directories.values()].toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
    current.watch.observeChildDirectories(directories.keys());
    if (full) {
      current.hardExpiresAt = Date.now() + CLAUDE_SESSION_SCAN_HARD_TTL_MS;
    }
    if (!complete) {
      // Another dirty directory must not postpone recovery of an earlier failed read.
      current.hardExpiresAt = Math.min(
        current.hardExpiresAt,
        Date.now() + CLAUDE_PARTIAL_SCAN_TTL_MS,
      );
    }
    return {
      root,
      resolvedRoot,
      projectDirectories,
      treeStamp: JSON.stringify([resolvedRoot, projectDirectories.map((dir) => dir.stamp)]),
    };
  })()
    .then((snapshot) => {
      current.snapshot = snapshot;
      return snapshot;
    })
    .finally(() => {
      current.pending = undefined;
    });
  return current.pending;
}

export function desktopSessionsDir(homeDir: string): string {
  return path.join(homeDir, "Library", "Application Support", "Claude", "claude-code-sessions");
}

export function configuredClaudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? path.resolve(configured) : undefined;
}

export function gatewayClaudeScanOptions(allowProcessHomeFallback?: boolean): {
  configDir?: string;
  includeDesktop: boolean;
} {
  const configDir = configuredClaudeConfigDir();
  // Upstream Claude Code's "Respect CLAUDE_CONFIG_DIR everywhere" convention replaces ~/.claude.
  // Claude Desktop stays HOME/Library-scoped, so isolated scans exclude its metadata.
  return {
    ...(configDir ? { configDir } : {}),
    includeDesktop: allowProcessHomeFallback !== false,
  };
}
