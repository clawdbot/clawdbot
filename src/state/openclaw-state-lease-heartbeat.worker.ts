import { parentPort, workerData } from "node:worker_threads";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { runWithSqliteCoordinator } from "../infra/sqlite-coordinator.js";
import {
  isSqliteLockError,
  runSqliteImmediateTransactionSync,
} from "../infra/sqlite-transaction.js";
import {
  acquireStateDatabaseCoordinator,
  StateDatabaseCoordinatorContentionError,
} from "../infra/state-database-coordinator.js";
import { openTrackedStateDatabase, closeTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import {
  leaseHeartbeatState as state,
  LEASE_HEARTBEAT_START_TIMEOUT_MS,
  type LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";
import {
  readOpenClawStateLeaseExpiry,
  renewOpenClawStateLeaseInTransaction,
} from "./openclaw-state-lease-store.js";

// SAFETY: The lease owner alone starts this private entry with its typed structured-clone payload.
const params = workerData as LeaseHeartbeatWorkerData;
const shared = new BigInt64Array(params.shared);
function withLifecycleCoordinator<T>(label: string, operation: () => T): T {
  // This private worker participates in an actual parent-owned coordinator,
  // retained before construction and released only after native worker exit.
  // Its persisted lease identity and expiry are still checked for every renewal.
  return params.parentCoordinatorRetained
    ? operation()
    : runWithSqliteCoordinator(
        acquireStateDatabaseCoordinator({ databasePath: params.path, busyTimeoutMs: 0 }),
        label,
        operation,
      );
}
function openHeartbeatDatabase() {
  // The parent's bound is a retry deadline, not ownership. Renewal below still
  // checks the exact current persisted owner/expiry before changing the row.
  const deadline = Math.min(params.expiresAt, Date.now() + LEASE_HEARTBEAT_START_TIMEOUT_MS);
  while (Date.now() < deadline && Atomics.load(shared, state.status) === state.starting) {
    try {
      return withLifecycleCoordinator("maintenance heartbeat open", () =>
        openTrackedStateDatabase(params.path, { existingOnly: params.existingOnly }),
      );
    } catch (error) {
      if (!(error instanceof StateDatabaseCoordinatorContentionError)) {
        throw error;
      }
    }
    Atomics.wait(
      shared,
      state.status,
      state.starting,
      Math.max(1, Math.min(25, deadline - Date.now())),
    );
  }
  throw new Error("state lease heartbeat startup deadline expired or owner stopped");
}
const db = openHeartbeatDatabase();
let heartbeat: ReturnType<typeof setTimeout> | undefined;
const lose = () => {
  Atomics.compareExchange(shared, state.status, state.starting, state.lost);
  Atomics.compareExchange(shared, state.status, state.ready, state.lost);
  Atomics.notify(shared, state.ack);
  clearTimeout(heartbeat);
  closeTrackedStateDatabase(db);
  parentPort?.close();
};
const renew = () => {
  if (Atomics.load(shared, state.status) >= state.closed) {
    return;
  }
  let expiresAt: number | undefined;
  try {
    expiresAt = withLifecycleCoordinator("maintenance heartbeat renewal", () =>
      runWithSqliteBusyTimeout(
        db,
        0,
        () =>
          runSqliteImmediateTransactionSync(
            db,
            () => {
              if (Atomics.load(shared, state.status) >= state.closed) {
                return undefined;
              }
              return renewOpenClawStateLeaseInTransaction(db, params.identity, params.leaseMs);
            },
            { logger: { warn() {} } },
          ),
        { lockFailureReporting: "suppress" },
      ),
    );
  } catch (error) {
    if (!(error instanceof StateDatabaseCoordinatorContentionError) && !isSqliteLockError(error)) {
      lose();
      return;
    }
    expiresAt = readOpenClawStateLeaseExpiry(db, params.identity);
  }
  if (expiresAt === undefined) {
    lose();
    return;
  }
  // Contention may delay renewal, but must never delay expiry detection by a
  // full heartbeat interval or authorize renewal after the persisted deadline.
  heartbeat = setTimeout(renew, Math.max(1, Math.min(params.heartbeatMs, expiresAt - Date.now())));
};

renew();
if (Atomics.compareExchange(shared, state.status, state.starting, state.ready) === state.starting) {
  parentPort?.on("message", () => {
    if (Atomics.load(shared, state.status) !== state.ready) {
      return;
    }
    // A caller may hold the state write transaction while checking ownership.
    // Liveness acknowledgements must never wait for that caller's SQLite lock.
    Atomics.store(shared, state.ack, Atomics.load(shared, state.request));
    Atomics.notify(shared, state.ack);
  });
  parentPort?.postMessage(null, []);
}
