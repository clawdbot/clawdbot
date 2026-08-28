// Stores durable delivery queue entries in SQLite.
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  bindDeliveryQueueEntry,
  deliveryQueueEntriesQuery,
  pruneDeliveryQueueTombstoneAges,
  pruneDeliveryQueueTombstones,
  terminalizeBoundDeliveryQueueEntry,
  type DeliveryQueueDatabase,
  type DeliveryQueueReadMode,
  type UpsertDeliveryQueueEntryParams,
  upsertBoundDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite-bound.js";
import {
  inflateDeliveryQueueEntry,
  inflateDeliveryQueueEntryResult,
  type DeliveryQueueEntryLoadResult,
  type DeliveryQueueSqliteRow,
} from "./delivery-queue-sqlite-codec.js";
import type { DeliveryQueueEntryState } from "./delivery-queue-sqlite.types.js";
import {
  hasLiveDeliveryQueueClaim,
  inferDeliveryQueueFailureRetention,
  parseDeliveryQueueCompletionRetention,
  projectDeliveryQueueTerminalEntry,
} from "./delivery-queue-sqlite.types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

export type {
  DeliveryQueueCompletionRetention,
  DeliveryQueueEntryState,
} from "./delivery-queue-sqlite.types.js";

// Generic durable delivery queue storage shared by session and outbound queues.
// Queue-specific wrappers own payload shape; this layer owns SQLite state.
type QueueStatus = "pending" | "failed" | "completed";
type DeliveryQueueStatusRow = {
  queue_name: string;
  status?: QueueStatus;
  entry_json: string;
  recovery_state: string | null;
};

export type { DeliveryQueueEntryLoadResult } from "./delivery-queue-sqlite-codec.js";

type TerminalizePendingDeliveryQueueEntryResult =
  | { status: "terminalized"; retained: boolean }
  | { status: "not_pending" };

function openStateDatabase(stateDir?: string) {
  return openOpenClawStateDatabase({
    env: stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env,
  });
}

function enoent(queueName: string, id: string): Error & { code: string } {
  const err = new Error(`No pending ${queueName} delivery queue entry ${id}`) as Error & {
    code: string;
  };
  err.code = "ENOENT";
  return err;
}

function upsertDeliveryQueueEntryInDatabase(
  params: UpsertDeliveryQueueEntryParams,
  database: OpenClawStateDatabase,
): boolean {
  return upsertBoundDeliveryQueueEntryInDatabase(bindDeliveryQueueEntry(params), database);
}

/** Insert or replace a delivery queue entry under a queue namespace. */
export function upsertDeliveryQueueEntry(params: UpsertDeliveryQueueEntryParams): boolean {
  return upsertDeliveryQueueEntryInDatabase(params, openStateDatabase(params.stateDir));
}

/**
 * Expire abandoned staging rows and capture destination/staging ownership in
 * one write snapshot. A concurrent commit either lands before this snapshot or
 * loses its staging row and must fail closed.
 */
export function expireStagingAndLoadDeliveryQueueEntries(params: {
  expireBeforeMs: number;
  queueNames: readonly string[];
  stagingQueueName: string;
  stateDir?: string;
}): {
  entries: DeliveryQueueEntryState[];
  stagingEntries: DeliveryQueueEntryState[];
} {
  const database = openStateDatabase(params.stateDir);
  const snapshot = runSqliteImmediateTransactionSync(
    database.db,
    () => {
      // sqlite-allow-raw: Expiry must share the write snapshot with both ownership reads.
      database.db
        .prepare(
          `DELETE FROM delivery_queue_entries
            WHERE queue_name = ? AND status = 'pending' AND enqueued_at <= ?`,
        )
        .run(params.stagingQueueName, params.expireBeforeMs);
      const read = (queueNames: readonly string[]) =>
        executeSqliteQuerySync(
          database.db,
          deliveryQueueEntriesQuery(database, queueNames, "unfinished")
            .orderBy("enqueued_at", "asc")
            .orderBy("id", "asc"),
        ).rows as DeliveryQueueSqliteRow[];
      return {
        entryRows: read(params.queueNames),
        stagingRows: read([params.stagingQueueName]),
      };
    },
    {
      databaseLabel: "openclaw-state",
      operationLabel: "expire delivery queue staging entries",
    },
  );
  return {
    entries: snapshot.entryRows
      .map(inflateDeliveryQueueEntry)
      .filter((entry): entry is DeliveryQueueEntryState => entry != null),
    stagingEntries: snapshot.stagingRows
      .map(inflateDeliveryQueueEntry)
      .filter((entry): entry is DeliveryQueueEntryState => entry != null),
  };
}

