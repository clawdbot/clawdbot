// Owns bounded online backups from live SQLite databases.
import type { DatabaseSync } from "node:sqlite";
import { collectErrorGraphCandidates } from "./errors.js";
import {
  openNodeSqliteDatabase,
  requireNodeSqlite,
  resolveSqliteFilesystemPath,
} from "./node-sqlite.js";

// node:sqlite restarts the copy from the top whenever another connection
// commits, so a continuously written source never converges on its own. The
// budget is elapsed time since the copy last reached a new all-time low
// remaining page count, because only a new low means the copy is closer to
// done than it has ever been. That time comes from the monotonic clock, as
// the restart health wait reads its deadline, so a backward wall-clock
// correction cannot postpone it. Counting restarts or discarded pages cannot
// do this job: measured against real WAL sources under a concurrent writer,
// backups that completed peaked at 2 to 38 restarts and 9.7 to 107 full copies
// of discarded work, while stalled runs reached 803 to 2,001 restarts and
// 1,148 copies, and both quantities grow with database size, so neither
// separates the two populations at a size nobody has measured. Time does, and
// it barely moves with size: completing runs never went more than 1.1s without
// a new low at 21k, 63k or 211k pages, while stalled runs sat 190s and
// counting.
//
// The half hour itself is a product decision, not a measurement. It is the
// smallest value that cannot abort a healthy copy of the 4,467,250-page
// database in the report part-way through a pass, since one uncontended full
// copy of it measured 733.8s. A smaller number fails faster on a livelock at
// the risk of aborting a slow but converging copy of a very large database.
const MAX_MS_WITHOUT_NET_PROGRESS = 30 * 60_000;
// Plateau guard for a stream that keeps calling back while copying nothing at
// all. The peak observed across every real run was 1 step here and 5 for the
// reviewer, so this fires only on a wedged copy, and it fires at once instead
// of waiting out the time budget.
const MAX_STEPS_WITHOUT_COPY_ADVANCE = 10_000;

type SqliteOnlineBackupOptions = {
  allowExtension?: boolean;
  beforeBackup?: (source: DatabaseSync) => void | Promise<void>;
  destinationPath: string;
  sourcePath: string;
};

class SqliteBackupContentionError extends Error {}

/** True when the online backup's contention bound produced this failure graph. */
export function isSqliteBackupContentionError(error: unknown): boolean {
  return collectErrorGraphCandidates(error, (candidate) =>
    candidate instanceof Error ? [candidate.cause] : [],
  ).some((candidate) => candidate instanceof SqliteBackupContentionError);
}

// Worker JSON cannot carry the private class, so the parent rebuilds this typed
// cause from the worker's `failure: "contention"` tag; without it the backup
// boundary could not add its remedy on the worker path.
export function createSqliteBackupContentionCause(message: string): Error {
  return new SqliteBackupContentionError(message);
}

function createSqliteBackupContentionError(sourcePath: string, reason: string): Error {
  // Read-only state-database opens and ownership checks reach this owner too,
  // so the remedy stays generic; a caller that can offer more, such as the
  // backup command, adds its own suggestion at its own boundary.
  return new SqliteBackupContentionError(
    `SQLite online backup could not reach a consistent copy of ${sourcePath}: ${reason}. ` +
      "Stop the Gateway or otherwise quiesce writes to the source, then retry.",
  );
}

export async function backupSqliteOnline(options: SqliteOnlineBackupOptions): Promise<void> {
  const sqlite = requireNodeSqlite();
  const source = openNodeSqliteDatabase(options.sourcePath, {
    ...(options.allowExtension ? { allowExtension: true } : {}),
    readOnly: true,
  });
  try {
    source.exec("PRAGMA busy_timeout = 30000; PRAGMA trusted_schema = OFF; BEGIN;");
    try {
      await options.beforeBackup?.(source);
      let minimumRemainingPages = Number.POSITIVE_INFINITY;
      let previousRemainingPages = Number.POSITIVE_INFINITY;
      let stepsSinceCopyAdvanced = 0;
      let netProgressAt = performance.now();
      await sqlite.backup(source, resolveSqliteFilesystemPath(options.destinationPath), {
        progress: ({ remainingPages }) => {
          const idleMs = performance.now() - netProgressAt;
          if (idleMs > MAX_MS_WITHOUT_NET_PROGRESS) {
            throw createSqliteBackupContentionError(
              options.sourcePath,
              `no net page progress was observed for ${Math.round(idleMs)}ms`,
            );
          }
          if (remainingPages < minimumRemainingPages) {
            minimumRemainingPages = remainingPages;
            netProgressAt = performance.now();
          }
          if (remainingPages < previousRemainingPages) {
            stepsSinceCopyAdvanced = 0;
          } else {
            stepsSinceCopyAdvanced += 1;
            if (stepsSinceCopyAdvanced > MAX_STEPS_WITHOUT_COPY_ADVANCE) {
              throw createSqliteBackupContentionError(
                options.sourcePath,
                `${stepsSinceCopyAdvanced} consecutive steps copied no page`,
              );
            }
          }
          previousRemainingPages = remainingPages;
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
