// Stores durable delivery queue entries in SQLite.
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  bindDeliveryQueueEntry,
  inflateDeliveryQueueRow,
  loadDeliveryQueueEntryInDatabase,
  type DeliveryQueueDatabase,
  type DeliveryQueueRowMetadata,
  type DeliveryQueueSqliteRow,
  type UpsertDeliveryQueueEntryParams,
  upsertBoundDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite-bound.js";
import type {
  DeliveryQueueCompletionRetention,
  DeliveryQueueEntryState,
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
const COMPLETED_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const PERMANENT_COMPLETION_RECOVERY_STATE = "completed_permanent";
const BOUNDED_COMPLETION_RECOVERY_STATE = "completed_bounded";

type FailPendingDeliveryQueueEntryResult = { status: "failed" } | { status: "not_pending" };

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

type CommitStagedDeliveryQueueEntryParams = {
  queueName: string;
  entry: DeliveryQueueEntryState;
  metadata?: DeliveryQueueRowMetadata;
  stagingId: string;
  stagingQueueName: string;
  stateDir?: string;
};

function commitStagedDeliveryQueueEntryInternal(
  params: CommitStagedDeliveryQueueEntryParams,
): "created" | "existing" | "missing" {
  const database = openStateDatabase(params.stateDir);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  return runSqliteImmediateTransactionSync(
    database.db,
    () => {
      const staging = executeSqliteQueryTakeFirstSync(
        database.db,
        queueDb
          .selectFrom("delivery_queue_entries")
          .select("id")
          .where("queue_name", "=", params.stagingQueueName)
          .where("id", "=", params.stagingId)
          .where("status", "=", "pending"),
      ) as { id: string } | undefined;
      if (!staging) {
        return "missing";
      }
      const inserted = upsertDeliveryQueueEntryInDatabase(
        {
          queueName: params.queueName,
          entry: params.entry,
          metadata: params.metadata,
          insertOnly: true,
        },
        database,
      );
      if (!inserted) {
        return "existing";
      }
      const deleted = executeSqliteQuerySync(
        database.db,
        queueDb
          .deleteFrom("delivery_queue_entries")
          .where("queue_name", "=", params.stagingQueueName)
          .where("id", "=", params.stagingId)
          .where("status", "=", "pending"),
      );
      if (deleted.numAffectedRows !== 1n) {
        throw new Error(
          `Delivery queue staging row changed during commit: ${params.stagingQueueName}/${params.stagingId}`,
        );
      }
      return "created";
    },
    {
      databaseLabel: "openclaw-state",
      operationLabel: "commit staged delivery queue entry",
    },
  );
}

/** Atomically publish a queue row only while its staging row still exists. */
export function commitStagedDeliveryQueueEntry(
  params: CommitStagedDeliveryQueueEntryParams,
): boolean {
  const result = commitStagedDeliveryQueueEntryInternal(params);
  if (result === "existing") {
    throw new Error(`Delivery queue entry already exists: ${params.queueName}/${params.entry.id}`);
  }
  return result === "created";
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
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  const snapshot = runSqliteImmediateTransactionSync(
    database.db,
    () => {
      executeSqliteQuerySync(
        database.db,
        queueDb
          .deleteFrom("delivery_queue_entries")
          .where("queue_name", "=", params.stagingQueueName)
          .where("status", "=", "pending")
          .where("enqueued_at", "<=", params.expireBeforeMs),
      );
      const selectPending = (queueNames: readonly string[]) =>
        executeSqliteQuerySync(
          database.db,
          queueDb
            .selectFrom("delivery_queue_entries")
            .select([
              "id",
              "entry_json",
              "enqueued_at",
              "retry_count",
              "last_attempt_at",
              "last_error",
              "platform_send_started_at",
              "recovery_state",
            ])
            .where("queue_name", "in", queueNames)
            .where("status", "=", "pending")
            .orderBy("enqueued_at", "asc")
            .orderBy("id", "asc"),
        ).rows as DeliveryQueueSqliteRow[];
      return {
        entryRows: selectPending(params.queueNames),
        stagingRows: selectPending([params.stagingQueueName]),
      };
    },
    {
      databaseLabel: "openclaw-state",
      operationLabel: "expire delivery queue staging entries",
    },
  );
  return {
    entries: snapshot.entryRows
      .map(inflateDeliveryQueueRow)
      .filter((entry): entry is DeliveryQueueEntryState => entry != null),
    stagingEntries: snapshot.stagingRows
      .map(inflateDeliveryQueueRow)
      .filter((entry): entry is DeliveryQueueEntryState => entry != null),
  };
}

/** Load a single pending delivery queue entry. */
export function loadDeliveryQueueEntry(
  queueName: string,
  id: string,
  stateDir?: string,
): DeliveryQueueEntryState | null {
  const database = openStateDatabase(stateDir);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    queueDb
      .selectFrom("delivery_queue_entries")
      .select([
        "id",
        "entry_json",
        "enqueued_at",
        "retry_count",
        "last_attempt_at",
        "last_error",
        "platform_send_started_at",
        "recovery_state",
      ])
      .where("queue_name", "=", queueName)
      .where("id", "=", id)
      .where("status", "=", "pending"),
  ) as DeliveryQueueSqliteRow | undefined;
  return row ? inflateDeliveryQueueRow(row) : null;
}

