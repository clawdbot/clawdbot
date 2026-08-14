import { existsSync } from "node:fs";

/** SQLite main database plus every journal-mode sidecar that can contain database pages. */
const SQLITE_DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

class SqliteOrphanedSidecarsError extends Error {
  constructor(pathname: string, sidecarPaths: string[]) {
    super(
      `SQLite database is missing at ${pathname}, but sidecars remain: ${sidecarPaths.join(", ")}. ` +
        "Refusing to create a replacement database because SQLite can delete orphan WAL or journal state when opening an empty main database. Preserve the complete SQLite family and restore or repair its main database before retrying.",
    );
    this.name = "SqliteOrphanedSidecarsError";
  }
}

/** Resolves the main database and all possible journal-mode sidecar paths. */
export function resolveSqliteDatabaseFilePaths(pathname: string): string[] {
  return SQLITE_DATABASE_FILE_SUFFIXES.map((suffix) => `${pathname}${suffix}`);
}

/** Refuse a fresh database when sidecars from a missing SQLite family remain. */
export function assertNoOrphanedSqliteSidecars(pathname: string): void {
  if (existsSync(pathname)) {
    return;
  }
  const sidecarPaths = resolveSqliteDatabaseFilePaths(pathname).slice(1).filter(existsSync);
  if (sidecarPaths.length > 0) {
    throw new SqliteOrphanedSidecarsError(pathname, sidecarPaths);
  }
}
