// Host-owned SQLite leases serialize trusted work across processes.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { isSqliteLockError } from "../infra/sqlite-transaction.js";
import { loggingState } from "../logging/state.js";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import type { DB as OpenClawAgentKyselyDatabase } from "./openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";

type LeaseDatabase = Pick<OpenClawStateKyselyDatabase, "state_leases">;
type AgentLeaseDatabase = Pick<OpenClawAgentKyselyDatabase, "state_leases">;
type LeaseKysely = ReturnType<typeof getNodeSqliteKysely<LeaseDatabase>>;

type OpenClawStateLeaseDatabase =
  | { scope: "shared"; options?: OpenClawStateDatabaseOptions }
  | { scope: "agent"; agentId: string; path?: string };

type OpenClawStateLeaseProcessOwner = {
  pid: number;
  startTime: number | null;
  isAlive(pid: number): boolean;
  readStartTime(pid: number): number | null;
};

type OpenClawStateLeaseOptions = {
  scope: string;
  key: string;
  database: OpenClawStateLeaseDatabase;
  leaseMs: number;
  waitMs: number;
  signal?: AbortSignal;
  /** Stable diagnostic noun used in errors. */
  leaseLabel?: string;
  /** Stable transaction label used by SQLite diagnostics. */
  operationLabel?: string;
  /** Live process owners remain authoritative even when their advisory TTL expires. */
  processOwner?: OpenClawStateLeaseProcessOwner;
  /** Propagate an exhausted release retry instead of silently relying on expiry. */
  strictRelease?: boolean;
};

export type OpenClawStateLeaseContext = {
  signal: AbortSignal;
  /** Verify that this exact owner holds a non-expired lease at this instant. */
  assertOwned(): void;
  /** Verify ownership using the caller's active write transaction. */
  assertOwnedInTransaction(database: DatabaseSync): void;
};

export type OpenClawStateLeaseHandle = OpenClawStateLeaseContext & {
  release(): Promise<void>;
  /** Release a manually held process lease during synchronous termination cleanup. */
  releaseSynchronously(): void;
};

export type OpenClawStateLeaseErrorCode =
  | "OPENCLAW_STATE_LEASE_INVALID_INPUT"
  | "OPENCLAW_STATE_LEASE_TIMEOUT"
  | "OPENCLAW_STATE_LEASE_ABORTED"
  | "OPENCLAW_STATE_LEASE_LOST"
  | "OPENCLAW_STATE_LEASE_STORAGE_FAILED";

export class OpenClawStateLeaseError extends Error {
  readonly code: OpenClawStateLeaseErrorCode;