/** Load a single pending delivery queue entry. */
export function loadDeliveryQueueEntry(
  queueName: string,
  id: string,
  stateDir?: string,
  mode: DeliveryQueueReadMode = "pending",
): DeliveryQueueEntryState | null {
  const result = loadDeliveryQueueEntryResult(queueName, id, stateDir, mode);
  return result?.status === "loaded" ? result.entry : null;
}

/** Load one entry while preserving structural metadata for invalid JSON. */
export function loadDeliveryQueueEntryResult(
  queueName: string,
  id: string,
  stateDir?: string,
  mode: DeliveryQueueReadMode = "pending",
): DeliveryQueueEntryLoadResult | null {
  const database = openStateDatabase(stateDir);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    deliveryQueueEntriesQuery(database, [queueName], mode)
      .select("entry_kind")
      .where("id", "=", id),
  );
  return row ? inflateDeliveryQueueEntryResult(row) : null;
}

/** Read row status without hiding dead-lettered entries. */
export function getDeliveryQueueEntryStatus(
  queueName: string,
  id: string,
  stateDir?: string,
): QueueStatus | undefined {
  return getDeliveryQueueEntryOwners([queueName], id, stateDir).get(queueName)?.status;
}

/** Read one exact ID across physical namespaces from a single ownership snapshot. */
export function getDeliveryQueueEntryOwners(
  queueNames: readonly string[],
  id: string,
  stateDir?: string,
): Map<string, { status: QueueStatus; settlementPending?: true }> {
  if (queueNames.length === 0) {
    return new Map();
  }
  const database = openStateDatabase(stateDir);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  return runSqliteImmediateTransactionSync(
    database.db,
    () => {
      const readExact = () =>
        executeSqliteQuerySync(
          database.db,
          queueDb
            .selectFrom("delivery_queue_entries")
            .select(["queue_name", "status", "entry_json", "recovery_state"])
            .where("queue_name", "in", queueNames)
            .where("id", "=", id),
        ).rows as DeliveryQueueStatusRow[];
      let rows = readExact();
      let pruned = false;
      for (const row of rows) {
        if (row.recovery_state !== "completed_bounded") {
          continue;
        }
        const entry = safeParseJsonRecord(row.entry_json);
        const retention = parseDeliveryQueueCompletionRetention(entry?.completionRetention, id);
        if (typeof retention === "object") {
          pruneDeliveryQueueTombstones(database.db, Date.now(), {
            queueName: row.queue_name,
            idPrefix: retention.idPrefix,
          });
          pruned = true;
        }
      }
      if (pruned) {
        rows = readExact();
      }
      return new Map(
        rows.flatMap((row) =>
          row.status
            ? [
                [
                  row.queue_name,
                  {
                    status: row.status,
                    ...(row.status === "failed" && row.recovery_state === "settlement_pending"
                      ? { settlementPending: true as const }
                      : {}),
                  },
                ],
              ]
            : [],
        ),
      );
    },
    {
      databaseLabel: "openclaw-state",
      operationLabel: "read delivery queue status",
    },
  );
}

/** Load all pending entries for a queue namespace in database order. */
export function loadDeliveryQueueEntries(
  queueName: string,
  stateDir?: string,
  mode: DeliveryQueueReadMode = "pending",
): DeliveryQueueEntryState[] {
  return loadDeliveryQueueEntryResults(queueName, stateDir, mode).flatMap((result) =>
    result.status === "loaded" ? [result.entry] : [],
  );
}

