import { getFileStatSnapshot } from "../cache-utils.js";
import { resolveSqliteSessionStoreDatabasePath } from "./store-sqlite.js";

export type SessionStoreFreshnessSnapshot = NonNullable<ReturnType<typeof getFileStatSnapshot>>;

export function getSessionStoreFreshnessSnapshot(
  storePath: string,
): SessionStoreFreshnessSnapshot | undefined {
  const sqlitePath = resolveSqliteSessionStoreDatabasePath(storePath);
  const stats = [
    sqlitePath,
    `${sqlitePath}-wal`,
    `${sqlitePath}-shm`,
    `${sqlitePath}-journal`,
  ].flatMap((filePath) => {
    const stat = getFileStatSnapshot(filePath);
    return stat ? [stat] : [];
  });
  if (stats.length === 0) {
    return undefined;
  }
  return {
    mtimeMs: Math.max(...stats.map((stat) => stat.mtimeMs)),
    sizeBytes: stats.reduce((sum, stat) => sum + stat.sizeBytes, 0),
  };
}
