// Stores durable delivery queue entries in SQLite.
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

// Generic durable delivery queue storage shared by session and outbound queues.
// Queue-specific wrappers own payload shape; this layer owns SQLite state.
type QueueStatus = "pending" | "failed" | "completed";
type DeliveryQueueDatabase = Pick<OpenClawStateKyselyDatabase, "delivery_queue_entries">;
const COMPLETED_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Indexed metadata extracted from queue payloads for diagnostics and recovery. */
export type DeliveryQueueRowMetadata = {
  entryKind?: string;
  sessionKey?: string;
  channel?: string;
  target?: string;
  accountId?: string;
};

/** Persisted queue entry fields common to all delivery queue payloads. */
export type DeliveryQueueEntryState = {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  acknowledgedAt?: number;
  lastAttemptAt?: number;
  lastError?: string;
  platformSendStartedAt?: number;
  recoveryState?: string;
};

type UpsertDeliveryQueueEntryParams = {
  queueName: string;
  entry: DeliveryQueueEntryState;
  metadata?: DeliveryQueueRowMetadata;
  status?: QueueStatus;
  stateDir?: string;
  insertOnly?: boolean;
  reviveFailedOrCorruptPending?: boolean;
  updatePendingOnly?: boolean;
  completeExisting?: boolean;
};

type FailPendingDeliveryQueueEntryResult = { status: "failed" } | { status: "not_pending" };

type QueueRow = {
  id: string;
  entry_json: string;
  enqueued_at: number | bigint;
  retry_count: number | bigint;
  last_attempt_at: number | bigint | null;
  last_error: string | null;
  platform_send_started_at: number | bigint | null;
  recovery_state: string | null;
};

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

function inflate(row: QueueRow): DeliveryQueueEntryState | null {
  let parsed: DeliveryQueueEntryState;
  try {
    parsed = JSON.parse(row.entry_json) as DeliveryQueueEntryState;
  } catch {
    return null;
  }
  return {
    ...parsed,
    id: row.id,
    enqueuedAt: Number(row.enqueued_at),
    retryCount: Number(row.retry_count),
    ...(row.last_attempt_at == null ? {} : { lastAttemptAt: Number(row.last_attempt_at) }),
    ...(row.last_error == null ? {} : { lastError: row.last_error }),
    ...(row.platform_send_started_at == null
      ? {}
      : { platformSendStartedAt: Number(row.platform_send_started_at) }),
    ...(row.recovery_state == null ? {} : { recoveryState: row.recovery_state }),
  };
}

function metadata(entry: DeliveryQueueEntryState): DeliveryQueueRowMetadata {
  const item = entry as DeliveryQueueEntryState & {
    kind?: string;
    sessionKey?: string;
    channel?: string;
    to?: string;
    accountId?: string;
    session?: { key?: string };
    route?: { channel?: string; to?: string; accountId?: string };
    deliveryContext?: { channel?: string; to?: string; accountId?: string };
  };
  return {
    entryKind: item.kind,
    sessionKey: item.sessionKey ?? item.session?.key,
    channel: item.channel ?? item.route?.channel ?? item.deliveryContext?.channel,
    target: item.to ?? item.route?.to ?? item.deliveryContext?.to,
    accountId: item.accountId ?? item.route?.accountId ?? item.deliveryContext?.accountId,
  };
}

function upsertDeliveryQueueEntryInDatabase(
  params: UpsertDeliveryQueueEntryParams,
  database: ReturnType<typeof openStateDatabase>,
): boolean {
  const now = Date.now();
  const status = params.status ?? "pending";
  const meta = params.metadata ?? metadata(params.entry);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  const insert = queueDb.insertInto("delivery_queue_entries").values({
    queue_name: params.queueName,
    id: params.entry.id,
    status,
    entry_kind: meta.entryKind ?? null,
    session_key: meta.sessionKey ?? null,
    channel: meta.channel ?? null,
    target: meta.target ?? null,
    account_id: meta.accountId ?? null,
    retry_count: params.entry.retryCount,
    last_attempt_at: params.entry.lastAttemptAt ?? null,
    last_error: params.entry.lastError ?? null,
    recovery_state: params.entry.recoveryState ?? null,
    platform_send_started_at: params.entry.platformSendStartedAt ?? null,
    entry_json: JSON.stringify(params.entry),
    enqueued_at: params.entry.enqueuedAt,
    updated_at: now,
    failed_at: status === "failed" ? now : null,
  });
  const query = params.insertOnly
    ? insert.onConflict((conflict) => conflict.columns(["queue_name", "id"]).doNothing())
    : insert.onConflict((conflict) => {
        const update = conflict.columns(["queue_name", "id"]).doUpdateSet({
          status: (eb) => eb.ref("excluded.status"),
          entry_kind: (eb) => eb.ref("excluded.entry_kind"),
          session_key: (eb) => eb.ref("excluded.session_key"),
          channel: (eb) => eb.ref("excluded.channel"),
          target: (eb) => eb.ref("excluded.target"),
          account_id: (eb) => eb.ref("excluded.account_id"),
          retry_count: (eb) => eb.ref("excluded.retry_count"),
          last_attempt_at: (eb) => eb.ref("excluded.last_attempt_at"),
          last_error: (eb) => eb.ref("excluded.last_error"),
          recovery_state: (eb) => eb.ref("excluded.recovery_state"),
          platform_send_started_at: (eb) => eb.ref("excluded.platform_send_started_at"),
          entry_json: (eb) => eb.ref("excluded.entry_json"),
          enqueued_at: (eb) => eb.ref("excluded.enqueued_at"),
          updated_at: (eb) => eb.ref("excluded.updated_at"),
          failed_at: (eb) => eb.ref("excluded.failed_at"),
        });
        if (!params.reviveFailedOrCorruptPending) {
          if (params.updatePendingOnly) {
            return update.where("delivery_queue_entries.status", "=", "pending");
          }
          if (params.completeExisting) {
            return update.where("delivery_queue_entries.status", "in", ["pending", "failed"]);
          }
          return update;
        }
        // Idempotent enqueue may revive an explicit failure or repair unreadable
        // pending JSON, but it must never replace valid pending/completed ownership.
        return update.where((eb) =>
          eb.or([
            eb("delivery_queue_entries.status", "=", "failed"),
            eb.and([
              eb("delivery_queue_entries.status", "=", "pending"),
              eb(eb.fn("json_valid", ["delivery_queue_entries.entry_json"]), "=", 0),
            ]),
          ]),
        );
      });
  return executeSqliteQuerySync(database.db, query).numAffectedRows === 1n;
}