/** Load a queue entry regardless of pending/failed/completed status. */
export function loadDeliveryQueueEntryAnyStatus(
  queueName: string,
  id: string,
  stateDir?: string,
): DeliveryQueueEntryState | null {
  return loadDeliveryQueueEntryInDatabase(openStateDatabase(stateDir), queueName, id);
}

/** Read row status without hiding dead-lettered entries. */
export function getDeliveryQueueEntryStatus(
  queueName: string,
  id: string,
  stateDir?: string,
): QueueStatus | undefined {
  const database = openStateDatabase(stateDir);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    queueDb
      .selectFrom("delivery_queue_entries")
      .select(["status", "entry_json", "enqueued_at", "recovery_state"])
      .where("queue_name", "=", queueName)
      .where("id", "=", id),
  ) as
    | {
        status?: QueueStatus;
        entry_json: string;
        enqueued_at: number | bigint;
        recovery_state: string | null;
      }
    | undefined;
  if (row?.status === "completed" && row.recovery_state === BOUNDED_COMPLETION_RECOVERY_STATE) {
    let retention: DeliveryQueueCompletionRetention | undefined;
    try {
      retention = (JSON.parse(row.entry_json) as DeliveryQueueEntryState).completionRetention;
    } catch {
      // An unreadable terminal receipt stays fail-closed rather than authorizing
      // a second recipient-visible send without producer ownership proof.
      return row.status;
    }
    if (
      typeof retention === "object" &&
      id.startsWith(retention.idPrefix) &&
      Number.isSafeInteger(retention.maxAgeMs) &&
      retention.maxAgeMs > 0 &&
      Number(row.enqueued_at) < Date.now() - retention.maxAgeMs
    ) {
      const expired = executeSqliteQuerySync(
        database.db,
        queueDb
          .deleteFrom("delivery_queue_entries")
          .where("queue_name", "=", queueName)
          .where("id", "=", id)
          .where("status", "=", "completed")
          .where("recovery_state", "=", BOUNDED_COMPLETION_RECOVERY_STATE)
          .where("enqueued_at", "<", Date.now() - retention.maxAgeMs),
      );
      if (expired.numAffectedRows === 1n) {
        return undefined;
      }
    }
  }
  return row?.status;
}

