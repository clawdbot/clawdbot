import { parentPort, workerData } from "node:worker_threads";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import {
  isSqliteLockError,
  runSqliteImmediateTransactionSync,
} from "../infra/sqlite-transaction.js";
import {
  leaseHeartbeatState as state,
  type LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";
import {
  readOpenClawStateLeaseExpiry,
  renewOpenClawStateLeaseInTransaction,
} from "./openclaw-state-lease-store.js";

// SAFETY: The lease owner alone starts this private entry with its typed structured-clone payload.
const params = workerData as LeaseHeartbeatWorkerData;
const shared = new BigInt64Array(params.shared);
const db = openNodeSqliteDatabase(params.path);
let heartbeat: ReturnType<typeof setTimeout> | undefined;
const lose = () => {
  Atomics.compareExchange(shared, state.status, state.starting, state.lost);
  Atomics.compareExchange(shared, state.status, state.ready, state.lost);
  Atomics.notify(shared, state.ack);
  clearTimeout(heartbeat);
  db.close();
  parentPort?.close();
};
const renew = () => {
  if (Atomics.load(shared, state.status) >= state.closed) {
    return;
  }
  let expiresAt: number | undefined;
  try {
    expiresAt = runWithSqliteBusyTimeout(
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
    );
  } catch (error) {
    if (!isSqliteLockError(error)) {
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
