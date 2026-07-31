// Owns the two bounded cross-namespace transitions required by stable outbound ids.
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  completeDeliveryQueueEntry,
  deleteDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
  type DeliveryQueueEntryState,
} from "./delivery-queue-sqlite.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

type DeliveryQueueDatabase = Pick<OpenClawStateKyselyDatabase, "delivery_queue_entries">;

function openStateDatabase(stateDir?: string) {
  return openOpenClawStateDatabase({
    env: stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env,
  });
}

function hasQueueOwner(params: {
  database: ReturnType<typeof openStateDatabase>;
  queueDb: ReturnType<typeof getNodeSqliteKysely<DeliveryQueueDatabase>>;
  queueNames: readonly string[];
  id: string;
}): boolean {
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      params.database.db,
      params.queueDb
        .selectFrom("delivery_queue_entries")
        .select("id")
        .where("queue_name", "in", [...params.queueNames])
        .where("id", "=", params.id),
    ),
  );
}

/** Atomically publishes one staged owner only when no current namespace owns its id. */
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
      if (
        hasQueueOwner({
          database,
          queueDb,
          queueNames: [params.queueName, ...params.conflictQueueNames],
          id: params.entry.id,
        })
      ) {
        return "existing";
      }
      if (
        !upsertDeliveryQueueEntry({
          queueName: params.queueName,
          entry: params.entry,
          stateDir: params.stateDir,
          insertOnly: true,
        })
      ) {
        return "existing";
      }
      deleteDeliveryQueueEntry(params.stagingQueueName, params.stagingId, params.stateDir);
      return "created";
    },
    {
      databaseLabel: "openclaw-state",
      operationLabel: "commit staged stable delivery queue owner",
    },
  );
}

/** Inserts one stable owner only when no current namespace owns its id. */
export function upsertDeliveryQueueEntryOnceAcrossNamespaces(params: {
  queueName: string;
  conflictQueueNames: readonly string[];
  entry: DeliveryQueueEntryState;
  stateDir?: string;
}): boolean {
  const database = openStateDatabase(params.stateDir);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  return runSqliteImmediateTransactionSync(
    database.db,
    () => {
      if (
        hasQueueOwner({
          database,
          queueDb,
          queueNames: [params.queueName, ...params.conflictQueueNames],
          id: params.entry.id,
        })
      ) {
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

/**
 * Publishes prepared custody and terminally fences its stable id in one commit.
 * The source row is payload-free, so interruption can suppress but never leak
 * pre-policy content or authorize a second modifier pass.
 */
export function publishDeliveryQueueEntryFromIntentFence(params: {
  fenceQueueName: string;
  destinationQueueName: string;
  conflictQueueNames: readonly string[];
  id: string;
  destinationEntry: DeliveryQueueEntryState;
  stagingQueueName?: string;
  stagingId?: string;
  stateDir?: string;
}): "created" | "existing" | "fence-missing" | "staging-missing" {
  const database = openStateDatabase(params.stateDir);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  return runSqliteImmediateTransactionSync(
    database.db,
    () => {
      const fence = executeSqliteQueryTakeFirstSync(
        database.db,
        queueDb
          .selectFrom("delivery_queue_entries")
          .select("id")
          .where("queue_name", "=", params.fenceQueueName)
          .where("id", "=", params.id)
          .where("status", "=", "pending"),
      );
      if (!fence) {
        return "fence-missing";
      }
      if (
        hasQueueOwner({
          database,
          queueDb,
          queueNames: [params.destinationQueueName, ...params.conflictQueueNames],
          id: params.id,
        })
      ) {
        return "existing";
      }
      if (params.stagingQueueName && params.stagingId) {
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
      if (
        !upsertDeliveryQueueEntry({
          queueName: params.destinationQueueName,
          entry: params.destinationEntry,
          stateDir: params.stateDir,
          insertOnly: true,
        })
      ) {
        return "existing";
      }
      // Keep a payload-free completion fence after custody moves. Otherwise a
      // short-lived canonical row could disappear and admit the stable id again.
      completeDeliveryQueueEntry(params.fenceQueueName, params.id, params.stateDir);
      if (params.stagingQueueName && params.stagingId) {
        deleteDeliveryQueueEntry(params.stagingQueueName, params.stagingId, params.stateDir);
      }
      return "created";
    },
    {
      databaseLabel: "openclaw-state",
      operationLabel: "publish prepared delivery from stable intent fence",
    },
  );
}
