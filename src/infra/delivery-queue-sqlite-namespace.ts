// Owns atomic delivery-queue ownership changes across namespace versions.
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  completeDeliveryQueueEntry,
  deleteDeliveryQueueEntry,
  getDeliveryQueueEntryOwners,
  upsertDeliveryQueueEntry,
  type DeliveryQueueEntryState,
} from "./delivery-queue-sqlite.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

type DeliveryQueueDatabase = Pick<OpenClawStateKyselyDatabase, "delivery_queue_entries">;
type QueueStatus = "pending" | "failed" | "completed";

function openStateDatabase(stateDir?: string) {
  return openOpenClawStateDatabase({
    env: stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env,
  });
}

/** Atomically publishes one staged owner only when retired namespaces do not own its id. */
export function commitStagedDeliveryQueueEntryOnceAcrossNamespaces(params: {
  queueName: string;
  conflictQueueNames: readonly string[];
  entry: DeliveryQueueEntryState;
  stagingId: string;
  stagingQueueName: string;
  stateDir?: string;
}): "created" | "existing" | "missing" {
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
      );
      if (!staging) {
        return "missing";
      }
      const owner = getDeliveryQueueEntryOwners(
        [params.queueName, ...params.conflictQueueNames],
        params.entry.id,
        params.stateDir,
      );
      if (owner.size > 0) {
        return "existing";
      }
      const inserted = upsertDeliveryQueueEntry({
        queueName: params.queueName,
        entry: params.entry,
        stateDir: params.stateDir,
        insertOnly: true,
      });
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
      databaseLabel: "openclaw-state",
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
  const database = openStateDatabase(params.stateDir);
  return runSqliteImmediateTransactionSync(
    database.db,
    () => {
      const owner = getDeliveryQueueEntryOwners(
        [params.queueName, ...params.conflictQueueNames],
        params.entry.id,
        params.stateDir,
      );
      if (owner.size > 0) {
        return false;
      }
      return upsertDeliveryQueueEntry({
        queueName: params.queueName,
        entry: params.entry,
        stateDir: params.stateDir,
        insertOnly: true,
      });
    },
    {
      databaseLabel: "openclaw-state",
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
  const database = openStateDatabase(params.stateDir);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  return runSqliteImmediateTransactionSync(
    database.db,
    () => {
      const source = executeSqliteQueryTakeFirstSync(
        database.db,
        queueDb
          .selectFrom("delivery_queue_entries")
          .select(["entry_json", "status"])
          .where("queue_name", "=", params.queueName)
          .where("id", "=", params.expectedEntry.id),
      ) as { entry_json: string; status: QueueStatus } | undefined;
      if (
        !source ||
        source.status !== "pending" ||
        source.entry_json !== JSON.stringify(params.expectedEntry)
      ) {
        return false;
      }
      return upsertDeliveryQueueEntry({
        queueName: params.queueName,
        entry: params.replacementEntry,
        stateDir: params.stateDir,
        updatePendingOnly: true,
      });
    },
    {
      databaseLabel: "openclaw-state",
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
  const database = openStateDatabase(params.stateDir);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  return runSqliteImmediateTransactionSync(
    database.db,
    () => {
      const source = executeSqliteQueryTakeFirstSync(
        database.db,
        queueDb
          .selectFrom("delivery_queue_entries")
          .select(["entry_json", "status"])
          .where("queue_name", "=", params.queueName)
          .where("id", "=", params.expectedEntry.id),
      ) as { entry_json: string; status: QueueStatus } | undefined;
      if (
        !source ||
        source.status !== "pending" ||
        source.entry_json !== JSON.stringify(params.expectedEntry)
      ) {
        return false;
      }
      completeDeliveryQueueEntry(params.queueName, params.expectedEntry.id, params.stateDir);
      return true;
    },
    {
      databaseLabel: "openclaw-state",
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
  const database = openStateDatabase(params.stateDir);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  return runSqliteImmediateTransactionSync(
    database.db,
    () => {
      const source = executeSqliteQueryTakeFirstSync(
        database.db,
        queueDb
          .selectFrom("delivery_queue_entries")
          .select(["entry_json", "status"])
          .where("queue_name", "=", params.sourceQueueName)
          .where("id", "=", params.expectedSourceEntry.id),
      ) as { entry_json: string; status: QueueStatus } | undefined;
      if (
        !source ||
        source.status !== "pending" ||
        source.entry_json !== JSON.stringify(params.expectedSourceEntry)
      ) {
        return "source-changed";
      }
      const destination = getDeliveryQueueEntryOwners(
        [params.destinationQueueName, ...(params.conflictQueueNames ?? [])],
        params.destinationEntry.id,
        params.stateDir,
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
      const inserted = upsertDeliveryQueueEntry({
        queueName: params.destinationQueueName,
        entry: params.destinationEntry,
        stateDir: params.stateDir,
        insertOnly: true,
      });
      if (!inserted) {
        return "destination-exists";
      }
      if (params.retainSourceCompletionFence) {
        // Completion rewrites entry_json to a minimal tombstone. Never retain
        // the legacy pre-policy payload or hook context in the source fence.
        completeDeliveryQueueEntry(
          params.sourceQueueName,
          params.expectedSourceEntry.id,
          params.stateDir,
        );
      } else {
        deleteDeliveryQueueEntry(
          params.sourceQueueName,
          params.expectedSourceEntry.id,
          params.stateDir,
        );
      }
      if (params.stagingId && params.stagingQueueName) {
        deleteDeliveryQueueEntry(params.stagingQueueName, params.stagingId, params.stateDir);
      }
      return "moved";
    },
    {
      databaseLabel: "openclaw-state",
      operationLabel: "migrate delivery queue namespace",
    },
  );
}
