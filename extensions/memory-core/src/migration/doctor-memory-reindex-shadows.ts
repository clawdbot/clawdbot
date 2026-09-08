import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const MEMORY_REINDEX_SHADOW_PATTERN =
  /^(.+)\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-(?:wal|shm|journal))?$/;

async function readDirectoryEntries(directoryPath: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function collectLegacyMemoryReindexShadowDatabasePaths(params: {
  defaultDirectoryPath: string;
  configuredDatabasePaths: string[];
}): Promise<string[]> {
  const directories = new Map<string, Set<string> | undefined>([
    [params.defaultDirectoryPath, undefined],
  ]);
  for (const databasePath of params.configuredDatabasePaths) {
    const directoryPath = path.dirname(databasePath);
    const allowed = directories.get(directoryPath);
    if (allowed) {
      allowed.add(path.basename(databasePath));
    } else if (!directories.has(directoryPath)) {
      directories.set(directoryPath, new Set([path.basename(databasePath)]));
    }
  }

  const databasePaths = new Set<string>();
  for (const [directoryPath, allowed] of directories) {
    const entries = await readDirectoryEntries(directoryPath);
    const regularFileNames = new Set(
      entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
    );
    for (const entry of entries) {
      const databaseBaseName = entry.isFile()
        ? MEMORY_REINDEX_SHADOW_PATTERN.exec(entry.name)?.[1]
        : undefined;
      if (
        databaseBaseName &&
        (regularFileNames.has(databaseBaseName) ||
          regularFileNames.has(`${databaseBaseName}.migrated`)) &&
        (allowed?.has(databaseBaseName) || (!allowed && databaseBaseName.endsWith(".sqlite")))
      ) {
        databasePaths.add(path.join(directoryPath, databaseBaseName));
      }
    }
  }
  return [...databasePaths].toSorted();
}

export async function cleanupLegacyMemoryReindexShadows(
  databasePaths: string[],
): Promise<{ changes: string[]; warnings: string[] }> {
  const { cleanupAgedLegacyMemoryReindexTempFiles } = await import("../memory/manager-db.js");
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const databasePath of databasePaths) {
    try {
      if (!(await fs.stat(`${databasePath}.migrated`)).isFile()) {
        continue;
      }
    } catch {
      continue;
    }
    // Current runtimes never select these retired paths. The 24-hour age gate
    // protects a recently written legacy shadow without creating another lock DB.
    const result = cleanupAgedLegacyMemoryReindexTempFiles(databasePath);
    if (result.removed > 0) {
      changes.push(
        `Removed ${result.removed} aged Memory Core reindex orphan shadow database(s) beside retired memory index ${databasePath}`,
      );
    }
    if (result.failed > 0) {
      warnings.push(
        `Failed removing ${result.failed} aged Memory Core reindex orphan shadow database(s) beside retired memory index ${databasePath}`,
      );
    }
  }
  return { changes, warnings };
}
