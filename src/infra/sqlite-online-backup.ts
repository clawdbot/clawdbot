// Owns bounded online backups from live SQLite databases.
import type { DatabaseSync } from "node:sqlite";
import {
  openNodeSqliteDatabase,
  requireNodeSqlite,
  resolveSqliteFilesystemPath,
} from "./node-sqlite.js";

const MAX_CONSECUTIVE_NON_PROGRESS_STEPS = 10_000;

type SqliteOnlineBackupOptions = {
  allowExtension?: boolean;
  beforeBackup?: (source: DatabaseSync) => void | Promise<void>;
  destinationPath: string;
  sourcePath: string;
};

export function createSqliteBackupContentionError(sourcePath: string): Error {
  return new Error(
    `SQLite backup could not finish because the source database is being written concurrently, typically by a running Gateway: ${sourcePath}. ` +
      "Retry with `openclaw backup sqlite create --global`, or stop the Gateway and retry.",
  );
}

export async function backupSqliteOnline(options: SqliteOnlineBackupOptions): Promise<void> {
  const sqlite = requireNodeSqlite();
  const source = openNodeSqliteDatabase(
    options.sourcePath,
    options.allowExtension ? { allowExtension: true, readOnly: true } : { readOnly: true },
  );
  try {
    source.exec("PRAGMA busy_timeout = 30000; PRAGMA trusted_schema = OFF; BEGIN;");
    try {
      await options.beforeBackup?.(source);
      // Node restarts a stepped backup when another connection writes. Only a new
      // minimum proves net progress; repeated restarts must eventually terminate.
      let minimumRemainingPages = Number.POSITIVE_INFINITY;
      let consecutiveNonProgressSteps = 0;
      await sqlite.backup(source, resolveSqliteFilesystemPath(options.destinationPath), {
        progress: ({ remainingPages }) => {
          if (remainingPages < minimumRemainingPages) {
            minimumRemainingPages = remainingPages;
            consecutiveNonProgressSteps = 0;
            return;
          }
          consecutiveNonProgressSteps += 1;
          if (consecutiveNonProgressSteps >= MAX_CONSECUTIVE_NON_PROGRESS_STEPS) {
            throw createSqliteBackupContentionError(options.sourcePath);
          }
        },
      });
    } finally {
      source.exec("ROLLBACK;");
    }
  } finally {
    if (source.isOpen) {
      source.close();
    }
  }
}
