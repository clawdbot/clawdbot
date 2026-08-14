// Bounded failed-delivery retention passes and complete event-loop-friendly sweeps.
import { sql } from "kysely";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  compactFailedDeliveryQueueEntryInDatabase,
  deleteDeliveryFailureRow,
  loadDeliveryFailureFullDetailCutoff,
  openDeliveryFailureDatabase,
  readDeliveryFailurePolicy,
  resolveDeliveryFailureExpiry,
  safeDeliveryQueueEntryJsonExtract,
  updateFailedDeliveryQueueEntryPolicyInDatabase,
  type DeliveryFailureMaintenanceResult,
  type DeliveryFailureRow,
} from "./delivery-queue-failures.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

export type { DeliveryFailureMaintenanceResult } from "./delivery-queue-failures.js";

type DeliveryQueueDatabase = Pick<OpenClawStateKyselyDatabase, "delivery_queue_entries">;
type FailureCursor = { updatedAt: number; queueName: string; id: string };
type MaintenancePass = {
  result: DeliveryFailureMaintenanceResult;
  nextCursor?: FailureCursor;
  complete: boolean;
};

let lastMaintenance = { runAt: 0, errors: 0 };

const emptyMaintenanceResult = (): DeliveryFailureMaintenanceResult => ({
  scanned: 0,
  compacted: 0,
  deleted: 0,
  legacyUnknown: 0,
  errors: 0,
});

function maintenanceCandidate() {
  return /* kysely-allow-raw: JSON1 excludes settled compact tombstones while retaining rows that still need lifecycle work. */ sql<boolean>`CASE
    WHEN ${safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.version")} IS NULL THEN 1
    WHEN ${safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.version")} != 1 THEN 1
    WHEN ${safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.detail")} = 'full' THEN 1
    WHEN ${safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.fence.kind")} = 'none' THEN 1
    WHEN ${safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.fence.kind")} = 'producer-bounded' THEN 1
    ELSE 0
  END = 1`;
}

function rowCursor(row: Pick<DeliveryFailureRow, "updated_at" | "queue_name" | "id">) {
  return { updatedAt: Number(row.updated_at), queueName: row.queue_name, id: row.id };
}

function compareCursor(left: FailureCursor, right: FailureCursor): number {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt - right.updatedAt;
  }
  if (left.queueName !== right.queueName) {
    return left.queueName < right.queueName ? -1 : 1;
  }
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
}

function loadMaintenanceUpperBound(
  database: OpenClawStateDatabase,
  queueName?: string,
): FailureCursor | undefined {
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  let query = queueDb
    .selectFrom("delivery_queue_entries")
    .select(["updated_at", "queue_name", "id"])
    .where("status", "=", "failed")
    .where(maintenanceCandidate());
  if (queueName) {
    query = query.where("queue_name", "=", queueName);
  }
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    query.orderBy("updated_at", "desc").orderBy("queue_name", "desc").orderBy("id", "desc"),
  ) as Pick<DeliveryFailureRow, "updated_at" | "queue_name" | "id"> | undefined;
  return row ? rowCursor(row) : undefined;
}

function loadMaintenanceRows(params: {
  database: OpenClawStateDatabase;
  batchSize: number;
  through: FailureCursor;
  cursor?: FailureCursor;
  queueName?: string;
}): DeliveryFailureRow[] {
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(params.database.db);
  let query = queueDb
    .selectFrom("delivery_queue_entries")
    .select([
      "queue_name",
      "id",
      "status",
      "retry_count",
      "recovery_state",
      "entry_json",
      "enqueued_at",
      "updated_at",
      "failed_at",
    ])
    .where("status", "=", "failed")
    .where(maintenanceCandidate())
    .where((eb) =>
      eb.or([
        eb("updated_at", "<", params.through.updatedAt),
        eb.and([
          eb("updated_at", "=", params.through.updatedAt),
          eb("queue_name", "<", params.through.queueName),
        ]),
        eb.and([
          eb("updated_at", "=", params.through.updatedAt),
          eb("queue_name", "=", params.through.queueName),
          eb("id", "<=", params.through.id),
        ]),
      ]),
    );
  if (params.queueName) {
    query = query.where("queue_name", "=", params.queueName);
  }
  if (params.cursor) {
    query = query.where((eb) =>
      eb.or([
        eb("updated_at", ">", params.cursor!.updatedAt),
        eb.and([
          eb("updated_at", "=", params.cursor!.updatedAt),
          eb("queue_name", ">", params.cursor!.queueName),
        ]),
        eb.and([
          eb("updated_at", "=", params.cursor!.updatedAt),
          eb("queue_name", "=", params.cursor!.queueName),
          eb("id", ">", params.cursor!.id),
        ]),
      ]),
    );
  }
  return executeSqliteQuerySync(
    params.database.db,
    query
      .orderBy("updated_at", "asc")
      .orderBy("queue_name", "asc")
      .orderBy("id", "asc")
      .limit(params.batchSize),
  ).rows as DeliveryFailureRow[];
}

