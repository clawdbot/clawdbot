// Database-bound delivery queue serialization and mutations used by shared transactions.
import type { DatabaseSync } from "node:sqlite";
import type { Insertable } from "kysely";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type { DeliveryQueueEntryState } from "./delivery-queue-sqlite.types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "./sqlite-number.js";

type QueueStatus = "pending" | "failed" | "completed";
export type DeliveryQueueReadMode = "pending" | "unfinished" | "all";
type DeliveryQueueTable = OpenClawStateKyselyDatabase["delivery_queue_entries"];
const COMPLETED_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const BOUNDED_DELIVERY_RECEIPTS_SQL = `
  SELECT * FROM (
    SELECT rowid receipt_rowid, queue_name, id, enqueued_at,
      json_extract(entry_json, '$.completionRetention.idPrefix') id_prefix,
      json_extract(entry_json, '$.completionRetention.maxAgeMs') max_age_ms,
      json_extract(entry_json, '$.completionRetention.maxEntries') max_entries
    FROM delivery_queue_entries WHERE status IN ('completed', 'failed')
      AND recovery_state = 'completed_bounded' AND json_valid(entry_json)
       AND json_type(entry_json, '$.completionRetention') = 'object'
  )
  WHERE typeof(id_prefix) = 'text' AND id_prefix <> ''
    AND substr(id, 1, length(id_prefix)) = id_prefix
    AND typeof(max_age_ms) = 'integer' AND max_age_ms BETWEEN 1 AND 9007199254740991
    AND typeof(max_entries) = 'integer' AND max_entries BETWEEN 1 AND 9007199254740991`;

export type DeliveryQueueDatabase = Pick<OpenClawStateKyselyDatabase, "delivery_queue_entries">;
const deliveryQueueRowColumns = [
  "id",
  "entry_json",
  "enqueued_at",
  "retry_count",
  "last_attempt_at",
  "last_error",
  "platform_send_started_at",
  "recovery_state",
] as const;

export type DeliveryQueueSqliteRow = {
  id: string;
  entry_json: string;
  enqueued_at: number | bigint;
  retry_count: number | bigint;
  last_attempt_at: number | bigint | null;
  last_error: string | null;
  platform_send_started_at: number | bigint | null;
  recovery_state: string | null;
};

type DeliveryQueueRowMetadata = {
  entryKind?: string;
  sessionKey?: string;
  channel?: string;
  target?: string;
  accountId?: string;
};

export type UpsertDeliveryQueueEntryParams = {
  queueName: string;
  entry: DeliveryQueueEntryState;
  metadata?: DeliveryQueueRowMetadata;
  status?: QueueStatus;
  stateDir?: string;
  insertOnly?: boolean;
  updatePendingOnly?: boolean;
  completeExisting?: boolean;
};

/** Prunes bounded receipts globally or for one exact producer namespace. */
export function pruneDeliveryQueueTombstones(
  db: DatabaseSync,
  now: number,
  prefix?: { queueName: string; idPrefix: string },
): void {
  // sqlite-allow-raw: JSON1 and a window rank enforce authored policies in place.
  db.prepare(`WITH policies AS (
      ${BOUNDED_DELIVERY_RECEIPTS_SQL}
      AND (@queueName IS NULL OR (queue_name = @queueName AND id_prefix = @idPrefix))
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY queue_name, id_prefix
        ORDER BY enqueued_at DESC, id DESC) retention_rank FROM policies
    ) DELETE FROM delivery_queue_entries WHERE rowid IN (
      SELECT receipt_rowid FROM ranked
      WHERE enqueued_at < @now - max_age_ms OR retention_rank > max_entries
    )`).run({
    now,
    queueName: prefix?.queueName ?? null,
    idPrefix: prefix?.idPrefix ?? null,
  });
  if (!prefix) {
    pruneOrdinaryDeliveryReceipts(db, now);
  }
}

/** Cheap maintenance cleanup: age predicates only, with no window sort. */
export function pruneDeliveryQueueTombstoneAges(db: DatabaseSync, now: number): void {
  // sqlite-allow-raw: JSON1 reads the compact authored age policy in place.
  db.prepare(`DELETE FROM delivery_queue_entries WHERE rowid IN (
    SELECT receipt_rowid FROM (${BOUNDED_DELIVERY_RECEIPTS_SQL})
    WHERE enqueued_at < @now - max_age_ms)`).run({ now });
  pruneOrdinaryDeliveryReceipts(db, now);
}

/** CAS-compacts one exact row, or deletes it when no fence is authored. */
export function terminalizeBoundDeliveryQueueEntry(
  db: DatabaseSync,
  queueName: string,
  id: string,
  expectedJson: string,
  failedEntry: DeliveryQueueEntryState | undefined,
  now: number,
  expectedStatus: "pending" | "failed" = "pending",
): boolean {
  if (!failedEntry) {
    return (
      // sqlite-allow-raw: Exact JSON CAS keeps deletion atomic on the caller's transaction.
      db
        .prepare(
          `DELETE FROM delivery_queue_entries
          WHERE queue_name = ? AND id = ? AND status = ? AND entry_json = ?`,
        )
        .run(queueName, id, expectedStatus, expectedJson).changes === 1
    );
  }
  return (
    // sqlite-allow-raw: Exact JSON CAS keeps compaction atomic on the caller's transaction.
    db
      .prepare(
        `UPDATE delivery_queue_entries SET status = 'failed', entry_kind = NULL,
        session_key = NULL, channel = NULL, target = NULL, account_id = NULL,
        last_attempt_at = NULL, last_error = NULL, platform_send_started_at = NULL,
        recovery_state = ?, entry_json = ?, enqueued_at = ?, updated_at = ?, failed_at = ?
      WHERE queue_name = ? AND id = ? AND status = ? AND entry_json = ?`,
      )
      .run(
        failedEntry.recoveryState ?? null,
        JSON.stringify(failedEntry),
        now,
        now,
        now,
        queueName,
        id,
        expectedStatus,
        expectedJson,
      ).changes === 1
  );
}