  constructor(message: string, options: { code: OpenClawStateLeaseErrorCode; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "OpenClawStateLeaseError";
    this.code = options.code;
  }
}

const ACQUIRE_BACKOFF = {
  initialMs: 25,
  maxMs: 250,
  factor: 1.5,
  jitter: 0.25,
} as const;
const MIN_LEASE_MS = 1_000;
const LEASE_DB_BUSY_TIMEOUT_MS = 0;
const RELEASE_RETRY_TIMEOUT_MS = 2_000;
const processExitLeaseCleanups = new Set<() => void>();
let processExitListenerInstalled = false;

function runProcessExitLeaseCleanups(): void {
  processExitListenerInstalled = false;
  // Exit cleanup runs after CLI output routing is restored (for example after a
  // --json envelope already reached stdout). Lease release reopens the state
  // database and can emit diagnostics, so keep them on stderr to preserve
  // machine-readable stdout for the whole process lifetime.
  const previousForceConsoleToStderr = loggingState.forceConsoleToStderr;
  loggingState.forceConsoleToStderr = true;
  try {
    for (const cleanup of processExitLeaseCleanups) {
      try {
        cleanup();
      } catch {
        // Expiry still recovers a lease when synchronous process-exit cleanup loses a DB race.
      }
    }
    processExitLeaseCleanups.clear();
  } finally {
    loggingState.forceConsoleToStderr = previousForceConsoleToStderr;
  }
}

function registerProcessExitLeaseCleanup(cleanup: () => void): () => void {
  processExitLeaseCleanups.add(cleanup);
  if (!processExitListenerInstalled) {
    process.once("exit", runProcessExitLeaseCleanups);
    processExitListenerInstalled = true;
  }
  return () => {
    processExitLeaseCleanups.delete(cleanup);
    if (processExitLeaseCleanups.size === 0 && processExitListenerInstalled) {
      process.removeListener("exit", runProcessExitLeaseCleanups);
      processExitListenerInstalled = false;
    }
  };
}

function leaseError(
  code: OpenClawStateLeaseErrorCode,
  message: string,
  cause?: unknown,
): OpenClawStateLeaseError {
  return new OpenClawStateLeaseError(message, {
    code,
    ...(cause === undefined ? {} : { cause }),
  });
}

function invalidInput(message: string): OpenClawStateLeaseError {
  return leaseError("OPENCLAW_STATE_LEASE_INVALID_INPUT", message);
}

function validateDuration(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidInput(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validateNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw invalidInput(`${label} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function validateOptions(options: OpenClawStateLeaseOptions) {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw invalidInput("state lease options must be an object");
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw invalidInput("state lease signal must be an AbortSignal");
  }
  const database = options.database;
  if (typeof database !== "object" || database === null || Array.isArray(database)) {
    throw invalidInput("state lease database must be an object");
  }
  if (database.scope !== "shared" && database.scope !== "agent") {
    throw invalidInput("state lease database scope must be shared or agent");
  }
  if (database.scope === "agent") {
    validateNonEmptyString(database.agentId, "state lease agent database agentId");
  }
  const leaseLabel =
    options.leaseLabel === undefined
      ? "state lease"
      : validateNonEmptyString(options.leaseLabel, "state lease label");
  const operationLabel =
    options.operationLabel === undefined
      ? "state.lease"
      : validateNonEmptyString(options.operationLabel, "state lease operationLabel");
  return {
    scope: validateNonEmptyString(options.scope, `${leaseLabel} scope`),
    key: validateNonEmptyString(options.key, `${leaseLabel} key`),
    database,
    leaseMs: validateDuration(
      options.leaseMs,
      `${leaseLabel} leaseMs`,
      MIN_LEASE_MS,
      MAX_TIMER_TIMEOUT_MS,
    ),
    waitMs: validateDuration(options.waitMs, `${leaseLabel} waitMs`, 0, MAX_TIMER_TIMEOUT_MS),
    signal: options.signal,
    leaseLabel,
    operationLabel,
    processOwner: options.processOwner,
    strictRelease: options.strictRelease === true,
  };
}

function readBusyTimeout(database: DatabaseSync): number {
  const row = database // sqlite-allow-raw -- Narrow connection primitive for bounded lease admission.
    .prepare("PRAGMA busy_timeout")
    .get() as { busy_timeout?: unknown; timeout?: unknown } | undefined;
  const value = row?.busy_timeout ?? row?.timeout;
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

function withBusyTimeout<T>(database: DatabaseSync, busyTimeoutMs: number, run: () => T): T {
  const previousBusyTimeoutMs = readBusyTimeout(database);
  if (previousBusyTimeoutMs === busyTimeoutMs) {
    return run();
  }
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`); // sqlite-allow-raw -- Bound synchronous lease admission to waitMs.
  try {
    return run();
  } finally {
    if (database.isOpen) {
      database.exec(`PRAGMA busy_timeout = ${previousBusyTimeoutMs}`); // sqlite-allow-raw -- Restore canonical connection policy.
    }
  }
}

function withLeaseWriteTransaction<T>(
  database: OpenClawStateLeaseDatabase,
  operationLabel: string,
  operation: (db: DatabaseSync, kysely: LeaseKysely) => T,
  busyTimeoutMs = LEASE_DB_BUSY_TIMEOUT_MS,
): T {
  if (database.scope === "shared") {
    const stateDatabase = openOpenClawStateDatabase(database.options);
    const run = () =>
      runOpenClawStateWriteTransaction(
        ({ db }) => operation(db, getNodeSqliteKysely<LeaseDatabase>(db)),
        database.options,
        { operationLabel, busyTimeoutMs },
      );
    return withBusyTimeout(stateDatabase.db, busyTimeoutMs, run);
  }
  const agentOptions = {
    agentId: database.agentId,
    ...(database.path ? { path: database.path } : {}),
  };
  const agentDatabase = openOpenClawAgentDatabase(agentOptions);
  const run = () =>
    runOpenClawAgentWriteTransaction(
      ({ db }) => operation(db, getNodeSqliteKysely<AgentLeaseDatabase>(db)),
      agentOptions,
      { operationLabel, busyTimeoutMs },
    );
  return withBusyTimeout(agentDatabase.db, busyTimeoutMs, run);
}

function withLeaseRead<T>(
  database: OpenClawStateLeaseDatabase,
  operation: (db: DatabaseSync, kysely: LeaseKysely) => T,
): T {
  const sqlite =
    database.scope === "shared"
      ? openOpenClawStateDatabase(database.options).db
      : openOpenClawAgentDatabase({
          agentId: database.agentId,
          ...(database.path ? { path: database.path } : {}),
        }).db;
  return operation(sqlite, getNodeSqliteKysely<LeaseDatabase>(sqlite));
}

type LeaseIdentity = {
  scope: string;
  key: string;
  owner: string;
  leaseLabel: string;
  processOwner?: OpenClawStateLeaseProcessOwner;
};

function processLeaseIsReclaimable(
  row: { expires_at: number | null; payload_json: string | null },
  processOwner: OpenClawStateLeaseProcessOwner,
): boolean {
  let payload: { pid?: unknown; starttime?: unknown } | undefined;
  try {
    payload = row.payload_json ? (JSON.parse(row.payload_json) as typeof payload) : undefined;
  } catch {
    // A malformed owner can only be reclaimed after its persisted deadline.
  }
  const pid = payload?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return Number(row.expires_at) <= Date.now();
  }
  if (!processOwner.isAlive(pid)) {
    return true;
  }
  const observedStartTime = processOwner.readStartTime(pid);
  return (
    typeof payload?.starttime === "number" &&
    Number.isInteger(payload.starttime) &&
    payload.starttime >= 0 &&
    observedStartTime !== null &&
    payload.starttime !== observedStartTime
  );
}

function tryAcquire(
  params: LeaseIdentity & {
    database: OpenClawStateLeaseDatabase;
    operationLabel: string;
    leaseMs: number;
  },
): number | undefined {
  const observed = params.processOwner
    ? withLeaseRead(params.database, (db, kysely) =>
        executeSqliteQueryTakeFirstSync(
          db,
          kysely
            .selectFrom("state_leases")
            .select(["owner", "expires_at", "payload_json"])
            .where("scope", "=", params.scope)
            .where("lease_key", "=", params.key),
        ),
      )
    : undefined;
  // Process inspection may perform filesystem/subprocess work, so gather it
  // before BEGIN and fence deletion against the observed owner inside it.
  const reclaimableOwner =
    observed && params.processOwner && processLeaseIsReclaimable(observed, params.processOwner)
      ? observed.owner
      : undefined;
  return withLeaseWriteTransaction(params.database, params.operationLabel, (db, kysely) => {
    // BEGIN IMMEDIATE may wait on SQLite. Sample only after admission so a
    // successful insert never commits an already-expired lease.
    const now = Date.now();
    if (!params.processOwner || reclaimableOwner) {
      let stale = kysely
        .deleteFrom("state_leases")
        .where("scope", "=", params.scope)
        .where("lease_key", "=", params.key);
      stale = reclaimableOwner
        ? stale.where("owner", "=", reclaimableOwner)
        : stale.where("expires_at", "<=", now);
      executeSqliteQuerySync(db, stale);
    }
    const expiresAt = now + params.leaseMs;
    const inserted = executeSqliteQuerySync(
      db,
      kysely
        .insertInto("state_leases")
        .values({
          scope: params.scope,
          lease_key: params.key,
          owner: params.owner,
          expires_at: expiresAt,
          heartbeat_at: now,
          payload_json: params.processOwner
            ? JSON.stringify({
                pid: params.processOwner.pid,
                ...(params.processOwner.startTime === null
                  ? {}
                  : { starttime: params.processOwner.startTime }),
              })
            : null,
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) => conflict.columns(["scope", "lease_key"]).doNothing()),
    );
    return inserted.numAffectedRows === 1n ? expiresAt : undefined;
  });
}

function renew(
  params: LeaseIdentity & {
    database: OpenClawStateLeaseDatabase;
    operationLabel: string;
    leaseMs: number;
  },
): number {
  return withLeaseWriteTransaction(params.database, params.operationLabel, (db, kysely) => {
    const now = Date.now();
    const expiresAt = now + params.leaseMs;
    let update = kysely
      .updateTable("state_leases")
      .set({ expires_at: expiresAt, heartbeat_at: now, updated_at: now })
      .where("scope", "=", params.scope)
      .where("lease_key", "=", params.key)
      .where("owner", "=", params.owner);
    if (!params.processOwner) {
      update = update.where("expires_at", ">", now);
    }
    const updated = executeSqliteQuerySync(db, update);
    if (updated.numAffectedRows !== 1n) {
      throw leaseError(
        "OPENCLAW_STATE_LEASE_LOST",
        `${params.leaseLabel} ${params.scope}/${params.key} was lost`,
      );
    }
    return expiresAt;
  });
}

function assertLeaseOwnedInDatabase(
  database: DatabaseSync,
  kysely: LeaseKysely,
  params: LeaseIdentity,
): void {
  const now = Date.now();
  let query = kysely
    .selectFrom("state_leases")
    .select("owner")
    .where("scope", "=", params.scope)
    .where("lease_key", "=", params.key)
    .where("owner", "=", params.owner);
  if (!params.processOwner) {
    query = query.where("expires_at", ">", now);
  }
  const row = executeSqliteQueryTakeFirstSync(database, query);
  if (!row) {
    throw leaseError(
      "OPENCLAW_STATE_LEASE_LOST",
      `${params.leaseLabel} ${params.scope}/${params.key} was lost`,
    );
  }
}

function verifyLeaseOwnership(
  params: LeaseIdentity & { database?: OpenClawStateLeaseDatabase; transaction?: DatabaseSync },
): void {
  try {
    if (params.transaction) {
      assertLeaseOwnedInDatabase(
        params.transaction,
        getNodeSqliteKysely<LeaseDatabase>(params.transaction),
        params,
      );
      return;
    }
    if (!params.database) {
      throw new Error("state lease ownership check requires a database");
    }
    withLeaseRead(params.database, (db, kysely) => assertLeaseOwnedInDatabase(db, kysely, params));
  } catch (error) {
    if (error instanceof OpenClawStateLeaseError) {
      throw error;
    }
    throw leaseError(
      "OPENCLAW_STATE_LEASE_STORAGE_FAILED",
      `failed to verify ${params.leaseLabel} ${params.scope}/${params.key}`,
      error,
    );
  }
}

function release(
  params: LeaseIdentity & {
    database: OpenClawStateLeaseDatabase;
    operationLabel: string;
  },
): void {
  withLeaseWriteTransaction(params.database, params.operationLabel, (db, kysely) => {
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("state_leases")
        .where("scope", "=", params.scope)
        .where("lease_key", "=", params.key)
        .where("owner", "=", params.owner),
    );
  });
}