/** Load all pending entries for a queue namespace in database order. */
export function loadDeliveryQueueEntries(
  queueName: string,
  stateDir?: string,
): DeliveryQueueEntryState[] {
  const database = openStateDatabase(stateDir);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    queueDb
      .selectFrom("delivery_queue_entries")
      .select([
        "id",
        "entry_json",
        "enqueued_at",
        "retry_count",
        "last_attempt_at",
        "last_error",
        "platform_send_started_at",
        "recovery_state",
      ])
      .where("queue_name", "=", queueName)
      .where("status", "=", "pending")
      .orderBy("enqueued_at", "asc")
      .orderBy("id", "asc"),
  ).rows as DeliveryQueueSqliteRow[];
  return rows
    .map(inflateDeliveryQueueRow)
    .filter((entry): entry is DeliveryQueueEntryState => entry != null);
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
  const retainPermanently = current?.completionRetention === "permanent";
  const boundedRetention =
    typeof current?.completionRetention === "object" ? current.completionRetention : undefined;
  if (
    boundedRetention &&
    (!boundedRetention.idPrefix ||
      !id.startsWith(boundedRetention.idPrefix) ||
      !Number.isSafeInteger(boundedRetention.maxAgeMs) ||
      boundedRetention.maxAgeMs <= 0 ||
      !Number.isSafeInteger(boundedRetention.maxEntries) ||
      boundedRetention.maxEntries <= 0)
  ) {
    throw new Error(`Invalid bounded delivery completion retention: ${queueName}/${id}`);
  }
  const tombstone = {
    id,
    enqueuedAt: now,
    retryCount: 0,
    acknowledgedAt: now,
    ...(retainPermanently
      ? {
          completionRetention: "permanent" as const,
          recoveryState: PERMANENT_COMPLETION_RECOVERY_STATE,
        }
      : {}),
    ...(boundedRetention
      ? {
          completionRetention: boundedRetention,
          recoveryState: BOUNDED_COMPLETION_RECOVERY_STATE,
        }
      : {}),
  };
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
  // Ordinary receipts expire after thirty days. Permanent producer receipts
  // survive because their source intent can outlive any bounded retry window.
  const database = openStateDatabase(stateDir);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  const lastRetained = boundedRetention
    ? (executeSqliteQueryTakeFirstSync(
        database.db,
        queueDb
          .selectFrom("delivery_queue_entries")
          .select(["id", "enqueued_at"])
          .where("queue_name", "=", queueName)
          .where("status", "=", "completed")
          .where("recovery_state", "=", BOUNDED_COMPLETION_RECOVERY_STATE)
          .where("id", ">=", boundedRetention.idPrefix)
          .where("id", "<", `${boundedRetention.idPrefix}\uffff`)
          .orderBy("enqueued_at", "desc")
          .orderBy("id", "desc")
          .limit(1)
          .offset(boundedRetention.maxEntries - 1),
      ) as { id: string; enqueued_at: number | bigint } | undefined)
    : undefined;
  // One indexed sweep owns ordinary expiry and producer-local age/count
  // limits; pending rows, sibling prefixes, and permanent receipts survive.
  executeSqliteQuerySync(
    database.db,
    queueDb
      .deleteFrom("delivery_queue_entries")
      .where("queue_name", "=", queueName)
      .where("status", "=", "completed")
      .where((eb) =>
        eb.or([
          eb.and([
            eb("enqueued_at", "<", now - COMPLETED_TOMBSTONE_RETENTION_MS),
            eb.or([
              eb("recovery_state", "is", null),
              eb("recovery_state", "not in", [
                PERMANENT_COMPLETION_RECOVERY_STATE,
                BOUNDED_COMPLETION_RECOVERY_STATE,
              ]),
            ]),
          ]),
          ...(boundedRetention
            ? [
                eb.and([
                  eb("recovery_state", "=", BOUNDED_COMPLETION_RECOVERY_STATE),
                  eb("id", ">=", boundedRetention.idPrefix),
                  eb("id", "<", `${boundedRetention.idPrefix}\uffff`),
                  eb.or([
                    eb("enqueued_at", "<", now - boundedRetention.maxAgeMs),
                    ...(lastRetained
                      ? [
                          eb("enqueued_at", "<", Number(lastRetained.enqueued_at)),
                          eb.and([
                            eb("enqueued_at", "=", Number(lastRetained.enqueued_at)),
                            eb("id", "<", lastRetained.id),
                          ]),
                        ]
                      : []),
                  ]),
                ]),
              ]
            : []),
        ]),
      ),
  );
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
        current.platformSendAttemptId !== params.expectedPlatformSendAttemptId &&
        current.producerClaimId !== params.expectedPlatformSendAttemptId
      ) {
        throw new Error(`Stable delivery platform claim was lost: ${params.id}`);
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

/** Dead-lettered entry counts for one queue namespace. */
type FailedDeliveryQueueCount = {
  queueName: string;
  count: number;
  oldestFailedAt: number | null;
};

/** Count dead-lettered (failed) entries per queue namespace for health reporting. */
export function countFailedDeliveryQueueEntries(stateDir?: string): FailedDeliveryQueueCount[] {
  const database = openStateDatabase(stateDir);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    queueDb
      .selectFrom("delivery_queue_entries")
      .select((eb) => [
        "queue_name",
        eb.fn.countAll().as("failed_count"),
        eb.fn.min("failed_at").as("oldest_failed_at"),
      ])
      .where("status", "=", "failed")
      .groupBy("queue_name")
      .orderBy("queue_name", "asc"),
  ).rows as Array<{
    queue_name: string;
    failed_count: number | bigint;
    oldest_failed_at: number | bigint | null;
  }>;
  return rows.map((row) => ({
    queueName: row.queue_name,
    count: Number(row.failed_count),
    oldestFailedAt: row.oldest_failed_at == null ? null : Number(row.oldest_failed_at),
  }));
}