function pruneOrdinaryDeliveryReceipts(db: DatabaseSync, now: number): void {
  // sqlite-allow-raw: This bounded age delete runs on the caller's existing database handle.
  db.prepare(`DELETE FROM delivery_queue_entries WHERE status = 'completed'
    AND enqueued_at < ? AND (recovery_state IS NULL OR recovery_state NOT IN (
      'completed_permanent', 'completed_bounded'
    ))`).run(now - COMPLETED_TOMBSTONE_RETENTION_MS);
}

type BoundDeliveryQueueEntry = {
  row: Insertable<DeliveryQueueTable>;
  insertOnly: boolean;
  updatePendingOnly: boolean;
  completeExisting: boolean;
};

export function inflateDeliveryQueueRow(
  row: DeliveryQueueSqliteRow,
): DeliveryQueueEntryState | null {
  let parsed: DeliveryQueueEntryState;
  try {
    parsed = JSON.parse(row.entry_json) as DeliveryQueueEntryState;
  } catch {
    return null;
  }
  return {
    ...parsed,
    id: row.id,
    enqueuedAt: sqliteNumber(row.enqueued_at),
    retryCount: sqliteNumber(row.retry_count),
    ...(row.last_attempt_at == null ? {} : { lastAttemptAt: sqliteNumber(row.last_attempt_at) }),
    ...(row.last_error == null ? {} : { lastError: row.last_error }),
    ...(row.platform_send_started_at == null
      ? {}
      : { platformSendStartedAt: sqliteNumber(row.platform_send_started_at) }),
    ...(row.recovery_state == null ? {} : { recoveryState: row.recovery_state }),
  };
}

export function deliveryQueueMetadata(
  queueName: string,
  entry: DeliveryQueueEntryState | Record<string, unknown>,
): DeliveryQueueRowMetadata {
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
    entryKind: item.kind ?? queueName,
    sessionKey: item.sessionKey ?? item.session?.key,
    channel: item.channel ?? item.route?.channel ?? item.deliveryContext?.channel,
    target: item.to ?? item.route?.to ?? item.deliveryContext?.to,
    accountId: item.accountId ?? item.route?.accountId ?? item.deliveryContext?.accountId,
  };
}

/** Canonically serializes a queue row before a transaction acquires the write lock. */
export function bindDeliveryQueueEntry(
  params: UpsertDeliveryQueueEntryParams,
  now = Date.now(),
): BoundDeliveryQueueEntry {
  const status = params.status ?? "pending";
  const meta = params.metadata ?? deliveryQueueMetadata(params.queueName, params.entry);
  return {
    insertOnly: params.insertOnly === true,
    updatePendingOnly: params.updatePendingOnly === true,
    completeExisting: params.completeExisting === true,
    row: {
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
    },
  };
}

/** Mutates only the exact supplied shared-state handle; never opens or hardens a file. */
export function upsertBoundDeliveryQueueEntryInDatabase(
  bound: BoundDeliveryQueueEntry,
  database: OpenClawStateDatabase,
): boolean {
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  const insert = queueDb.insertInto("delivery_queue_entries").values(bound.row);
  const query = bound.insertOnly
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
        if (bound.updatePendingOnly) {
          return update.where("delivery_queue_entries.status", "=", "pending");
        }
        return bound.completeExisting
          ? update.where("delivery_queue_entries.status", "in", ["pending", "failed"])
          : update;
      });
  return executeSqliteQuerySync(database.db, query).numAffectedRows === 1n;
}

/** Recovery and media custody share the same inventory of unfinished work. */
export function deliveryQueueEntriesQuery(
  database: OpenClawStateDatabase,
  queueNames: readonly string[],
  mode: DeliveryQueueReadMode,
) {
  const query = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db)
    .selectFrom("delivery_queue_entries")
    .select(deliveryQueueRowColumns)
    .where("queue_name", "in", queueNames);
  return mode === "all"
    ? query
    : query.where((eb) =>
        mode === "pending"
          ? eb("status", "=", "pending")
          : eb.or([
              eb("status", "=", "pending"),
              eb.and([
                eb("status", "=", "failed"),
                eb("recovery_state", "=", "settlement_pending"),
              ]),
            ]),
      );
}

/** Reads one row from the exact supplied handle for cross-owner invariant validation. */
export function loadDeliveryQueueEntryInDatabase(
  database: OpenClawStateDatabase,
  queueName: string,
  id: string,
  mode: DeliveryQueueReadMode = "all",
): DeliveryQueueEntryState | null {
  const query = deliveryQueueEntriesQuery(database, [queueName], mode).where("id", "=", id);
  const row = executeSqliteQueryTakeFirstSync(database.db, query) as
    | DeliveryQueueSqliteRow
    | undefined;
  return row ? inflateDeliveryQueueRow(row) : null;
}
