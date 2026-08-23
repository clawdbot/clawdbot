// Database-bound delivery queue serialization and mutations used by shared transactions.
import type { Insertable } from "kysely";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { DeliveryQueueEntryState } from "./delivery-queue-sqlite.types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

type QueueStatus = "pending" | "failed" | "completed";
type DeliveryQueueTable = OpenClawStateKyselyDatabase["delivery_queue_entries"];

export type DeliveryQueueDatabase = Pick<OpenClawStateKyselyDatabase, "delivery_queue_entries">;

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

export type DeliveryQueueRowMetadata = {
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
  reviveFailedOrCorruptPending?: boolean;
  updatePendingOnly?: boolean;
  completeExisting?: boolean;
};

type BoundDeliveryQueueEntry = {
  row: Insertable<DeliveryQueueTable>;
  insertOnly: boolean;
  reviveFailedOrCorruptPending: boolean;
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

function metadata(queueName: string, entry: DeliveryQueueEntryState): DeliveryQueueRowMetadata {
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
  const meta = params.metadata ?? metadata(params.queueName, params.entry);
  return {
    insertOnly: params.insertOnly === true,
    reviveFailedOrCorruptPending: params.reviveFailedOrCorruptPending === true,
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
        if (!bound.reviveFailedOrCorruptPending) {
          if (bound.updatePendingOnly) {
            return update.where("delivery_queue_entries.status", "=", "pending");
          }
          if (bound.completeExisting) {
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

/** Reads one row from the exact supplied handle for cross-owner invariant validation. */
export function loadDeliveryQueueEntryInDatabase(
  database: OpenClawStateDatabase,
  queueName: string,
  id: string,
): DeliveryQueueEntryState | null {
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
      .where("id", "=", id),
  ) as DeliveryQueueSqliteRow | undefined;
  return row ? inflateDeliveryQueueRow(row) : null;
}
