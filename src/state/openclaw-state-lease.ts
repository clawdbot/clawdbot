// Host-owned SQLite leases serialize trusted work across processes.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { isSqliteLockError } from "../infra/sqlite-transaction.js";
import { loggingState } from "../logging/state.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { startOpenClawStateLeaseHeartbeat } from "./openclaw-state-lease-heartbeat.js";
import {
  acquireOpenClawStateLeaseInTransaction,
  readOpenClawStateLeaseExpiry,
  releaseOpenClawStateLeaseInTransaction,
  renewOpenClawStateLeaseInTransaction,
} from "./openclaw-state-lease-store.js";

type OpenClawStateLeaseDatabase = {
  scope: "shared";
  options?: OpenClawStateDatabaseOptions;
};

type OpenClawStateLeaseOptions = {
  scope: string;
  key: string;
  database: OpenClawStateLeaseDatabase;
  leaseMs: number;
  waitMs: number;
  signal?: AbortSignal;
  /** Maintenance can block the event loop for longer than the lease duration. */
  heartbeat?: "worker";
  /** Stable diagnostic noun used in errors. */
  leaseLabel?: string;
  /** Stable transaction label used by SQLite diagnostics. */
  operationLabel?: string;
};

export type OpenClawStateLeaseContext = {
  signal: AbortSignal;
  /** Renew or verify independent renewal before another blocking phase. */
  renew?(): void;
  /** Verify that this exact owner holds a non-expired lease at this instant. */
  assertOwned(): void;
  /** Verify ownership using the caller's active write transaction. */
  assertOwnedInTransaction(database: DatabaseSync): void;
};

type OpenClawStateLeaseErrorCode =
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
  if (database.scope !== "shared") {
    throw invalidInput("state lease database scope must be shared");
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
    heartbeat: options.heartbeat,
    leaseLabel,
    operationLabel,
  };
}

function withLeaseWriteTransaction<T>(
  database: OpenClawStateLeaseDatabase,
  operationLabel: string,
  operation: (db: DatabaseSync) => T,
  busyTimeoutMs = LEASE_DB_BUSY_TIMEOUT_MS,
): T {
  const stateDatabase = openOpenClawStateDatabase(database.options);
  const run = () =>
    runOpenClawStateWriteTransaction(
      ({ db }) => operation(db),
      { ...database.options, database: stateDatabase },
      { operationLabel, busyTimeoutMs },
    );
  return runWithSqliteBusyTimeout(stateDatabase.db, busyTimeoutMs, run);
}

type LeaseIdentity = {
  scope: string;
  key: string;
  owner: string;
  leaseLabel: string;
};

function tryAcquire(
  params: LeaseIdentity & {
    database: OpenClawStateLeaseDatabase;
    operationLabel: string;
    leaseMs: number;
  },
): number | undefined {
  return withLeaseWriteTransaction(params.database, params.operationLabel, (db) =>
    acquireOpenClawStateLeaseInTransaction(db, params, params.leaseMs),
  );
}

function renew(
  params: LeaseIdentity & {
    database: OpenClawStateLeaseDatabase;
    operationLabel: string;
    leaseMs: number;
  },
): number {
  return withLeaseWriteTransaction(params.database, params.operationLabel, (db) => {
    const expiresAt = renewOpenClawStateLeaseInTransaction(db, params, params.leaseMs);
    if (expiresAt === undefined) {
      throw leaseError(
        "OPENCLAW_STATE_LEASE_LOST",
        `${params.leaseLabel} ${params.scope}/${params.key} was lost`,
      );
    }
    return expiresAt;
  });
}

function assertLeaseOwnedInDatabase(database: DatabaseSync, params: LeaseIdentity): number {
  const expiresAt = readOpenClawStateLeaseExpiry(database, params);
  if (expiresAt === undefined) {
    throw leaseError(
      "OPENCLAW_STATE_LEASE_LOST",
      `${params.leaseLabel} ${params.scope}/${params.key} was lost`,
    );
  }
  return expiresAt;
}