/** Load entries while preserving structural metadata for invalid JSON rows. */
export function loadDeliveryQueueEntryResults(
  queueName: string,
  stateDir?: string,
  mode: DeliveryQueueReadMode = "pending",
): DeliveryQueueEntryLoadResult[] {
  const database = openStateDatabase(stateDir);
  const rows = executeSqliteQuerySync(
    database.db,
    deliveryQueueEntriesQuery(database, [queueName], mode)
      .select("entry_kind")
      .orderBy("enqueued_at", "asc")
      .orderBy("id", "asc"),
  ).rows as DeliveryQueueSqliteRow[];
  return rows.map(inflateDeliveryQueueEntryResult);
}

/** Delete a pending delivery queue entry after successful delivery. */
export function deleteDeliveryQueueEntry(queueName: string, id: string, stateDir?: string): void {
  const database = openStateDatabase(stateDir);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    queueDb
      .deleteFrom("delivery_queue_entries")
      .where("queue_name", "=", queueName)
      .where("id", "=", id)
      .where("status", "=", "pending"),
  );
}

/** Retain a delivered row as a durable idempotency tombstone. */
export function completeDeliveryQueueEntry(queueName: string, id: string, stateDir?: string): void {
  const now = Date.now();
  const current = loadDeliveryQueueEntry(queueName, id, stateDir);
  const requestedRetention = current?.completionRetention;
  const retention = parseDeliveryQueueCompletionRetention(requestedRetention, id);
  if (requestedRetention && !retention) {
    throw new Error(`Invalid bounded delivery completion retention: ${queueName}/${id}`);
  }
  const tombstone = projectDeliveryQueueTerminalEntry(
    { id, retryCount: 0 },
    now,
    "completed",
    retention,
  );
  const completed = upsertDeliveryQueueEntry({
    queueName,
    entry: tombstone,
    metadata: {},
    status: "completed",
    stateDir,
    completeExisting: true,
  });
  if (!completed) {
    if (getDeliveryQueueEntryStatus(queueName, id, stateDir) === "completed") {
      return;
    }
    throw enoent(queueName, id);
  }
  if (typeof retention === "object") {
    getDeliveryQueueEntryStatus(queueName, id, stateDir);
  }
}

/** Load, transform, and persist a pending delivery queue entry. */
export function updateDeliveryQueueEntry(
  queueName: string,
  id: string,
  stateDir: string | undefined,
  update: (entry: DeliveryQueueEntryState) => DeliveryQueueEntryState,
): void {
  const current = loadDeliveryQueueEntry(queueName, id, stateDir);
  if (!current) {
    throw enoent(queueName, id);
  }
  upsertDeliveryQueueEntry({ queueName, entry: update(current), stateDir });
}

type ReserveDeliveryQueueAttemptResult =
  | { status: "reserved"; attemptCount: number }
  | { status: "exhausted"; attemptCount: number };

/** Atomically reserve one provider-delivery call before executing it. */
export function reserveDeliveryQueueEntryAttempt(params: {
  queueName: string;
  id: string;
  maxAttempts: number;
  stateDir?: string;
  expectedPlatformSendAttemptId?: string;
}): ReserveDeliveryQueueAttemptResult {
  if (!Number.isInteger(params.maxAttempts) || params.maxAttempts <= 0) {
    throw new Error(`Invalid delivery attempt budget: ${params.maxAttempts}`);
  }
  const database = openStateDatabase(params.stateDir);
  return runSqliteImmediateTransactionSync(
    database.db,
    () => {
      const current = loadDeliveryQueueEntry(params.queueName, params.id, params.stateDir);
      if (!current) {
        throw enoent(params.queueName, params.id);
      }
      if (
        params.expectedPlatformSendAttemptId &&
        !hasLiveDeliveryQueueClaim(current, params.expectedPlatformSendAttemptId, Date.now())
      ) {
        throw new Error(`Delivery platform claim was lost: ${params.id}`);
      }
      const persistedAttemptCount =
        typeof current.attemptCount === "number" &&
        Number.isInteger(current.attemptCount) &&
        current.attemptCount >= 0
          ? current.attemptCount
          : 0;
      const attemptCount = Math.max(persistedAttemptCount, current.retryCount);
      if (attemptCount >= params.maxAttempts) {
        return { status: "exhausted", attemptCount };
      }
      const reservedAttemptCount = attemptCount + 1;
      const updated = upsertDeliveryQueueEntryInDatabase(
        {
          queueName: params.queueName,
          entry: { ...current, attemptCount: reservedAttemptCount },
          updatePendingOnly: true,
        },
        database,
      );
      if (!updated) {
        throw enoent(params.queueName, params.id);
      }
      return { status: "reserved", attemptCount: reservedAttemptCount };
    },
    {
      databaseLabel: "openclaw-state",
      operationLabel: `reserve ${params.queueName} delivery attempt`,
    },
  );
}

