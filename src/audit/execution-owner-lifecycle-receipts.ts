/** Static owner-native cron/task/flow lifecycle projection for run inspection. */
import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import type {
  DecisionReceiptV1,
  ExecutionIdentityContextV1,
} from "../../packages/gateway-protocol/src/index.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableHasColumn, tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";

type OwnerLifecycleDatabase = Pick<
  OpenClawStateDatabase,
  "cron_run_receipts" | "flow_runs" | "task_runs"
>;
export type OwnerLifecycleStage = "cron" | "task" | "flow";
export type OwnerLifecycleCursor = { occurredAt: number; rowId: number };
type OwnerLifecycleDisplayProducer = "cron-lifecycle" | "task-lifecycle" | "flow-lifecycle";
type OwnerLifecycleReceiptEntry = {
  receipt: DecisionReceiptV1;
  selectorId: string;
  displayProducer: OwnerLifecycleDisplayProducer;
};
type OwnerLifecycleRow = {
  executionId: string | null;
  occurredAt: number;
  owner: "cron_run_receipts" | "task_runs" | "flow_runs";
  recordId: string;
  rowId: number;
  status: string;
};

const KNOWN_STATUSES: Record<OwnerLifecycleStage, ReadonlySet<string>> = {
  cron: new Set(["running", "ok", "error", "skipped", "interrupted", "superseded"]),
  task: new Set([
    "queued",
    "running",
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "lost",
    "blocked",
  ]),
  flow: new Set([
    "queued",
    "running",
    "waiting",
    "blocked",
    "succeeded",
    "failed",
    "cancelled",
    "lost",
  ]),
};

function hasBindingColumns(db: DatabaseSync, tableName: string): boolean {
  return (
    tableExists(db, tableName) &&
    tableHasColumn(db, tableName, "context_id") &&
    tableHasColumn(db, tableName, "execution_id")
  );
}

function ownerName(stage: OwnerLifecycleStage): OwnerLifecycleRow["owner"] {
  return stage === "cron" ? "cron_run_receipts" : stage === "task" ? "task_runs" : "flow_runs";
}

function displayProducer(stage: OwnerLifecycleStage): OwnerLifecycleDisplayProducer {
  return stage === "cron"
    ? "cron-lifecycle"
    : stage === "task"
      ? "task-lifecycle"
      : "flow-lifecycle";
}

function readRows(params: {
  db: DatabaseSync;
  stage: OwnerLifecycleStage;
  contextId: string;
  after?: OwnerLifecycleCursor;
  offset?: number;
  limit: number;
}): OwnerLifecycleRow[] {
  const owner = ownerName(params.stage);
  if (!hasBindingColumns(params.db, owner)) {
    return [];
  }
  const kysely = getNodeSqliteKysely<OwnerLifecycleDatabase>(params.db);
  if (params.stage === "cron") {
    let query = kysely
      .selectFrom("cron_run_receipts")
      .select([
        "receipt_id as recordId",
        "execution_id as executionId",
        "started_at_ms as occurredAt",
        "status",
        sql<number>`rowid`.as("rowId"),
      ])
      .where("context_id", "=", params.contextId)
      .orderBy("started_at_ms", "asc")
      .orderBy(sql`rowid`, "asc")
      .limit(params.limit);
    if (params.after) {
      query = query.where((eb) =>
        eb.or([
          eb("started_at_ms", ">", params.after!.occurredAt),
          eb.and([
            eb("started_at_ms", "=", params.after!.occurredAt),
            eb(sql<number>`rowid`, ">", params.after!.rowId),
          ]),
        ]),
      );
    } else if (params.offset) {
      query = query.offset(params.offset);
    }
    return executeSqliteQuerySync(params.db, query).rows.map((row) =>
      Object.assign(row, { owner }),
    );
  }
  if (params.stage === "task") {
    let query = kysely
      .selectFrom("task_runs")
      .select([
        "task_id as recordId",
        "execution_id as executionId",
        "created_at as occurredAt",
        "status",
        "terminal_outcome as terminalOutcome",
        sql<number>`rowid`.as("rowId"),
      ])
      .where("context_id", "=", params.contextId)
      .orderBy("created_at", "asc")
      .orderBy(sql`rowid`, "asc")
      .limit(params.limit);
    if (params.after) {
      query = query.where((eb) =>
        eb.or([
          eb("created_at", ">", params.after!.occurredAt),
          eb.and([
            eb("created_at", "=", params.after!.occurredAt),
            eb(sql<number>`rowid`, ">", params.after!.rowId),
          ]),
        ]),
      );
    } else if (params.offset) {
      query = query.offset(params.offset);
    }
    return executeSqliteQuerySync(params.db, query).rows.map((row) =>
      Object.assign(row, {
        owner,
        status: row.terminalOutcome === "blocked" ? "blocked" : row.status,
      }),
    );
  }
  let query = kysely
    .selectFrom("flow_runs")
    .select([
      "flow_id as recordId",
      "execution_id as executionId",
      "created_at as occurredAt",
      "status",
      sql<number>`rowid`.as("rowId"),
    ])
    .where("context_id", "=", params.contextId)
    .orderBy("created_at", "asc")
    .orderBy(sql`rowid`, "asc")
    .limit(params.limit);
  if (params.after) {
    query = query.where((eb) =>
      eb.or([
        eb("created_at", ">", params.after!.occurredAt),
        eb.and([
          eb("created_at", "=", params.after!.occurredAt),
          eb(sql<number>`rowid`, ">", params.after!.rowId),
        ]),
      ]),
    );
  } else if (params.offset) {
    query = query.offset(params.offset);
  }
  return executeSqliteQuerySync(params.db, query).rows.map((row) => Object.assign(row, { owner }));
}

