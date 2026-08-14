import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { prepareSqliteReadOnlyLocationSync } from "./sqlite-readonly-location.js";

type PreparedReadOnlyLocation = ReturnType<typeof prepareSqliteReadOnlyLocationSync>;

const inspectionSnapshots = new AsyncLocalStorage<Map<string, PreparedReadOnlyLocation>>();

/**
 * Resolve a live SQLite path to a private snapshot while an inspection scope is active.
 * Outside an inspection scope the original path is returned unchanged.
 */
export function resolveSqliteReadOnlyInspectionLocation(pathname: string): string {
  const snapshots = inspectionSnapshots.getStore();
  if (!snapshots) {
    return pathname;
  }
  const resolvedPath = path.resolve(pathname);
  let prepared = snapshots.get(resolvedPath);
  if (!prepared) {
    try {
      prepared = prepareSqliteReadOnlyLocationSync(resolvedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return pathname;
      }
      throw error;
    }
    snapshots.set(resolvedPath, prepared);
  }
  return prepared.location;
}

/** Run non-mutating inspection against cached private SQLite snapshots. */
export async function withSqliteReadOnlyInspectionSnapshots<T>(
  operation: () => Promise<T> | T,
): Promise<T> {
  if (inspectionSnapshots.getStore()) {
    return await operation();
  }
  const snapshots = new Map<string, PreparedReadOnlyLocation>();
  return await inspectionSnapshots.run(snapshots, async () => {
    try {
      return await operation();
    } finally {
      for (const prepared of [...snapshots.values()].toReversed()) {
        prepared.cleanup();
      }
    }
  });
}
