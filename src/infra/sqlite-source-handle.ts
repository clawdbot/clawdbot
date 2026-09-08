// Source readers participate in file exclusion without changing source SQLite state.
import {
  createSqliteLifecycleAggregateError,
  runWithSqliteCoordinator,
} from "./sqlite-coordinator.js";
import { acquireStateDatabaseHandleLease } from "./state-database-coordinator.js";

export function withSqliteSourceHandle<T>(pathname: string, operation: () => T): T {
  return runWithSqliteCoordinator(
    acquireStateDatabaseHandleLease({ databasePath: pathname, busyTimeoutMs: 0 }),
    "SQLite source read",
    operation,
  );
}

/** The executing source-copy child holds its own lease, including after parent loss. */
export async function withSqliteSourceHandleAsync<T>(
  pathname: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lease = acquireStateDatabaseHandleLease({ databasePath: pathname, busyTimeoutMs: 0 });
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    try {
      lease.release();
    } catch (releaseError) {
      throw createSqliteLifecycleAggregateError(
        [error, releaseError],
        "SQLite source read and handle release both failed",
        error,
      );
    }
    throw error;
  }
  lease.release();
  return result;
}
