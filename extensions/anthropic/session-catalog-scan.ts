import type { Dirent, Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";

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
  value: unknown;
};

type SafeSessionFile = { filePath: string; stat: Stats } | undefined;

type ClaudeProjectDirectorySnapshot = {
  directory: string;
  childNames: string[];
};

type ClaudeChildFileSignature = readonly [name: string, mtimeMs: number, size: number, ino: number];

export type ClaudeProjectsTreeSnapshot = {
  root: string;
  resolvedRoot?: string;
  projectDirectories: ClaudeProjectDirectorySnapshot[];
  treeStamp: string;
};

export type ClaudeSessionScanContext = ClaudeProjectsTreeSnapshot & {
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
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next();
    if (oldest.done) {
      break;
    }
    cache.delete(oldest.value);
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
    return stat.isFile() ? { filePath: resolvedCandidate, stat } : undefined;
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
  const key = `${sessionId}\0${path.resolve(candidate)}`;
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
  options: { onIoFailure?: () => void } = {},
): Promise<unknown> {
  const stat = await fs.stat(filePath).catch(() => {
    options.onIoFailure?.();
    return undefined;
  });
  if (!stat?.isFile()) {
    catalogJsonCache.delete(filePath);
    return undefined;
  }
  const cached = catalogJsonCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
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
      { mtimeMs: stat.mtimeMs, size: stat.size, value },
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

export async function readProjectsTreeSnapshot(root: string): Promise<ClaudeProjectsTreeSnapshot> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { root, projectDirectories: [], treeStamp: "unavailable" };
  }
  const directoryEntries = entries.filter((entry) => entry.isDirectory());
  const [resolvedRoot, { results: directories }] = await Promise.all([
    fs.realpath(root).catch(() => undefined),
    runTasksWithConcurrency({
      tasks: directoryEntries.map((entry) => async () => {
        const directory = path.join(root, entry.name);
        const [stat, children] = await Promise.all([
          fs.stat(directory).catch(() => undefined),
          fs.readdir(directory, { withFileTypes: true }).catch(() => undefined),
        ]);
        return { entry, directory, stat, children };
      }),
      limit: CLAUDE_CATALOG_IO_CONCURRENCY,
      throwOnError: true,
    }),
  ]);
  const childTargets = directories.flatMap(({ directory, children }, directoryIndex) =>
    (children ?? []).map((child) => ({ directoryIndex, directory, child })),
  );
  const { results: childSignatures } = await runTasksWithConcurrency({
    tasks: childTargets.map(({ directoryIndex, directory, child }) => async () => {
      const childStat = await fs.stat(path.join(directory, child.name)).catch(() => undefined);
      const signature = childStat?.isFile()
        ? ([child.name, childStat.mtimeMs, childStat.size, childStat.ino] as const)
        : undefined;
      return { directoryIndex, signature };
    }),
    limit: CLAUDE_CATALOG_IO_CONCURRENCY,
    throwOnError: true,
  });
  const signaturesByDirectory = Array.from(
    { length: directories.length },
    (): ClaudeChildFileSignature[] => [],
  );
  for (const { directoryIndex, signature } of childSignatures) {
    if (signature) {
      signaturesByDirectory[directoryIndex]?.push(signature);
    }
  }
  const directorySnapshots = directories.map(({ entry, directory, stat, children }, index) => {
    const fileSignatures = signaturesByDirectory[index] ?? [];
    const maxChildMtime = fileSignatures.reduce<number | null>(
      (maximum, [, mtime]) => Math.max(maximum ?? mtime, mtime),
      null,
    );
    return {
      directory,
      childNames: children?.map((child) => child.name) ?? [],
      stamp: [
        entry.name,
        stat?.isDirectory() === true ? stat.mtimeMs : null,
        children?.map((child) => child.name) ?? null,
        maxChildMtime ?? null,
        fileSignatures,
      ] as const,
    };
  });
  return {
    root,
    ...(resolvedRoot ? { resolvedRoot } : {}),
    projectDirectories: directorySnapshots.map(({ directory, childNames }) => ({
      directory,
      childNames,
    })),
    treeStamp: JSON.stringify([resolvedRoot ?? null, directorySnapshots.map(({ stamp }) => stamp)]),
  };
}

export async function desktopSessionStoreAvailable(homeDir: string): Promise<boolean> {
  const stat = await fs.stat(desktopSessionsDir(homeDir)).catch(() => undefined);
  return stat?.isDirectory() === true;
}

export function desktopSessionsDir(homeDir: string): string {
  return path.join(homeDir, "Library", "Application Support", "Claude", "claude-code-sessions");
}

export function currentHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
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