function verifyLeaseOwnership(
  params: LeaseIdentity & { database?: OpenClawStateLeaseDatabase; transaction?: DatabaseSync },
): number {
  try {
    if (params.transaction) {
      return assertLeaseOwnedInDatabase(params.transaction, params);
    }
    if (!params.database) {
      throw new Error("state lease ownership check requires a database");
    }
    return assertLeaseOwnedInDatabase(
      openOpenClawStateDatabase(params.database.options).db,
      params,
    );
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
  withLeaseWriteTransaction(params.database, params.operationLabel, (db) =>
    releaseOpenClawStateLeaseInTransaction(db, params),
  );
}

async function releaseBestEffort(params: Parameters<typeof release>[0]): Promise<void> {
  const deadline = performance.now() + RELEASE_RETRY_TIMEOUT_MS;
  let attempt = 0;
  while (true) {
    try {
      release(params);
      return;
    } catch (error) {
      const now = performance.now();
      if (!isSqliteLockError(error) || now >= deadline) {
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

/** Run one trusted operation under a host-owned SQLite lease. */
export async function withOpenClawStateLease<T>(
  options: OpenClawStateLeaseOptions,
  run: (lease: OpenClawStateLeaseContext) => Promise<T>,
): Promise<T> {
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
  };
  let closed = false;
  let workerHeartbeat: ReturnType<typeof startOpenClawStateLeaseHeartbeat> | undefined;
  // `process.exit()` skips async `finally` blocks. Release synchronously so a normal CLI error
  // cannot strand the lease until its TTL and block the next lifecycle command.
  const unregisterProcessExitCleanup = registerProcessExitLeaseCleanup(() => {
    closed = true;
    workerHeartbeat?.close();
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
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const abortLost = (cause?: unknown) => {
    if (!leaseLost.signal.aborted) {
      leaseLost.abort(
        cause instanceof OpenClawStateLeaseError
          ? cause
          : leaseError(
              "OPENCLAW_STATE_LEASE_LOST",
              `${validated.leaseLabel} ${validated.scope}/${validated.key} was lost`,
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
  const renewAndSchedule = () => {
    confirmedExpiresAt = renew({
      ...identity,
      database: validated.database,
      operationLabel: validated.operationLabel,
      leaseMs: validated.leaseMs,
    });
    scheduleExpiry();
  };
  const renewOperation = () => {
    assertActive();
    if (workerHeartbeat) {
      assertOperationOwned();
    } else {
      renewAndSchedule();
    }
  };
  const renewFromTimer = () => {
    try {
      renewAndSchedule();
    } catch (error) {
      if (error instanceof OpenClawStateLeaseError && error.code === "OPENCLAW_STATE_LEASE_LOST") {
        abortLost(error);
      } else if (confirmedExpiresAt !== undefined && Date.now() >= confirmedExpiresAt) {
        abortLost(error);
      }
    }
  };

  const assertActive = () => {
    if (leaseLost.signal.aborted) {
      throw leaseLost.signal.reason;
    }
    if (validated.signal?.aborted) {
      throw abortError(validated.signal, "operation", validated.leaseLabel);
    }
    if (closed) {
      abortLost();
      throw leaseLost.signal.reason;
    }
  };
  const assertOperationOwned = (transaction?: DatabaseSync) => {
    assertActive();
    const params = { ...identity, database: validated.database, transaction };
    const expiresAt = verifyLeaseOwnership(params);
    if (workerHeartbeat) {
      try {
        workerHeartbeat.assertResponsive(expiresAt);
      } catch (error) {
        abortLost(error);
        throw leaseLost.signal.reason;
      }
      // Worker acknowledgement is liveness only. Recheck persisted ownership
      // after waiting, including inside a caller's already-held transaction.
      assertActive();
      verifyLeaseOwnership(params);
    }
  };
  const stopWorker = () => {
    void workerHeartbeat?.stop();
  };

  try {
    let result: T;
    try {
      if (validated.heartbeat === "worker") {
        workerHeartbeat = startOpenClawStateLeaseHeartbeat({
          path: openOpenClawStateDatabase(validated.database.options).path,
          identity,
          leaseMs: validated.leaseMs,
          heartbeatMs,
          expiresAt: confirmedExpiresAt,
          onLost: abortLost,
        });
        validated.signal?.addEventListener("abort", stopWorker, { once: true });
        if (validated.signal?.aborted) {
          stopWorker();
        }
        await workerHeartbeat.ready;
      } else {
        scheduleExpiry();
        heartbeat = setInterval(renewFromTimer, heartbeatMs);
        heartbeat.unref?.();
      }
      // Acquisition and callback entry are separate scheduling points. A
      // suspended process must not enter after its persisted lease expires.
      assertOperationOwned();
      result = await run({
        signal: operationSignal,
        renew: renewOperation,
        assertOwned: assertOperationOwned,
        assertOwnedInTransaction: assertOperationOwned,
      });
    } catch (error) {
      if (leaseLost.signal.aborted) {
        throw leaseLost.signal.reason;
      }
      if (validated.signal?.aborted) {
        throw abortError(validated.signal, "operation", validated.leaseLabel);
      }
      throw error;
    }
    assertOperationOwned();
    return result;
  } finally {
    closed = true;
    unregisterProcessExitCleanup();
    validated.signal?.removeEventListener("abort", stopWorker);
    clearInterval(heartbeat);
    if (expiryTimer) {
      clearTimeout(expiryTimer);
    }
    await workerHeartbeat?.stop();
    await releaseBestEffort({
      ...identity,
      database: validated.database,
      operationLabel: validated.operationLabel,
    });
  }
}
