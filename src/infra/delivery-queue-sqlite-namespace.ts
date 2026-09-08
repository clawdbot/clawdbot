// Owns atomic delivery-queue ownership changes across namespace versions.
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { DeliveryQueueDatabase } from "./delivery-queue-sqlite-bound.js";
import {
  completeDeliveryQueueEntryInDatabase,
  deleteDeliveryQueueEntryInDatabase,
  getDeliveryQueueEntryOwnersInDatabase,
  upsertDeliveryQueueEntryInDatabase,
  type DeliveryQueueEntryState,
} from "./delivery-queue-sqlite.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

/** Atomically publishes one staged owner only when retired namespaces do not own its id. */
export function commitStagedDeliveryQueueEntryOnceAcrossNamespaces(params: {
  queueName: string;
  conflictQueueNames: readonly string[];
  entry: DeliveryQueueEntryState;
  stagingId: string;
  stagingQueueName: string;
  stateDir?: string;
}): "created" | "existing" | "missing" {
  return runOpenClawStateWriteTransaction(
    (database) => {
      const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
      const staging = executeSqliteQueryTakeFirstSync(
        database.db,
        queueDb
          .selectFrom("delivery_queue_entries")
          .select("id")
          .where("queue_name", "=", params.stagingQueueName)
          .where("id", "=", params.stagingId)
          .where("status", "=", "pending"),
      );
      if (!staging) {
        return "missing";
      }
      const owner = getDeliveryQueueEntryOwnersInDatabase(
        database,
        [params.queueName, ...params.conflictQueueNames],
        params.entry.id,
      );
      if (owner.size > 0) {
        return "existing";
      }
      const inserted = upsertDeliveryQueueEntryInDatabase(
        {
          queueName: params.queueName,
          entry: params.entry,
          insertOnly: true,
        },
        database,
      );
      if (!inserted) {
        return "existing";
      }
      const consumed = executeSqliteQuerySync(
        database.db,
        queueDb
          .deleteFrom("delivery_queue_entries")
          .where("queue_name", "=", params.stagingQueueName)
          .where("id", "=", params.stagingId)
          .where("status", "=", "pending"),
      );
      if (consumed.numAffectedRows !== 1n) {
        throw new Error(
          `Delivery queue staging row changed during commit: ${params.stagingQueueName}/${params.stagingId}`,
        );
      }
      return "created";
    },
    {
      env: params.stateDir ? { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } : process.env,
    },
    {
      operationLabel: "commit staged stable delivery queue owner",
    },
  );
}

/** Inserts one stable owner only when no current or retired namespace owns its id. */
export function upsertDeliveryQueueEntryOnceAcrossNamespaces(params: {
  queueName: string;
  conflictQueueNames: readonly string[];
  entry: DeliveryQueueEntryState;
  stateDir?: string;
}): boolean {
  return runOpenClawStateWriteTransaction(
    (database) => {
      const owner = getDeliveryQueueEntryOwnersInDatabase(
        database,
        [params.queueName, ...params.conflictQueueNames],
        params.entry.id,
      );
      if (owner.size > 0) {
        return false;
      }
      return upsertDeliveryQueueEntryInDatabase(
        {
          queueName: params.queueName,
          entry: params.entry,
          insertOnly: true,
        },
        database,
      );
    },
    {
      env: params.stateDir ? { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } : process.env,
    },
    {
      operationLabel: "insert stable delivery queue owner",
    },
  );
}

type MovePendingDeliveryQueueEntryNamespaceParams = {
  sourceQueueName: string;
  destinationQueueName: string;
  conflictQueueNames?: readonly string[];
  expectedSourceEntry: DeliveryQueueEntryState;
  destinationEntry: DeliveryQueueEntryState;
  stagingQueueName?: string;
  stagingId?: string;
  retainSourceCompletionFence?: boolean;
  stateDir?: string;
};

