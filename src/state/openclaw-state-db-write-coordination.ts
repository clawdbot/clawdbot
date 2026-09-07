// Shared-state transaction exclusion must cover the real outer SQLite transaction.
import type { DatabaseSync } from "node:sqlite";
import { readSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { runWithSqliteCoordinator } from "../infra/sqlite-coordinator.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";

// Native and transformed SDK graphs may share the same transaction owner.
const coordinatedStateTransactions = resolveGlobalSingleton(
  Symbol.for("openclaw.coordinatedStateTransactions"),
  () => new WeakSet<DatabaseSync>(),
);

export function withSharedStateWriteCoordinator<T>(
  params: {
    databasePath: string;
    existing?: DatabaseSync;
    busyTimeoutMs?: number;
    operationLabel?: string;
  },
  operation: () => T,
): T {
  if (params.existing?.isTransaction && !coordinatedStateTransactions.has(params.existing)) {
    throw new Error(
      "Cannot join an uncoordinated shared-state transaction; enter through runOpenClawStateWriteTransaction before BEGIN.",
    );
  }
  // Cached and supplied handles join the same lifecycle gate as fresh opens.
  // Acquire before BEGIN and retain through outer commit and postcommit work.
  const coordinator = acquireStateDatabaseCoordinator({
    databasePath: params.databasePath,
    busyTimeoutMs:
      params.busyTimeoutMs ??
      (params.existing ? readSqliteBusyTimeout(params.existing) : OPENCLAW_SQLITE_BUSY_TIMEOUT_MS),
  });
  return runWithSqliteCoordinator(coordinator, params.operationLabel ?? "state.write", operation);
}

export function runCoordinatedStateTransaction<T>(
  database: DatabaseSync,
  operation: () => T,
  options: SqliteTransactionOptions,
): T {
  return withSqlitePostCommitPublications(database, () => {
    const outer = !database.isTransaction;
    if (outer) {
      coordinatedStateTransactions.add(database);
    }
    try {
      return runSqliteImmediateTransactionSync(database, operation, options);
    } finally {
      if (outer) {
        coordinatedStateTransactions.delete(database);
      }
    }
  });
}
