import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CatalogRecord } from "./session-catalog-discovery.js";

const MAX_CATALOG_DISCOVERY_CACHE_ENTRIES = 20_000;
const MAX_CATALOG_JSON_CACHE_ENTRIES = 4_000;
export const MAX_CLAUDE_SESSION_SCAN_CACHE_ENTRIES = 8;
export const CLAUDE_SESSION_SCAN_HARD_TTL_MS = 5 * 60_000;
export const CLAUDE_PARTIAL_SCAN_TTL_MS = 15_000;
export const CLAUDE_DESKTOP_SCAN_TTL_MS = 60_000;
export const CLAUDE_CATALOG_IO_CONCURRENCY = 32;

type CatalogDiscoveryCacheEntry = {
  // The module-global cache is keyed by canonical transcript path, so an entry must also record the
  // discovery context it was built in. `root` is the logical (unresolved) projects root: it scopes
  // the entry to its homeDir even when the root itself is a symlink, so a different homeDir scan
  // cannot reuse it and eviction can find it without re-resolving a now-missing root. mtime+size+ino
  // detect any content change or atomic replacement; sessionId guards against a canonical path being
  // reached under a different filename-derived id (e.g. an aliased/renamed symlink).
  root: string;
  mtimeMs: number;
  size: number;
  ino: number;
  sessionId: string;
  // Bytes this file charged against the scan budget when first scanned. Cache hits re-charge it so
  // byte-budget-limited discovery stops at the same frontier whether or not the cache is warm,
  // keeping pagination deterministic across repeated identical calls.
  scannedBytes: number;
  record: CatalogRecord | null;
  sidechain: boolean;
};

type CatalogJsonCacheEntry = {
  mtimeMs: number;
  size: number;
  value: unknown;
};

type ClaudeSessionScanCacheEntry = {
  treeStamp: string;
  hardExpiresAt: number;
  desktopStoreAvailable: boolean;
  desktopExpiresAt: number;
  records: Promise<CatalogRecord[]>;
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

// Transcript discoveries stay valid only for the same root/id/inode/mtime/size and are LRU-bounded;
// a false hit would corrupt pagination, so warm scans re-charge the original deterministic byte cost.
export const catalogDiscoveryCache = new Map<string, CatalogDiscoveryCacheEntry>();
// Parsed index/Desktop JSON stays valid for one path+mtime+size and is LRU-bounded; read failures are
// never cached, so transient metadata I/O cannot hide a later successful read.
const catalogJsonCache = new Map<string, CatalogJsonCacheEntry>();
// Whole scans are root-scoped and bounded; tree/Desktop/hard expiries below own invalidation, avoiding
// an unbounded home map while preserving the exact resolved records promise for concurrent callers.
export const claudeSessionScanCache = new Map<string, ClaudeSessionScanCacheEntry>();

export async function mapConcurrent<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = values.length;
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

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

export function cacheCatalogDiscovery(filePath: string, entry: CatalogDiscoveryCacheEntry): void {
  setBoundedCache(catalogDiscoveryCache, filePath, entry, MAX_CATALOG_DISCOVERY_CACHE_ENTRIES);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function safeSessionFile(
  root: string,
  resolvedRoot: string,
  candidate: string,
  sessionId: string,
): Promise<SafeSessionFile> {
  if (!isWithin(root, candidate) || path.basename(candidate) !== `${sessionId}.jsonl`) {
    return undefined;
  }
  try {
    const resolvedCandidate = await fs.realpath(candidate);
    if (!isWithin(resolvedRoot, resolvedCandidate)) {
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
  const [resolvedRoot, directories] = await Promise.all([
    fs.realpath(root).catch(() => undefined),
    mapConcurrent(directoryEntries, CLAUDE_CATALOG_IO_CONCURRENCY, async (entry) => {
      const directory = path.join(root, entry.name);
      const [stat, children] = await Promise.all([
        fs.stat(directory).catch(() => undefined),
        fs.readdir(directory, { withFileTypes: true }).catch(() => undefined),
      ]);
      return { entry, directory, stat, children };
    }),
  ]);
  const childTargets = directories.flatMap(({ directory, children }, directoryIndex) =>
    (children ?? []).map((child) => ({ directoryIndex, directory, child })),
  );
  const childSignatures = await mapConcurrent(
    childTargets,
    CLAUDE_CATALOG_IO_CONCURRENCY,
    async ({ directoryIndex, directory, child }) => {
      const childStat = await fs.stat(path.join(directory, child.name)).catch(() => undefined);
      const signature = childStat?.isFile()
        ? ([child.name, childStat.mtimeMs, childStat.size, childStat.ino] as const)
        : undefined;
      return { directoryIndex, signature };
    },
  );
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
