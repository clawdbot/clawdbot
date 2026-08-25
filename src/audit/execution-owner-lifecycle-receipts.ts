/** Static owner-native cron/task/flow lifecycle projection for run inspection. */
import type { DatabaseSync } from "node:sqlite";
import type {
  DecisionReceiptV1,
  ExecutionIdentityContextV1,
} from "../../packages/gateway-protocol/src/index.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE } from "./execution-owner-lifecycle-binding-store.js";

type WithSqliteRowId<Row> = Row & { rowid: number };
type OwnerLifecycleDatabase = {
  cron_run_receipts: WithSqliteRowId<OpenClawStateDatabase["cron_run_receipts"]>;
  execution_owner_lifecycle_bindings: OpenClawStateDatabase["execution_owner_lifecycle_bindings"];
  flow_runs: WithSqliteRowId<OpenClawStateDatabase["flow_runs"]>;
  task_runs: WithSqliteRowId<OpenClawStateDatabase["task_runs"]>;
};
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
const OWNER_LIFECYCLE_CURSOR_RETAINED_ERROR = "owner lifecycle cursor is no longer retained";

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

function assertRetainedCursor(params: {
  db: DatabaseSync;
  stage: OwnerLifecycleStage;
  contextId: string;
  executionId: string;
  after?: OwnerLifecycleCursor;
}): void {
  if (!params.after) {
    return;
  }
  const kysely = getNodeSqliteKysely<OwnerLifecycleDatabase>(params.db);
  const ownerQuery =
    params.stage === "cron"
      ? kysely
          .selectFrom("cron_run_receipts")
          .select("receipt_id as ownerId")
          .where("rowid", "=", params.after.rowId)
          .where("started_at_ms", "=", params.after.occurredAt)
      : params.stage === "task"
        ? kysely
            .selectFrom("task_runs")
            .select("task_id as ownerId")
            .where("rowid", "=", params.after.rowId)
            .where("created_at", "=", params.after.occurredAt)
        : kysely
            .selectFrom("flow_runs")
            .select("flow_id as ownerId")
            .where("rowid", "=", params.after.rowId)
            .where("created_at", "=", params.after.occurredAt);
  const owner = executeSqliteQueryTakeFirstSync(params.db, ownerQuery);
  // Admission binds at most one owner per lifecycle kind to an execution.
  // The exact execution match therefore rejects a different owner reusing this rowid.
  const binding = owner
    ? executeSqliteQueryTakeFirstSync(
        params.db,
        kysely
          .selectFrom(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE)
          .select("owner_id")
          .where("owner_kind", "=", params.stage)
          .where("owner_id", "=", owner.ownerId)
          .where("context_id", "=", params.contextId)
          .where("execution_id", "=", params.executionId),
      )
    : undefined;
  if (!binding) {
    throw new Error(OWNER_LIFECYCLE_CURSOR_RETAINED_ERROR);
  }
}

