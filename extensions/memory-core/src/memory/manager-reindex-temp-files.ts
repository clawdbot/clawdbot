// Memory Core plugin module owns reindex shadow-file discovery and cleanup.
import fs from "node:fs";
import path from "node:path";

const MEMORY_DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const MEMORY_REINDEX_ENTRY_SUFFIXES = ["-wal", "-shm", "-journal", ""] as const;
const MEMORY_REINDEX_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEMORY_REINDEX_ORPHAN_MIN_AGE_MS = 24 * 60 * 60_000;

type MemoryReindexPrefix = ".memory-reindex-" | ".tmp-";

export type MemoryReindexCleanupResult = {
  removedBaseNames: string[];
  failedBaseNames: string[];
};

function resolveMemoryReindexBaseName(
  databaseBaseName: string,
  entryName: string,
  prefix: MemoryReindexPrefix,
): string | undefined {
  for (const suffix of MEMORY_REINDEX_ENTRY_SUFFIXES) {
    if (!entryName.endsWith(suffix)) {
      continue;
    }
    const baseName = entryName.slice(0, entryName.length - suffix.length);
    const shadowPrefix = `${databaseBaseName}${prefix}`;
    if (
      baseName.startsWith(shadowPrefix) &&
      MEMORY_REINDEX_UUID_PATTERN.test(baseName.slice(shadowPrefix.length))
    ) {
      return baseName;
    }
  }
  return undefined;
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isMissingFile(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return false;
  } catch (err: unknown) {
    return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
  }
}

function findAgedMemoryReindexBaseNames(
  dbPath: string,
  prefix: MemoryReindexPrefix,
  nowMs: number,
): string[] {
  const dir = path.dirname(dbPath);
  const databaseBaseName = path.basename(dbPath);
  const shadowBaseNames = new Set<string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const shadowBaseName = resolveMemoryReindexBaseName(databaseBaseName, entry.name, prefix);
    if (shadowBaseName) {
      shadowBaseNames.add(shadowBaseName);
    }
  }

  return [...shadowBaseNames].toSorted().filter((shadowBaseName) => {
    const stats: fs.Stats[] = [];
    for (const suffix of MEMORY_DATABASE_FILE_SUFFIXES) {
      try {
        stats.push(fs.statSync(path.join(dir, `${shadowBaseName}${suffix}`)));
      } catch (err) {
        // SAFETY: Node filesystem failures expose the optional errno code on Error objects.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          return false;
        }
      }
    }
    return (
      stats.length > 0 &&
      nowMs - Math.max(...stats.map((stat) => stat.mtimeMs)) >= MEMORY_REINDEX_ORPHAN_MIN_AGE_MS
    );
  });
}

function removeMemoryReindexBaseNames(
  dbPath: string,
  shadowBaseNames: string[],
): MemoryReindexCleanupResult {
  const result: MemoryReindexCleanupResult = {
    removedBaseNames: [],
    failedBaseNames: [],
  };
  for (const shadowBaseName of shadowBaseNames) {
    let removed = true;
    for (const suffix of MEMORY_DATABASE_FILE_SUFFIXES) {
      const filePath = path.join(path.dirname(dbPath), `${shadowBaseName}${suffix}`);
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        removed = false;
      }
      if (!isMissingFile(filePath)) {
        removed = false;
      }
    }
    (removed ? result.removedBaseNames : result.failedBaseNames).push(shadowBaseName);
  }
  return result;
}

/** Resolve the retired database basename from one strictly named legacy shadow entry. */
export function resolveLegacyMemoryReindexDatabaseBaseName(entryName: string): string | undefined {
  for (const suffix of MEMORY_REINDEX_ENTRY_SUFFIXES) {
    if (!entryName.endsWith(suffix)) {
      continue;
    }
    const baseName = entryName.slice(0, entryName.length - suffix.length);
    const markerIndex = baseName.lastIndexOf(".tmp-");
    if (markerIndex <= 0) {
      continue;
    }
    const databaseBaseName = baseName.slice(0, markerIndex);
    if (
      databaseBaseName.endsWith(".sqlite") &&
      MEMORY_REINDEX_UUID_PATTERN.test(baseName.slice(markerIndex + ".tmp-".length))
    ) {
      return databaseBaseName;
    }
  }
  return undefined;
}

export function findAgedLegacyMemoryReindexTempFiles(dbPath: string, nowMs = Date.now()): string[] {
  return findAgedMemoryReindexBaseNames(dbPath, ".tmp-", nowMs);
}

/** Doctor-only cleanup for retired shadow files whose primary database may be archived. */
export function cleanupAgedLegacyMemoryReindexTempFiles(
  dbPath: string,
  nowMs = Date.now(),
): MemoryReindexCleanupResult {
  return removeMemoryReindexBaseNames(dbPath, findAgedLegacyMemoryReindexTempFiles(dbPath, nowMs));
}

/** Remove current crash-left shadows while the caller owns the reindex lease. */
export function cleanupAgedMemoryReindexTempFiles(dbPath: string, nowMs = Date.now()): void {
  // A missing primary can be an interrupted swap. Runtime cleanup must not delete
  // the only complete current-format shadow while that state is unresolved.
  if (!isRegularFile(dbPath)) {
    return;
  }
  removeMemoryReindexBaseNames(
    dbPath,
    findAgedMemoryReindexBaseNames(dbPath, ".memory-reindex-", nowMs),
  );
}

/** Remove one closed shadow memory database and its journal-mode sidecars. */
export function removeMemoryDatabaseFiles(dbPath: string): void {
  for (const suffix of MEMORY_DATABASE_FILE_SUFFIXES) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}
