// Configures SQLite WAL and related pragmas for local stores.
import type { DatabaseSync } from "node:sqlite";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";

// WAL maintenance configures SQLite write-ahead logging and schedules bounded
// checkpoints so state databases do not accumulate unbounded WAL files.
export const DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES = 1000;
export const DEFAULT_SQLITE_WAL_TRUNCATE_INTERVAL_MS = 30 * 60 * 1000;

type IntervalHandle = ReturnType<typeof setInterval> & {
  unref?: () => void;
};

type SqliteWalCheckpointMode = "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";

export type SqliteWalMaintenance = {
  checkpoint: () => boolean;
  close: () => boolean;
};

/** Options controlling WAL autocheckpoint and periodic checkpoint behavior. */
export type SqliteWalMaintenanceOptions = {
  autoCheckpointPages?: number;
  checkpointIntervalMs?: number;
  checkpointMode?: SqliteWalCheckpointMode;
  databaseLabel?: string;
  databasePath?: string;
  onCheckpointError?: (error: unknown) => void;
};

function normalizeNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

/** Configure WAL pragmas and return a handle for checkpoint/close maintenance. */
export function configureSqliteWalMaintenance(
  db: DatabaseSync,
  options: SqliteWalMaintenanceOptions = {},
): SqliteWalMaintenance {
  const autoCheckpointPages = normalizeNonNegativeInteger(
    options.autoCheckpointPages ?? DEFAULT_SQLITE_WAL_AUTOCHECKPOINT_PAGES,
    "autoCheckpointPages",
  );
  const checkpointIntervalMs = normalizeNonNegativeInteger(
    options.checkpointIntervalMs ?? DEFAULT_SQLITE_WAL_TRUNCATE_INTERVAL_MS,
    "checkpointIntervalMs",
  );
  const timerIntervalMs = Math.min(checkpointIntervalMs, MAX_TIMER_TIMEOUT_MS);
  const checkpointMode = options.checkpointMode ?? "TRUNCATE";
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`PRAGMA wal_autocheckpoint = ${autoCheckpointPages};`);

  const checkpoint = (): boolean => {
    try {
      db.exec(`PRAGMA wal_checkpoint(${checkpointMode});`);
      return true;
    } catch (error) {
      options.onCheckpointError?.(error);
      return false;
    }
  };

  let timer: IntervalHandle | null = null;
  if (timerIntervalMs > 0) {
    timer = setInterval(checkpoint, timerIntervalMs) as IntervalHandle;
    timer.unref?.();
  }

  return {
    checkpoint,
    close: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      return checkpoint();
    },
  };
}
