import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import {
  readSqliteBusyTimeout,
  runWithSqliteBusyTimeout,
  setSqliteBusyTimeout,
} from "../../infra/sqlite-busy-timeout.js";
import {
  isSqliteLockError,
  runSqliteImmediateTransactionSync,
} from "../../infra/sqlite-transaction.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";

const COMMIT_DECISION_TIMEOUT_MS = 5_000;
const WAITING = 0;
const APPROVED = 1;
const REJECTED = 2;
const COMMITTING = 3;
const SETTLED = 4;
const REQUESTED = 5;

const pendingAuthorizations = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteReclamationAuthorizations"),
  () => new Map<string, () => void>(),
);

/** Preserve the reclamation owner's context when an unrelated synchronous writer helps. */
export async function withSqliteReclamationAuthorization<T>(
  buffer: SharedArrayBuffer | undefined,
  databasePath: string,
  assertCurrent: (() => void) | undefined,
  run: (authorize: () => unknown[]) => Promise<T>,
): Promise<T> {
  if (!buffer || !assertCurrent) {
    return await run(() => []);
  }
  const shared = new Int32Array(buffer);
  const inOwnerContext = AsyncLocalStorage.snapshot();
  let consumed = false;
  let failure: { error: unknown } | undefined;
  let recovered: unknown[] = [];
  const authorize = () => {
    if (failure) {
      throw failure.error;
    }
    if (consumed) {
      return recovered;
    }
    consumed = true;
    try {
      recovered = inOwnerContext(
        authorizeSqliteReclamationCommit,
        buffer,
        databasePath,
        assertCurrent,
      );
      return recovered;
    } catch (error) {
      failure = { error };
      throw error;
    }
  };
  const service = () => {
    if (Atomics.load(shared, 0) === REQUESTED) {
      try {
        authorize();
      } catch {
        // Rejection belongs to reclamation; its queued request propagates the error.
      }
    }
  };
  pendingAuthorizations.set(databasePath, service);
  try {
    return await run(authorize);
  } finally {
    pendingAuthorizations.delete(databasePath);
  }
}

/** Retry only write admission; never replay an append or its synchronous callbacks. */
export function runSqliteTranscriptWriteTransaction<T>(
  operation: Parameters<typeof runOpenClawAgentWriteTransaction<T>>[0],
  options: Parameters<typeof runOpenClawAgentWriteTransaction>[1],
  transactionOptions?: Parameters<typeof runOpenClawAgentWriteTransaction>[2],
): T {
  const database = openOpenClawAgentDatabase(options);
  const service = pendingAuthorizations.get(database.path);
  if (!service || database.db.isTransaction) {
    return runOpenClawAgentWriteTransaction(operation, options, transactionOptions);
  }
  const busyTimeoutMs = readSqliteBusyTimeout(database.db);
  const deadline = performance.now() + busyTimeoutMs;
  let entered = false;
  while (true) {
    try {
      return runWithSqliteBusyTimeout(
        database.db,
        Math.min(25, Math.max(0, Math.ceil(deadline - performance.now()))),
        (restore) =>
          runOpenClawAgentWriteTransaction(
            (current) => {
              entered = true;
              restore();
              return operation(current);
            },
            options,
            transactionOptions,
          ),
        { lockFailureReporting: "suppress" },
      );
    } catch (error) {
      if (entered || !isSqliteLockError(error) || performance.now() >= deadline) {
        throw error;
      }
      service();
      if (performance.now() >= deadline) {
        throw error;
      }
    }
  }
}

function rejectCommit(shared: Int32Array): void {
  Atomics.compareExchange(shared, 0, WAITING, REJECTED);
  Atomics.compareExchange(shared, 0, REQUESTED, REJECTED);
  Atomics.compareExchange(shared, 0, APPROVED, REJECTED);
  Atomics.notify(shared, 0);
}

/** Called by the Worker while its deletion transaction still owns the writer lock. */
export function waitForSqliteReclamationCommit(
  buffer: SharedArrayBuffer,
  request: () => void,
): void {
  const shared = new Int32Array(buffer);
  Atomics.store(shared, 0, REQUESTED);
  request();
  Atomics.wait(shared, 0, REQUESTED, COMMIT_DECISION_TIMEOUT_MS);
  if (Atomics.compareExchange(shared, 0, APPROVED, COMMITTING) !== APPROVED) {
    rejectCommit(shared);
    throw new Error("SQLite session reclamation commit was not authorized");
  }
}

/** Publish only after the transaction ended or its connection successfully closed. */
export function markSqliteReclamationSettled(buffer: SharedArrayBuffer | undefined): void {
  if (buffer) {
    const shared = new Int32Array(buffer);
    Atomics.store(shared, 0, SETTLED);
    Atomics.notify(shared, 0);
  }
}

/** Keep the live parent authority current until the Worker's transaction has settled. */
function authorizeSqliteReclamationCommit(
  buffer: SharedArrayBuffer,
  databasePath: string,
  assertCurrent: () => void,
): unknown[] {
  const shared = new Int32Array(buffer);
  // The Worker owns the canonical database lease. This short-lived connection
  // only joins its writer lock; it must not bootstrap schemas or registry state.
  let database: DatabaseSync | undefined;
  const recoveredErrors: unknown[] = [];
  let settled = false;
  try {
    database = openNodeSqliteDatabase(databasePath);
    setSqliteBusyTimeout(database, COMMIT_DECISION_TIMEOUT_MS);
    assertCurrent();
    if (Atomics.compareExchange(shared, 0, REQUESTED, APPROVED) !== REQUESTED) {
      throw new Error("SQLite session reclamation commit checkpoint expired");
    }
    Atomics.notify(shared, 0);

    while (!settled) {
      if (Atomics.load(shared, 0) === SETTLED) {
        settled = true;
        break;
      }
      try {
        // The Worker already owns BEGIN IMMEDIATE. Acquiring this lock proves
        // COMMIT, ROLLBACK, or connection close finished, even after abrupt exit.
        runSqliteImmediateTransactionSync(database, () => {
          settled = true;
        });
      } catch (error) {
        if (recoveredErrors.length === 0) {
          recoveredErrors.push(error);
        }
        settled ||= database.isOpen && database.isTransaction;
        if (settled) {
          break;
        }
        const decision = Atomics.compareExchange(shared, 0, APPROVED, REJECTED);
        if (decision === SETTLED) {
          settled = true;
          break;
        }
        if (decision !== COMMITTING) {
          Atomics.notify(shared, 0);
          throw error;
        }
        // A failed barrier cannot release live commit authority. The Worker can
        // prove normal settlement even if this connection is unusable; the lock
        // still joins abrupt exit without relying on a queued parent JS callback.
        if (!isSqliteLockError(error)) {
          Atomics.wait(shared, 0, COMMITTING, 10);
        }
      }
    }
  } catch (error) {
    rejectCommit(shared);
    throw error;
  } finally {
    try {
      if (database?.isOpen) {
        database.close();
      }
    } catch (error) {
      // The original authorization failure stays fatal. After settlement, the
      // Worker's result owns success and all postcommit publication must continue.
      if (settled) {
        recoveredErrors.push(error);
      }
    }
  }
  return recoveredErrors;
}