/** Insert or replace a delivery queue entry under a queue namespace. */
export function upsertDeliveryQueueEntry(params: UpsertDeliveryQueueEntryParams): boolean {
  return upsertDeliveryQueueEntryInDatabase(params, openStateDatabase(params.stateDir));
}

/** Atomically publish a queue row only while its staging row still exists. */
export function commitStagedDeliveryQueueEntry(params: {
  queueName: string;
  entry: DeliveryQueueEntryState;
  metadata?: DeliveryQueueRowMetadata;
  stagingId: string;
  stagingQueueName: string;
  stateDir?: string;
}): boolean {
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
        return false;
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
        throw new Error(
          `Delivery queue entry already exists: ${params.queueName}/${params.entry.id}`,
        );
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
      return true;
    },
    {
      databaseLabel: "openclaw-state",
      operationLabel: "commit staged delivery queue entry",
    },
  );
}

/**
 * Expire abandoned staging rows and capture destination/staging ownership in
 * one write snapshot. A concurrent commit either lands before this snapshot or
 * loses its staging row and must fail closed.
 */
export function expireStagingAndLoadDeliveryQueueEntries(params: {
  expireBeforeMs: number;
  queueName: string;
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
      const selectPending = (queueName: string) =>
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
            .where("queue_name", "=", queueName)
            .where("status", "=", "pending")
            .orderBy("enqueued_at", "asc")
            .orderBy("id", "asc"),
        ).rows as QueueRow[];
      return {
        entryRows: selectPending(params.queueName),
        stagingRows: selectPending(params.stagingQueueName),
      };
    },
    {
      databaseLabel: "openclaw-state",
      operationLabel: "expire delivery queue staging entries",
    },
  );
  return {
    entries: snapshot.entryRows
      .map(inflate)
      .filter((entry): entry is DeliveryQueueEntryState => entry != null),
    stagingEntries: snapshot.stagingRows
      .map(inflate)
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
  ) as QueueRow | undefined;
  return row ? inflate(row) : null;
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
      .select("status")
      .where("queue_name", "=", queueName)
      .where("id", "=", id),
  ) as { status?: QueueStatus } | undefined;
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
  ).rows as QueueRow[];
  return rows.map(inflate).filter((entry): entry is DeliveryQueueEntryState => entry != null);
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
  const tombstone = {
    id,
    enqueuedAt: now,
    retryCount: 0,
    acknowledgedAt: now,
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
  // Thirty days covers delayed producer replays while bounding successful-row growth.
  const database = openStateDatabase(stateDir);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    queueDb
      .deleteFrom("delivery_queue_entries")
      .where("queue_name", "=", queueName)
      .where("status", "=", "completed")
      .where("enqueued_at", "<", now - COMPLETED_TOMBSTONE_RETENTION_MS),
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

/** Atomically fail a queue row only while its persisted status is still pending. */
export function failPendingDeliveryQueueEntry(params: {
  queueName: string;
  id: string;
  expectedStatus: "pending";
  lastError: string;
  entry: DeliveryQueueEntryState;
  stateDir?: string;
}): FailPendingDeliveryQueueEntryResult {
  if (params.entry.id !== params.id) {
    throw new Error(`Delivery queue entry id mismatch: ${params.entry.id} != ${params.id}`);
  }
  const now = Date.now();
  const failedEntry = { ...params.entry, lastError: params.lastError };
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
      .where("status", "=", params.expectedStatus),
  );
  return result.numAffectedRows === 1n ? { status: "failed" } : { status: "not_pending" };
}