/** Replaces a pending entry only while its authoritative serialized value is unchanged. */
export function replacePendingDeliveryQueueEntry(params: {
  queueName: string;
  expectedEntry: DeliveryQueueEntryState;
  replacementEntry: DeliveryQueueEntryState;
  stateDir?: string;
}): boolean {
  if (params.expectedEntry.id !== params.replacementEntry.id) {
    throw new Error(
      `Delivery queue replacement id mismatch: ${params.expectedEntry.id} != ${params.replacementEntry.id}`,
    );
  }
  return runOpenClawStateWriteTransaction(
    (database) => {
      const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
      const source = executeSqliteQueryTakeFirstSync(
        database.db,
        queueDb
          .selectFrom("delivery_queue_entries")
          .select(["entry_json", "status"])
          .where("queue_name", "=", params.queueName)
          .where("id", "=", params.expectedEntry.id),
      );
      if (
        !source ||
        source.status !== "pending" ||
        source.entry_json !== JSON.stringify(params.expectedEntry)
      ) {
        return false;
      }
      return upsertDeliveryQueueEntryInDatabase(
        {
          queueName: params.queueName,
          entry: params.replacementEntry,
          updatePendingOnly: true,
        },
        database,
      );
    },
    {
      env: params.stateDir ? { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } : process.env,
    },
    {
      operationLabel: "replace pending delivery queue entry",
    },
  );
}

/** Completes a pending entry only while its authoritative serialized value is unchanged. */
export function completePendingDeliveryQueueEntry(params: {
  queueName: string;
  expectedEntry: DeliveryQueueEntryState;
  stateDir?: string;
}): boolean {
  return runOpenClawStateWriteTransaction(
    (database) => {
      const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
      const source = executeSqliteQueryTakeFirstSync(
        database.db,
        queueDb
          .selectFrom("delivery_queue_entries")
          .select(["entry_json", "status"])
          .where("queue_name", "=", params.queueName)
          .where("id", "=", params.expectedEntry.id),
      );
      if (
        !source ||
        source.status !== "pending" ||
        source.entry_json !== JSON.stringify(params.expectedEntry)
      ) {
        return false;
      }
      completeDeliveryQueueEntryInDatabase(database, params.queueName, params.expectedEntry.id);
      return true;
    },
    {
      env: params.stateDir ? { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } : process.env,
    },
    {
      operationLabel: "complete pending delivery queue entry",
    },
  );
}

/**
 * Commits an asynchronously prepared replacement only if the authoritative
 * source row is unchanged, then removes or terminally fences the old owner.
 */
export function movePendingDeliveryQueueEntryNamespace(
  params: MovePendingDeliveryQueueEntryNamespaceParams,
): "moved" | "source-changed" | "destination-exists" | "staging-missing" {
  return runOpenClawStateWriteTransaction(
    (database) => {
      const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
      const source = executeSqliteQueryTakeFirstSync(
        database.db,
        queueDb
          .selectFrom("delivery_queue_entries")
          .select(["entry_json", "status"])
          .where("queue_name", "=", params.sourceQueueName)
          .where("id", "=", params.expectedSourceEntry.id),
      );
      if (
        !source ||
        source.status !== "pending" ||
        source.entry_json !== JSON.stringify(params.expectedSourceEntry)
      ) {
        return "source-changed";
      }
      const destination = getDeliveryQueueEntryOwnersInDatabase(
        database,
        [params.destinationQueueName, ...(params.conflictQueueNames ?? [])],
        params.destinationEntry.id,
      );
      if (destination.size > 0) {
        return "destination-exists";
      }
      if (params.stagingId && params.stagingQueueName) {
        const staging = executeSqliteQueryTakeFirstSync(
          database.db,
          queueDb
            .selectFrom("delivery_queue_entries")
            .select("id")
            .where("queue_name", "=", params.stagingQueueName)
            .where("id", "=", params.stagingId)
            .where("status", "=", "pending"),
        );
        if (!staging) {
          return "staging-missing";
        }
      }
      const inserted = upsertDeliveryQueueEntryInDatabase(
        {
          queueName: params.destinationQueueName,
          entry: params.destinationEntry,
          insertOnly: true,
        },
        database,
      );
      if (!inserted) {
        return "destination-exists";
      }
      if (params.retainSourceCompletionFence) {
        // Completion rewrites entry_json to a minimal tombstone. Never retain
        // the legacy pre-policy payload or hook context in the source fence.
        completeDeliveryQueueEntryInDatabase(
          database,
          params.sourceQueueName,
          params.expectedSourceEntry.id,
        );
      } else {
        deleteDeliveryQueueEntryInDatabase(
          database,
          params.sourceQueueName,
          params.expectedSourceEntry.id,
        );
      }
      if (params.stagingId && params.stagingQueueName) {
        deleteDeliveryQueueEntryInDatabase(database, params.stagingQueueName, params.stagingId);
      }
      return "moved";
    },
    {
      env: params.stateDir ? { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } : process.env,
    },
    {
      operationLabel: "migrate delivery queue namespace",
    },
  );
}