/** Count dead-lettered entries per queue namespace for coarse health reporting. */
export function countFailedDeliveryQueueEntries(stateDir?: string): Array<{
  queueName: string;
  count: number;
  oldestFailedAt?: number;
}> {
  const database = openStateDatabase(stateDir);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    queueDb
      .selectFrom("delivery_queue_entries")
      .select((eb) => [
        "queue_name as queueName",
        eb.fn.countAll<number>().as("count"),
        eb.fn.min<number>("failed_at").as("oldestFailedAt"),
      ])
      .where("status", "=", "failed")
      .groupBy("queue_name")
      .orderBy("queue_name", "asc"),
  ).rows;
  return rows.map(({ oldestFailedAt, ...row }) =>
    oldestFailedAt == null ? row : Object.assign(row, { oldestFailedAt }),
  );
}

/** Count pending entries across an exact set of queue namespaces. */
export function countPendingDeliveryQueueEntries(
  queueNames: readonly string[],
  stateDir?: string,
): number {
  if (queueNames.length === 0) {
    return 0;
  }
  const database = openStateDatabase(stateDir);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  const [row] = executeSqliteQuerySync(
    database.db,
    queueDb
      .selectFrom("delivery_queue_entries")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("queue_name", "in", queueNames)
      .where("status", "=", "pending"),
  ).rows;
  return row?.count ?? 0;
}

/** Physically expire age-bounded delivery queue tombstones. */
export function pruneExpiredDeliveryQueueTombstones(
  stateDir?: string,
  now: number = Date.now(),
): void {
  const database = openStateDatabase(stateDir);
  runSqliteImmediateTransactionSync(
    database.db,
    () => pruneDeliveryQueueTombstoneAges(database.db, now),
    { databaseLabel: "openclaw-state", operationLabel: "expire delivery queue tombstones" },
  );
}

/** Atomically delete or tombstone a pending row only while its value is unchanged. */
export function terminalizePendingDeliveryQueueEntry(params: {
  queueName: string;
  id: string;
  entry: DeliveryQueueEntryState;
  /** Persisted text to guard on when the caller cannot re-serialize the row. */
  expectedEntryJson?: string;
  /** Optional payload-free diagnostic retained outside the terminal receipt JSON. */
  lastError?: string;
  stateDir?: string;
  expectedStatus?: "pending" | "failed";
}): TerminalizePendingDeliveryQueueEntryResult {
  if (params.entry.id !== params.id) {
    throw new Error(`Delivery queue entry id mismatch: ${params.entry.id} != ${params.id}`);
  }
  const now = Date.now();
  const database = openStateDatabase(params.stateDir);
  const expectedJson = params.expectedEntryJson ?? JSON.stringify(params.entry);
  const retention = inferDeliveryQueueFailureRetention(params.entry, params.id, params.queueName);
  const failedEntry = retention
    ? projectDeliveryQueueTerminalEntry(params.entry, now, "failed", retention)
    : undefined;
  if (
    !terminalizeBoundDeliveryQueueEntry(
      database.db,
      params.queueName,
      params.id,
      expectedJson,
      failedEntry,
      now,
      params.expectedStatus,
    )
  ) {
    return { status: "not_pending" };
  }
  if (failedEntry && params.lastError !== undefined) {
    const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      queueDb
        .updateTable("delivery_queue_entries")
        .set({ last_error: params.lastError })
        .where("queue_name", "=", params.queueName)
        .where("id", "=", params.id)
        .where("status", "=", "failed"),
    );
  }
  if (typeof retention === "object") {
    getDeliveryQueueEntryStatus(params.queueName, params.id, params.stateDir);
  }
  return { status: "terminalized", retained: retention !== undefined };
}