async function releaseBestEffort(
  params: Parameters<typeof release>[0],
  strict = false,
): Promise<void> {
  const deadline = performance.now() + RELEASE_RETRY_TIMEOUT_MS;
  let attempt = 0;
  while (true) {
    try {
      release(params);
      return;
    } catch (error) {
      const now = performance.now();
      if (!isSqliteLockError(error) || now >= deadline) {
        if (strict) {
          throw error;
        }
        return;
      }
      attempt += 1;
      // Lease transactions never block the event loop. Cleanup instead gives
      // ordinary cross-process writers a bounded async window to finish.
      await sleepWithAbort(Math.min(deadline - now, computeBackoff(ACQUIRE_BACKOFF, attempt)));
    }
  }
}

function abortError(
  signal: AbortSignal,
  label: string,
  leaseLabel: string,
): OpenClawStateLeaseError {
  return leaseError(
    "OPENCLAW_STATE_LEASE_ABORTED",
    `${leaseLabel} ${label} was aborted`,
    signal.reason,
  );
}

/** Acquire a host-owned SQLite lease for callers whose lifecycle spans callbacks. */
export async function acquireOpenClawStateLease(
  options: OpenClawStateLeaseOptions,
): Promise<OpenClawStateLeaseHandle> {
  const validated = validateOptions(options);
  if (validated.signal?.aborted) {
    throw abortError(validated.signal, "acquisition", validated.leaseLabel);
  }
  const owner = randomUUID();
  // Acquisition budgets are elapsed-time contracts. Wall-clock changes still
  // affect persisted expiry timestamps, but must not lengthen or shorten waits.
  const deadline = performance.now() + validated.waitMs;
  let attempt = 0;
  let confirmedExpiresAt: number | undefined;
  while (confirmedExpiresAt === undefined) {
    if (validated.signal?.aborted) {
      throw abortError(validated.signal, "acquisition", validated.leaseLabel);
    }
    try {
      confirmedExpiresAt = tryAcquire({
        database: validated.database,
        operationLabel: validated.operationLabel,
        scope: validated.scope,
        key: validated.key,
        owner,
        leaseMs: validated.leaseMs,
        leaseLabel: validated.leaseLabel,
        processOwner: validated.processOwner,
      });
    } catch (error) {
      if (error instanceof OpenClawStateLeaseError) {
        throw error;
      }
      if (!isSqliteLockError(error)) {
        throw leaseError(
          "OPENCLAW_STATE_LEASE_STORAGE_FAILED",
          `failed to acquire ${validated.leaseLabel} ${validated.scope}/${validated.key}`,
          error,
        );
      }
    }
    const now = performance.now();
    if (confirmedExpiresAt !== undefined) {
      if (validated.signal?.aborted || (validated.waitMs > 0 && now >= deadline)) {
        await releaseBestEffort({
          database: validated.database,
          operationLabel: validated.operationLabel,
          scope: validated.scope,
          key: validated.key,
          owner,
          leaseLabel: validated.leaseLabel,
        });
        if (validated.signal?.aborted) {
          throw abortError(validated.signal, "acquisition", validated.leaseLabel);
        }
        throw leaseError(
          "OPENCLAW_STATE_LEASE_TIMEOUT",
          `timed out waiting for ${validated.leaseLabel} ${validated.scope}/${validated.key}`,
        );
      }
      break;
    }
    if (now >= deadline) {
      throw leaseError(
        "OPENCLAW_STATE_LEASE_TIMEOUT",
        `timed out waiting for ${validated.leaseLabel} ${validated.scope}/${validated.key}`,
      );
    }
    attempt += 1;
    const delayMs = Math.min(deadline - now, computeBackoff(ACQUIRE_BACKOFF, attempt));
    try {
      await sleepWithAbort(delayMs, validated.signal);
    } catch (error) {
      if (validated.signal?.aborted) {
        throw abortError(validated.signal, "acquisition", validated.leaseLabel);
      }
      throw error;
    }
  }

  const identity: LeaseIdentity = {
    scope: validated.scope,
    key: validated.key,
    owner,
    leaseLabel: validated.leaseLabel,
    processOwner: validated.processOwner,
  };
  // `process.exit()` skips async `finally` blocks. Release synchronously so a normal CLI error
  // cannot strand the lease until its TTL and block the next lifecycle command.
  const unregisterProcessExitCleanup = registerProcessExitLeaseCleanup(() => {
    release({
      ...identity,
      database: validated.database,
      operationLabel: validated.operationLabel,
    });
  });
  const leaseLost = new AbortController();
  const operationSignal = validated.signal
    ? AbortSignal.any([validated.signal, leaseLost.signal])
    : leaseLost.signal;
  const heartbeatMs = Math.max(250, Math.min(30_000, Math.floor(validated.leaseMs / 3)));
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const abortLost = (cause?: unknown) => {
    if (!leaseLost.signal.aborted) {
      leaseLost.abort(
        cause instanceof OpenClawStateLeaseError
          ? cause
          : leaseError(
              "OPENCLAW_STATE_LEASE_LOST",
              `${validated.leaseLabel} ${validated.scope}/${validated.key} expired`,
              cause,
            ),
      );
    }
  };
  const scheduleExpiry = () => {
    if (expiryTimer) {
      clearTimeout(expiryTimer);
    }
    expiryTimer = setTimeout(
      () => abortLost(),
      Math.max(1, (confirmedExpiresAt ?? Date.now()) - Date.now()),
    );
    expiryTimer.unref?.();
  };
  if (!validated.processOwner) {
    scheduleExpiry();
  }
  const heartbeat = setInterval(() => {
    try {
      confirmedExpiresAt = renew({
        ...identity,
        database: validated.database,
        operationLabel: validated.operationLabel,
        leaseMs: validated.leaseMs,
      });
      if (!validated.processOwner) {
        scheduleExpiry();
      }
    } catch (error) {
      if (error instanceof OpenClawStateLeaseError && error.code === "OPENCLAW_STATE_LEASE_LOST") {
        abortLost(error);
      } else if (
        !validated.processOwner &&
        confirmedExpiresAt !== undefined &&
        Date.now() >= confirmedExpiresAt
      ) {
        abortLost(error);
      }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  const assertOperationOwned = () => {
    if (leaseLost.signal.aborted) {
      throw leaseLost.signal.reason;
    }
    if (validated.signal?.aborted) {
      throw abortError(validated.signal, "operation", validated.leaseLabel);
    }
    verifyLeaseOwnership({ ...identity, database: validated.database });
  };
  const assertOperationOwnedInTransaction = (database: DatabaseSync) => {
    if (leaseLost.signal.aborted) {
      throw leaseLost.signal.reason;
    }
    if (validated.signal?.aborted) {
      throw abortError(validated.signal, "operation", validated.leaseLabel);
    }
    verifyLeaseOwnership({ ...identity, transaction: database });
  };
  let released = false;
  let releasePromise: Promise<void> | undefined;
  const clearLeaseLifecycle = () => {
    unregisterProcessExitCleanup();
    clearInterval(heartbeat);
    if (expiryTimer) {
      clearTimeout(expiryTimer);
    }
  };
  const releaseSynchronously = () => {
    if (released) {
      return;
    }
    release({
      ...identity,
      database: validated.database,
      operationLabel: validated.operationLabel,
    });
    released = true;
    clearLeaseLifecycle();
  };
  return {
    signal: operationSignal,
    assertOwned: assertOperationOwned,
    assertOwnedInTransaction: assertOperationOwnedInTransaction,
    releaseSynchronously,
    release: () => {
      if (released) {
        return Promise.resolve();
      }
      releasePromise ??= releaseBestEffort(
        { ...identity, database: validated.database, operationLabel: validated.operationLabel },
        validated.strictRelease,
      ).then(
        () => {
          released = true;
          clearLeaseLifecycle();
        },
        (error: unknown) => {
          releasePromise = undefined;
          throw error;
        },
      );
      return releasePromise;
    },
  };
}

/** Run one trusted operation under a host-owned SQLite lease. */
export async function withOpenClawStateLease<T>(
  options: OpenClawStateLeaseOptions,
  run: (lease: OpenClawStateLeaseContext) => Promise<T>,
): Promise<T> {
  const lease = await acquireOpenClawStateLease(options);
  try {
    lease.assertOwned();
    const result = await run(lease);
    lease.assertOwned();
    return result;
  } catch (error) {
    if (options.signal?.aborted) {
      throw abortError(options.signal, "operation", options.leaseLabel ?? "state lease");
    }
    if (lease.signal.aborted) {
      throw lease.signal.reason;
    }
    throw error;
  } finally {
    await lease.release();
  }
}