function countRows(params: {
  db: DatabaseSync;
  stage: OwnerLifecycleStage;
  contextId: string;
  executionId?: string;
}): number {
  const owner = ownerName(params.stage);
  if (!hasBindingColumns(params.db, owner)) {
    return 0;
  }
  const kysely = getNodeSqliteKysely<OwnerLifecycleDatabase>(params.db);
  const query =
    params.stage === "cron"
      ? kysely
          .selectFrom("cron_run_receipts")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("context_id", "=", params.contextId)
          .$if(params.executionId !== undefined, (qb) =>
            qb.where("execution_id", "=", params.executionId!),
          )
      : params.stage === "task"
        ? kysely
            .selectFrom("task_runs")
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("context_id", "=", params.contextId)
            .$if(params.executionId !== undefined, (qb) =>
              qb.where("execution_id", "=", params.executionId!),
            )
        : kysely
            .selectFrom("flow_runs")
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("context_id", "=", params.contextId)
            .$if(params.executionId !== undefined, (qb) =>
              qb.where("execution_id", "=", params.executionId!),
            );
  return executeSqliteQueryTakeFirstSync(params.db, query)?.count ?? 0;
}

function projectReceipt(
  stage: OwnerLifecycleStage,
  row: OwnerLifecycleRow,
  context: ExecutionIdentityContextV1,
): DecisionReceiptV1 {
  const exact = row.executionId === context.executionId;
  const known = KNOWN_STATUSES[stage].has(row.status);
  const valid = exact && known;
  const missingEvidence = valid
    ? []
    : [exact ? `decision.${stage}_owner_status` : "decision.execution_link"];
  return {
    schemaVersion: 1,
    receiptId: `${stage}:${row.recordId}`,
    contextId: context.contextId,
    executionId: context.executionId,
    runId: context.runId,
    actionId: row.recordId,
    occurredAt: row.occurredAt,
    action: {
      family: stage === "cron" ? "scheduled-run" : stage === "task" ? "task" : "flow",
      operation: "lifecycle",
      summary: valid
        ? `${stage === "cron" ? "Scheduled run" : stage === "task" ? "Task" : "Flow"} lifecycle: ${row.status.replaceAll("_", "-")}.`
        : "Owner lifecycle evidence could not be matched exactly.",
    },
    decision: {
      outcome: valid ? "not-applicable" : "unknown",
      reasonCode: valid
        ? `${stage}_run_${row.status}`
        : exact
          ? `${stage}_run_status_unknown`
          : `${stage}_run_execution_link_mismatch`,
    },
    enforcement: {
      coverageState: valid ? "attribution-only" : "unknown",
      evaluatorRef: `${stage}-lifecycle-owner`,
      policyRefs: [],
      grantRefs: [],
      contextFieldsUsed: ["contextId", "executionId"],
    },
    source: {
      owner: row.owner,
      recordRef: row.recordId,
      decisionBoundary: `${stage}.run.lifecycle`,
    },
    missingEvidence,
    remediation: valid
      ? []
      : [
          {
            code: "inspect_owner_execution_binding",
            text: "Inspect the owner row and its exact admission binding before drawing a lifecycle conclusion.",
          },
        ],
  };
}

export function summarizeOwnerLifecycleReceipts(params: {
  stage: OwnerLifecycleStage;
  context: ExecutionIdentityContextV1;
  options: OpenClawStateDatabaseOptions;
}): { count: number; coverageState?: "attribution-only" | "unknown"; missingEvidence: string[] } {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      const count = countRows({ db, stage: params.stage, contextId: params.context.contextId });
      const exactCount = countRows({
        db,
        stage: params.stage,
        contextId: params.context.contextId,
        executionId: params.context.executionId,
      });
      const mismatch = count !== exactCount;
      return {
        count,
        ...(count > 0
          ? { coverageState: mismatch ? ("unknown" as const) : ("attribution-only" as const) }
          : {}),
        missingEvidence: mismatch ? ["decision.execution_link"] : [],
      };
    }, params.options) ?? { count: 0, missingEvidence: [] }
  );
}

export function pageOwnerLifecycleReceipts(params: {
  stage: OwnerLifecycleStage;
  context: ExecutionIdentityContextV1;
  after?: OwnerLifecycleCursor;
  offset?: number;
  limit: number;
  options: OpenClawStateDatabaseOptions;
}): { entries: OwnerLifecycleReceiptEntry[]; nextCursor?: OwnerLifecycleCursor } {
  const rows =
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) =>
        readRows({
          db,
          stage: params.stage,
          contextId: params.context.contextId,
          after: params.after,
          offset: params.offset,
          limit: params.limit + 1,
        }),
      params.options,
    ) ?? [];
  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;
  const last = page.at(-1);
  return {
    entries: page.map((row) => ({
      receipt: projectReceipt(params.stage, row, params.context),
      selectorId: `${params.stage}-lifecycle:${row.occurredAt}:${row.rowId}`,
      displayProducer: displayProducer(params.stage),
    })),
    ...(hasMore && last ? { nextCursor: { occurredAt: last.occurredAt, rowId: last.rowId } } : {}),
  };
}