function runMaintenancePass(params: {
  database: OpenClawStateDatabase;
  batchSize: number;
  now: number;
  through?: FailureCursor;
  cursor?: FailureCursor;
  queueName?: string;
}): MaintenancePass {
  if (!params.through) {
    return { result: emptyMaintenanceResult(), complete: true };
  }
  const rows = loadMaintenanceRows({
    database: params.database,
    batchSize: params.batchSize,
    through: params.through,
    cursor: params.cursor,
    queueName: params.queueName,
  });
  const result = { ...emptyMaintenanceResult(), scanned: rows.length };
  const fullDetailCutoffs = new Map<string, { failedAt: number; id: string } | undefined>();
  for (const row of rows) {
    try {
      const { policy, legacyUnknown, legacySessionEntry } = readDeliveryFailurePolicy(row);
      if (legacySessionEntry) {
        runSqliteImmediateTransactionSync(
          params.database.db,
          () =>
            updateFailedDeliveryQueueEntryPolicyInDatabase({
              database: params.database,
              row,
              entry: legacySessionEntry,
              policy,
              now: params.now,
            }),
          {
            databaseLabel: "openclaw-state",
            operationLabel: "classify legacy session delivery failure",
          },
        );
        continue;
      }
      if (legacyUnknown) {
        result.legacyUnknown += 1;
        if (
          runSqliteImmediateTransactionSync(
            params.database.db,
            () =>
              compactFailedDeliveryQueueEntryInDatabase({
                database: params.database,
                queueName: row.queue_name,
                id: row.id,
                expected: row,
                policy,
                now: params.now,
              }),
            {
              databaseLabel: "openclaw-state",
              operationLabel: "normalize legacy delivery failure",
            },
          )
        ) {
          result.compacted += 1;
        }
        continue;
      }
      if (policy.replay === "owner-managed" && policy.cleanup !== "complete") {
        continue;
      }
      if (!fullDetailCutoffs.has(row.queue_name)) {
        fullDetailCutoffs.set(
          row.queue_name,
          loadDeliveryFailureFullDetailCutoff(params.database, row.queue_name),
        );
      }
      const expiry = resolveDeliveryFailureExpiry({
        database: params.database,
        row,
        policy,
        now: params.now,
        fullDetailCutoff: fullDetailCutoffs.get(row.queue_name),
      });
      if (
        expiry.boundedExpired ||
        ((expiry.detailExpired || expiry.immediateTerminal) && policy.fence.kind === "none")
      ) {
        if (deleteDeliveryFailureRow(params.database, row)) {
          result.deleted += 1;
        }
        continue;
      }
      if (
        policy.detail === "full" &&
        (expiry.detailExpired || expiry.immediateTerminal) &&
        runSqliteImmediateTransactionSync(
          params.database.db,
          () =>
            compactFailedDeliveryQueueEntryInDatabase({
              database: params.database,
              queueName: row.queue_name,
              id: row.id,
              expected: row,
              policy,
              now: params.now,
            }),
          { databaseLabel: "openclaw-state", operationLabel: "retain delivery failure" },
        )
      ) {
        result.compacted += 1;
      }
    } catch {
      result.errors += 1;
    }
  }
  const nextCursor = rows.length > 0 ? rowCursor(rows.at(-1)!) : params.cursor;
  return {
    result,
    ...(nextCursor ? { nextCursor } : {}),
    complete:
      rows.length < params.batchSize ||
      (nextCursor !== undefined && compareCursor(nextCursor, params.through) >= 0),
  };
}

function addMaintenanceResult(
  aggregate: DeliveryFailureMaintenanceResult,
  result: DeliveryFailureMaintenanceResult,
): void {
  aggregate.scanned += result.scanned;
  aggregate.compacted += result.compacted;
  aggregate.deleted += result.deleted;
  aggregate.legacyUnknown += result.legacyUnknown;
  aggregate.errors += result.errors;
}

function boundedBatchSize(value: number | undefined): number {
  return Math.max(1, Math.min(value ?? 200, 500));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Completes the current actionable-row cycle using bounded passes and event-loop yields. */
export async function sweepDeliveryFailureMaintenance(params?: {
  stateDir?: string;
  batchSize?: number;
  now?: number;
  queueName?: string;
}): Promise<DeliveryFailureMaintenanceResult> {
  const database = openDeliveryFailureDatabase(params?.stateDir);
  const now = params?.now ?? Date.now();
  const batchSize = boundedBatchSize(params?.batchSize);
  const through = loadMaintenanceUpperBound(database, params?.queueName);
  const aggregate = emptyMaintenanceResult();
  let cursor: FailureCursor | undefined;
  while (true) {
    const pass = runMaintenancePass({
      database,
      batchSize,
      now,
      through,
      cursor,
      queueName: params?.queueName,
    });
    addMaintenanceResult(aggregate, pass.result);
    if (pass.complete) {
      break;
    }
    cursor = pass.nextCursor;
    await yieldToEventLoop();
  }
  lastMaintenance = { runAt: now, errors: aggregate.errors };
  return aggregate;
}

export function recordDeliveryFailureMaintenanceError(now = Date.now()): void {
  lastMaintenance = { runAt: now, errors: lastMaintenance.errors + 1 };
}

export function getDeliveryFailureMaintenanceHealth(): { runAt: number; errors: number } {
  return { ...lastMaintenance };
}
