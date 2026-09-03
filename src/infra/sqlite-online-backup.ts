// Owns bounded online backups from live SQLite databases.
import type { DatabaseSync } from "node:sqlite";
import {
  openNodeSqliteDatabase,
  requireNodeSqlite,
  resolveSqliteFilesystemPath,
} from "./node-sqlite.js";

const MAX_RESTARTS_WITHOUT_NEW_MINIMUM = 1_000;
const MAX_STEPS_WITHOUT_COPY_ADVANCE = 10_000;

type SqliteOnlineBackupOptions = {
  allowExtension?: boolean;
  beforeBackup?: (source: DatabaseSync) => void | Promise<void>;
  destinationPath: string;
  sourcePath: string;
};

function createSqliteBackupContentionError(sourcePath: string): Error {
  return new Error(
    `SQLite backup stopped after repeated steps made no net page progress: ${sourcePath}. ` +
      "Stop the Gateway or otherwise quiesce writes, then retry. To back up only configuration, run `openclaw backup create --only-config`.",
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
      // Restart jumps count wasted passes; the generous step budget catches a copy
      // that stopped moving. Any decrease resets it, so database size is irrelevant.
      let minimumRemainingPages = Number.POSITIVE_INFINITY;
      let previousRemainingPages = Number.POSITIVE_INFINITY;
      let restartsSinceNewMinimum = 0;
      let stepsSinceCopyAdvanced = 0;
      await sqlite.backup(source, resolveSqliteFilesystemPath(options.destinationPath), {
        progress: ({ remainingPages }) => {
          const reachedNewMinimum = remainingPages < minimumRemainingPages;
          const copyAdvanced = remainingPages < previousRemainingPages;
          const restarted = remainingPages > previousRemainingPages;
          previousRemainingPages = remainingPages;
          if (copyAdvanced) {
            stepsSinceCopyAdvanced = 0;
          } else {
            stepsSinceCopyAdvanced += 1;
            if (stepsSinceCopyAdvanced > MAX_STEPS_WITHOUT_COPY_ADVANCE) {
              throw createSqliteBackupContentionError(options.sourcePath);
            }
          }
          if (reachedNewMinimum) {
            minimumRemainingPages = remainingPages;
            restartsSinceNewMinimum = 0;
            return;
          }
          if (!restarted) {
            return;
          }
          restartsSinceNewMinimum += 1;
          if (restartsSinceNewMinimum > MAX_RESTARTS_WITHOUT_NEW_MINIMUM) {
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