function readRows(params: {
  db: DatabaseSync;
  stage: OwnerLifecycleStage;
  contextId: string;
  executionId: string;
  after?: OwnerLifecycleCursor;
  offset?: number;
  limit: number;
}): OwnerLifecycleRow[] {
  const owner = ownerName(params.stage);
  if (
    !tableExists(params.db, owner) ||
    !tableExists(params.db, EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE)
  ) {
    if (params.after) {
      throw new Error(OWNER_LIFECYCLE_CURSOR_RETAINED_ERROR);
    }
    return [];
  }
  assertRetainedCursor(params);
  const kysely = getNodeSqliteKysely<OwnerLifecycleDatabase>(params.db);
  if (params.stage === "cron") {
    let query = kysely
      .selectFrom("cron_run_receipts")
      .innerJoin(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE, (join) =>
        join
          .onRef("execution_owner_lifecycle_bindings.owner_id", "=", "cron_run_receipts.receipt_id")
          .on("execution_owner_lifecycle_bindings.owner_kind", "=", "cron"),
      )
      .select([
        "cron_run_receipts.receipt_id as recordId",
        "execution_owner_lifecycle_bindings.execution_id as executionId",
        "cron_run_receipts.started_at_ms as occurredAt",
        "cron_run_receipts.status",
        "cron_run_receipts.rowid as rowId",
      ])
      .where("execution_owner_lifecycle_bindings.context_id", "=", params.contextId)
      .orderBy("cron_run_receipts.started_at_ms", "asc")
      .orderBy("cron_run_receipts.rowid", "asc")
      .limit(params.limit);
    if (params.after) {
      query = query.where((eb) =>
        eb.or([
          eb("cron_run_receipts.started_at_ms", ">", params.after!.occurredAt),
          eb.and([
            eb("cron_run_receipts.started_at_ms", "=", params.after!.occurredAt),
            eb("cron_run_receipts.rowid", ">", params.after!.rowId),
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
      .innerJoin(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE, (join) =>
        join
          .onRef("execution_owner_lifecycle_bindings.owner_id", "=", "task_runs.task_id")
          .on("execution_owner_lifecycle_bindings.owner_kind", "=", "task"),
      )
      .select([
        "task_runs.task_id as recordId",
        "execution_owner_lifecycle_bindings.execution_id as executionId",
        "task_runs.created_at as occurredAt",
        "task_runs.status",
        "task_runs.terminal_outcome as terminalOutcome",
        "task_runs.rowid as rowId",
      ])
      .where("execution_owner_lifecycle_bindings.context_id", "=", params.contextId)
      .orderBy("task_runs.created_at", "asc")
      .orderBy("task_runs.rowid", "asc")
      .limit(params.limit);
    if (params.after) {
      query = query.where((eb) =>
        eb.or([
          eb("task_runs.created_at", ">", params.after!.occurredAt),
          eb.and([
            eb("task_runs.created_at", "=", params.after!.occurredAt),
            eb("task_runs.rowid", ">", params.after!.rowId),
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
    .innerJoin(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE, (join) =>
      join
        .onRef("execution_owner_lifecycle_bindings.owner_id", "=", "flow_runs.flow_id")
        .on("execution_owner_lifecycle_bindings.owner_kind", "=", "flow"),
    )
    .select([
      "flow_runs.flow_id as recordId",
      "execution_owner_lifecycle_bindings.execution_id as executionId",
      "flow_runs.created_at as occurredAt",
      "flow_runs.status",
      "flow_runs.rowid as rowId",
    ])
    .where("execution_owner_lifecycle_bindings.context_id", "=", params.contextId)
    .orderBy("flow_runs.created_at", "asc")
    .orderBy("flow_runs.rowid", "asc")
    .limit(params.limit);
  if (params.after) {
    query = query.where((eb) =>
      eb.or([
        eb("flow_runs.created_at", ">", params.after!.occurredAt),
        eb.and([
          eb("flow_runs.created_at", "=", params.after!.occurredAt),
          eb("flow_runs.rowid", ">", params.after!.rowId),
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
  if (
    !tableExists(params.db, owner) ||
    !tableExists(params.db, EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE)
  ) {
    return 0;
  }
  const kysely = getNodeSqliteKysely<OwnerLifecycleDatabase>(params.db);
  const query =
    params.stage === "cron"
      ? kysely
          .selectFrom("cron_run_receipts")
          .innerJoin(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE, (join) =>
            join
              .onRef(
                "execution_owner_lifecycle_bindings.owner_id",
                "=",
                "cron_run_receipts.receipt_id",
              )
              .on("execution_owner_lifecycle_bindings.owner_kind", "=", "cron"),
          )
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("execution_owner_lifecycle_bindings.context_id", "=", params.contextId)
          .$if(params.executionId !== undefined, (qb) =>
            qb.where("execution_owner_lifecycle_bindings.execution_id", "=", params.executionId!),
          )
      : params.stage === "task"
        ? kysely
            .selectFrom("task_runs")
            .innerJoin(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE, (join) =>
              join
                .onRef("execution_owner_lifecycle_bindings.owner_id", "=", "task_runs.task_id")
                .on("execution_owner_lifecycle_bindings.owner_kind", "=", "task"),
            )
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("execution_owner_lifecycle_bindings.context_id", "=", params.contextId)
            .$if(params.executionId !== undefined, (qb) =>
              qb.where("execution_owner_lifecycle_bindings.execution_id", "=", params.executionId!),
            )
        : kysely
            .selectFrom("flow_runs")
            .innerJoin(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE, (join) =>
              join
                .onRef("execution_owner_lifecycle_bindings.owner_id", "=", "flow_runs.flow_id")
                .on("execution_owner_lifecycle_bindings.owner_kind", "=", "flow"),
            )
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("execution_owner_lifecycle_bindings.context_id", "=", params.contextId)
            .$if(params.executionId !== undefined, (qb) =>
              qb.where("execution_owner_lifecycle_bindings.execution_id", "=", params.executionId!),
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
  const retainedRows = withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) =>
      runSqliteDeferredTransactionSync(
        db,
        () =>
          readRows({
            db,
            stage: params.stage,
            contextId: params.context.contextId,
            executionId: params.context.executionId,
            after: params.after,
            offset: params.offset,
            limit: params.limit + 1,
          }),
        { operationLabel: "owner lifecycle receipt page" },
      ),
    params.options,
  );
  if (!retainedRows && params.after) {
    throw new Error(OWNER_LIFECYCLE_CURSOR_RETAINED_ERROR);
  }
  const rows = retainedRows ?? [];
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