/** Mark a pending delivery queue entry as failed for later diagnostics. */
export function moveDeliveryQueueEntryToFailed(
  queueName: string,
  id: string,
  stateDir?: string,
): void {
  const current = loadDeliveryQueueEntry(queueName, id, stateDir);
  if (!current) {
    throw enoent(queueName, id);
  }
  upsertDeliveryQueueEntry({ queueName, entry: current, status: "failed", stateDir });
}

/** Atomically fail a queue row only while its pending value is unchanged. */
export function failPendingDeliveryQueueEntry(params: {
  queueName: string;
  id: string;
  expectedStatus: "pending";
  lastError: string;
  entry: DeliveryQueueEntryState;
  failedEntry?: DeliveryQueueEntryState;
  stateDir?: string;
}): FailPendingDeliveryQueueEntryResult {
  if (params.entry.id !== params.id) {
    throw new Error(`Delivery queue entry id mismatch: ${params.entry.id} != ${params.id}`);
  }
  if (params.failedEntry && params.failedEntry.id !== params.id) {
    throw new Error(
      `Failed delivery queue entry id mismatch: ${params.failedEntry.id} != ${params.id}`,
    );
  }
  const now = Date.now();
  const failedEntry = { ...(params.failedEntry ?? params.entry), lastError: params.lastError };
  const database = openStateDatabase(params.stateDir);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  const result = executeSqliteQuerySync(
    database.db,
    queueDb
      .updateTable("delivery_queue_entries")
      .set({
        status: "failed",
        last_error: params.lastError,
        entry_json: JSON.stringify(failedEntry),
        updated_at: now,
        failed_at: now,
      })
      .where("queue_name", "=", params.queueName)
      .where("id", "=", params.id)
      .where("status", "=", params.expectedStatus)
      .where("entry_json", "=", JSON.stringify(params.entry)),
  );
  return result.numAffectedRows === 1n ? { status: "failed" } : { status: "not_pending" };
}
