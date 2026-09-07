import fs from "node:fs";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { applyPrivateModeSync } from "./private-mode.js";
import { isSqliteLockError } from "./sqlite-transaction.js";

export class SqliteCoordinatorError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SqliteCoordinatorError";
  }
}

export function createSqliteLifecycleAggregateError(
  errors: unknown[],
  message: string,
  cause: unknown,
): AggregateError {
  return new AggregateError(errors, message, { cause });
}

export function runWithSqliteCoordinator<T>(
  coordinator: { release: () => void },
  operationLabel: string,
  operation: () => T,
): T {
  let result: T;
  try {
    result = operation();
    if (result && typeof (result as { then?: unknown }).then === "function") {
      throw new SqliteCoordinatorError(`${operationLabel} must remain synchronous`);
    }
  } catch (operationError) {
    let releaseFailed = false;
    let releaseError: unknown;
    try {
      coordinator.release();
    } catch (error) {
      releaseFailed = true;
      releaseError = error;
    }
    if (releaseFailed) {
      throw createSqliteLifecycleAggregateError(
        [operationError, releaseError],
        `${operationLabel} and coordinator release both failed`,
        operationError,
      );
    }
    throw operationError;
  }
  try {
    coordinator.release();
  } catch (releaseError) {
    throw new SqliteCoordinatorError(
      `${operationLabel} completed, but releasing its coordinator failed`,
      releaseError,
    );
  }
  return result;
}

export function ensurePrivateSqliteCoordinatorDirectory(
  directoryPath: string,
  coordinatorLabel: string,
): void {
  try {
    fs.mkdirSync(directoryPath, { mode: 0o700, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const stats = fs.lstatSync(directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SqliteCoordinatorError(`${coordinatorLabel} directory must be a real directory`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stats.uid !== uid) {
    throw new SqliteCoordinatorError(`${coordinatorLabel} directory belongs to another user`);
  }
  if (process.platform !== "win32") {
    if ((stats.mode & 0o7777) !== 0o700) {
      applyPrivateModeSync(directoryPath, 0o700);
    }
    const secured = fs.lstatSync(directoryPath);
    if (secured.isSymbolicLink() || !secured.isDirectory() || (secured.mode & 0o077) !== 0) {
      throw new SqliteCoordinatorError(`${coordinatorLabel} directory permissions are not private`);
    }
  }
}

/** Hold a raw exclusive transaction until release for cross-process coordination. */
export function tryAcquireExclusiveSqliteCoordinator(
  location: string,
  options: { busyTimeoutMs?: number } = {},
): { release: () => void } | null {
  const busyTimeoutMs = Math.max(0, Math.trunc(options.busyTimeoutMs ?? 0));
  const database = openNodeSqliteDatabase(location);
  try {
    // Kysely transaction callbacks cannot own a lock beyond their synchronous commit section.
    // This handle never writes or commits data. Keep the empty database's initial
    // journal in memory so acquiring a lock does not create filesystem artifacts.
    database.exec(
      `PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE;`,
    );
  } catch (error) {
    database.close();
    if (isSqliteLockError(error)) {
      return null;
    }
    throw error;
  }
  return {
    release: () => {
      const errors: unknown[] = [];
      try {
        database.exec("ROLLBACK");
      } catch (error) {
        errors.push(error);
      }
      try {
        database.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "SQLite coordinator rollback and close both failed");
      }
    },
  };
}
