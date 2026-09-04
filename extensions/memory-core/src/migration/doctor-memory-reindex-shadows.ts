import path from "node:path";
import {
  cleanupAgedLegacyMemoryReindexTempFiles,
  findAgedLegacyMemoryReindexTempFiles,
} from "../memory/manager-reindex-temp-files.js";

export type LegacyMemoryReindexOrphan = {
  dbPath: string;
  shadowBaseNames: string[];
};

export function collectAgedLegacyMemoryReindexShadows(
  databasePaths: Iterable<string>,
): LegacyMemoryReindexOrphan[] {
  return [...databasePaths]
    .map((dbPath) => ({
      dbPath,
      shadowBaseNames: findAgedLegacyMemoryReindexTempFiles(dbPath),
    }))
    .filter((candidate) => candidate.shadowBaseNames.length > 0)
    .toSorted((left, right) => left.dbPath.localeCompare(right.dbPath));
}

export function formatLegacyMemoryReindexShadowPreviews(
  orphans: LegacyMemoryReindexOrphan[],
): string[] {
  return orphans.flatMap(({ dbPath, shadowBaseNames }) =>
    shadowBaseNames.map(
      (shadowBaseName) =>
        `- Aged Memory Core legacy reindex shadow: ${path.join(path.dirname(dbPath), shadowBaseName)}`,
    ),
  );
}

export async function cleanupLegacyMemoryReindexShadows(
  orphans: LegacyMemoryReindexOrphan[],
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (orphans.length === 0) {
    return { changes, warnings };
  }
  const { waitForMemoryReindexLock } = await import("../memory/manager-reindex-lock.js");
  for (const { dbPath } of orphans) {
    let lock: Awaited<ReturnType<typeof waitForMemoryReindexLock>> | undefined;
    try {
      // Detection is advisory: reacquire the database lease and rescan before deletion
      // so a shadow that became active after Doctor preview cannot be removed.
      lock = await waitForMemoryReindexLock(dbPath);
      const result = cleanupAgedLegacyMemoryReindexTempFiles(dbPath);
      if (result.removedBaseNames.length > 0) {
        changes.push(
          `Removed ${result.removedBaseNames.length} aged Memory Core legacy reindex shadow database(s) beside ${dbPath}`,
        );
      }
      for (const failedBaseName of result.failedBaseNames) {
        warnings.push(
          `Failed removing aged Memory Core legacy reindex shadow database ${path.join(path.dirname(dbPath), failedBaseName)}`,
        );
      }
    } catch (err) {
      warnings.push(
        `Skipped aged Memory Core legacy reindex shadow cleanup beside ${dbPath}: ${String(err)}`,
      );
    } finally {
      try {
        lock?.release();
      } catch (err) {
        warnings.push(
          `Failed releasing Memory Core legacy reindex cleanup lock beside ${dbPath}: ${String(err)}`,
        );
      }
    }
  }
  return { changes, warnings };
}
