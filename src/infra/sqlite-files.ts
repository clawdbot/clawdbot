import fs from "node:fs";
import { createSubsystemLogger } from "../logging/subsystem.js";

/** SQLite main database plus every journal-mode sidecar that can contain database pages. */
const SQLITE_DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
// SQLite WAL format: https://sqlite.org/fileformat2.html#walformat defines a 32-byte header.
const SQLITE_WAL_HEADER_BYTES = 32;
const sqliteFilesLog = createSubsystemLogger("state/sqlite");

class SqliteOrphanedSidecarsError extends Error {
  constructor(pathname: string, sidecarPaths: string[], cause: unknown) {
    super(
      `SQLite database is missing at ${pathname}, and orphaned sidecars could not be quarantined: ${sidecarPaths.join(", ")}. ` +
        "Refusing to open because SQLite could delete orphan WAL or journal state. Preserve the sidecar bytes, restore the main database, and pair it with the matching sidecar before retrying.",
      { cause },
    );
    this.name = "SqliteOrphanedSidecarsError";
  }
}

type QuarantinedSqliteSidecar = {
  quarantinePath: string;
  sourcePath: string;
};

/** Resolves the main database and all possible journal-mode sidecar paths. */
export function resolveSqliteDatabaseFilePaths(pathname: string): string[] {
  return SQLITE_DATABASE_FILE_SUFFIXES.map((suffix) => `${pathname}${suffix}`);
}

function resolveOrphanedSidecarQuarantinePath(sourcePath: string, epochMs: number): string {
  const basePath = `${sourcePath}.orphaned-${epochMs}`;
  if (!fs.existsSync(basePath)) {
    return basePath;
  }
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${basePath}-${suffix}`;
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
}

/** Preserve durable orphan sidecars before SQLite creates a replacement main database. */
export function quarantineOrphanedSqliteSidecars(pathname: string): void {
  if (fs.existsSync(pathname)) {
    return;
  }
  const sidecarPaths = [
    { path: `${pathname}-wal`, minimumBytes: SQLITE_WAL_HEADER_BYTES },
    { path: `${pathname}-journal`, minimumBytes: 0 },
  ]
    .filter((sidecar) => {
      const stat = fs.statSync(sidecar.path, { throwIfNoEntry: false });
      return stat?.isFile() === true && stat.size > sidecar.minimumBytes;
    })
    .map((sidecar) => sidecar.path);
  if (sidecarPaths.length === 0) {
    return;
  }

  const epochMs = Date.now();
  const quarantined: QuarantinedSqliteSidecar[] = [];
  try {
    for (const sourcePath of sidecarPaths) {
      const quarantinePath = resolveOrphanedSidecarQuarantinePath(sourcePath, epochMs);
      fs.renameSync(sourcePath, quarantinePath);
      quarantined.push({ quarantinePath, sourcePath });
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const moved of quarantined.toReversed()) {
      try {
        fs.renameSync(moved.quarantinePath, moved.sourcePath);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    const cause =
      rollbackErrors.length === 0
        ? error
        : new AggregateError(
            [error, ...rollbackErrors],
            "orphaned sidecar quarantine rollback failed",
          );
    throw new SqliteOrphanedSidecarsError(pathname, sidecarPaths, cause);
  }

  const moves = quarantined.map(
    ({ sourcePath, quarantinePath }) => `${sourcePath} -> ${quarantinePath}`,
  );
  sqliteFilesLog.warn(
    `SQLite database is missing at ${pathname}; quarantined orphaned sidecars: ${moves.join(", ")}. ` +
      "Committed frames could not be applied because the main database is missing. The bytes are preserved. Recovery requires restoring the main database and pairing it with the quarantined file.",
    {
      databasePath: pathname,
      quarantinedSidecars: quarantined,
    },
  );
}
