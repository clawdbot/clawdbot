/** Immutable decision facts for action boundaries without an owner-native record. */
import type { DatabaseSync } from "node:sqlite";
import { sql, type Selectable } from "kysely";
import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import { validateDecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { createOpenClawStateSchemaEnsurer } from "../state/openclaw-state-feature-schema.js";

type ExecutionDecisionDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "execution_decision_facts" | "execution_identity_contexts"
>;
type ExecutionDecisionRow = Selectable<OpenClawStateKyselyDatabase["execution_decision_facts"]>;
type ExecutionDecisionMetadataRow = Omit<ExecutionDecisionRow, "receipt_json"> & {
  receipt_rowid: number;
  payload_bytes: number;
  bounded_receipt_json: string | null;
};
type ExecutionDecisionFactCursor = { occurredAt: number; rowId: number };
type ExecutionDecisionFactPageEntry = {
  receipt: DecisionReceiptV1;
  selectorId: string;
};
type ExecutionDecisionFactPage = {
  entries: ExecutionDecisionFactPageEntry[];
  receipts: DecisionReceiptV1[];
  nextCursor?: ExecutionDecisionFactCursor;
};

const EXECUTION_DECISION_FACT_MAX_BYTES = 16 * 1024;
const EXECUTION_DECISION_FACT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const EXECUTION_DECISION_FACT_MAX_ROWS = 250_000;
const EXECUTION_DECISION_FACT_PRUNE_BATCH_ROWS = 1_024;
const EXECUTION_DECISION_FACT_SUMMARY_MAX_ROWS = 128;
const EXECUTION_DECISION_SELECTOR_PREFIX = "decision-fact:";

const ensureExecutionDecisionFactSchema = createOpenClawStateSchemaEnsurer({
  table: "execution_decision_facts",
  endMarker: "  ON execution_decision_facts (run_id, occurred_at, receipt_id);\n",
  operationLabel: "audit.execution-decision.schema.ensure",
});

type ExecutionDecisionFactOptions = OpenClawStateDatabaseOptions & {
  now?: number;
  limits?: { maxRows: number; pruneBatchRows: number };
};

function decisionDb(db: DatabaseSync) {
  return getNodeSqliteKysely<ExecutionDecisionDatabase>(db);
}

function parseDecisionRow(row: ExecutionDecisionRow): DecisionReceiptV1 {
  const bytes = normalizeSqliteNumber(row.receipt_bytes);
  const occurredAt = normalizeSqliteNumber(row.occurred_at);
  if (
    typeof row.receipt_json !== "string" ||
    bytes === undefined ||
    Buffer.byteLength(row.receipt_json, "utf8") !== bytes ||
    bytes > EXECUTION_DECISION_FACT_MAX_BYTES ||
    occurredAt === undefined
  ) {
    throw new Error("invalid decision fact payload bounds");
  }
  const parsed = JSON.parse(row.receipt_json) as unknown;
  if (!validateDecisionReceiptV1(parsed)) {
    throw new Error("invalid decision fact payload schema");
  }
  if (
    parsed.receiptId !== row.receipt_id ||
    parsed.contextId !== row.context_id ||
    parsed.executionId !== row.execution_id ||
    parsed.runId !== row.run_id ||
    (parsed.actionId ?? null) !== row.action_id ||
    parsed.action.family !== row.action_family ||
    parsed.decision.outcome !== row.decision_outcome ||
    parsed.decision.reasonCode !== row.reason_code ||
    parsed.enforcement.coverageState !== row.coverage_state ||
    parsed.source.owner !== row.owner ||
    parsed.source.recordRef !== row.source_ref ||
    parsed.occurredAt !== occurredAt ||
    JSON.stringify(parsed) !== row.receipt_json
  ) {
    throw new Error("decision fact payload disagrees with indexed columns");
  }
  return parsed;
}

function unknownDecisionReceipt(
  row: Omit<ExecutionDecisionRow, "receipt_json">,
  reasonCode: string,
  missingEvidence: string,
): DecisionReceiptV1 {
  return {
    schemaVersion: 1,
    receiptId: row.receipt_id,
    contextId: row.context_id,
    executionId: row.execution_id,
    runId: row.run_id,
    ...(row.action_id ? { actionId: row.action_id } : {}),
    occurredAt: normalizeSqliteNumber(row.occurred_at) ?? 0,
    action: { family: row.action_family, operation: "decision" },
    decision: { outcome: "unknown", reasonCode },
    enforcement: {
      coverageState: "unknown",
      policyRefs: [],
      grantRefs: [],
      contextFieldsUsed: [],
    },
    source: {
      owner: row.owner,
      recordRef: row.source_ref,
      decisionBoundary: "execution-decision-facts",
    },
    missingEvidence: [missingEvidence],
    remediation: [
      {
        code: "inspect_state_integrity",
        text: "Run openclaw doctor and inspect the shared state database before trusting this decision.",
      },
    ],
  };
}

type ExecutionDecisionContext = Pick<DecisionReceiptV1, "contextId" | "executionId" | "runId">;

function hasExactExecutionContext(db: DatabaseSync, context: ExecutionDecisionContext): boolean {
  if (!tableExists(db, "execution_identity_contexts")) {
    return false;
  }
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      db,
      decisionDb(db)
        .selectFrom("execution_identity_contexts")
        .select("context_id")
        .where("context_id", "=", context.contextId)
        .where("execution_id", "=", context.executionId)
        .where("run_id", "=", context.runId),
    ),
  );
}

function deleteExpiredDecisionFacts(db: DatabaseSync, now: number, limit: number) {
  const kysely = decisionDb(db);
  const expiredIds = kysely
    .selectFrom("execution_decision_facts")
    .select("receipt_id")
    .where("occurred_at", "<", now - EXECUTION_DECISION_FACT_RETENTION_MS)
    .orderBy("occurred_at", "asc")
    .orderBy("receipt_id", "asc")
    .limit(limit);
  return executeSqliteQuerySync(
    db,
    kysely.deleteFrom("execution_decision_facts").where("receipt_id", "in", expiredIds),
  );
}

function pruneDecisionFactsAfterInsert(
  db: DatabaseSync,
  now: number,
  limits: { maxRows: number; pruneBatchRows: number },
): void {
  const kysely = decisionDb(db);
  const expired = deleteExpiredDecisionFacts(db, now, limits.pruneBatchRows);
  const remaining = Math.max(0, limits.pruneBatchRows - Number(expired.numAffectedRows ?? 0n));
  if (remaining === 0) {
    return;
  }
  const retainedIds = kysely
    .selectFrom("execution_decision_facts")
    .select("receipt_id")
    .orderBy("occurred_at", "desc")
    .orderBy("receipt_id", "desc")
    .limit(limits.maxRows);
  const overflowIds = kysely
    .selectFrom("execution_decision_facts")
    .select("receipt_id")
    .where("receipt_id", "not in", retainedIds)
    .orderBy("occurred_at", "asc")
    .orderBy("receipt_id", "asc")
    .limit(remaining);
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("execution_decision_facts").where("receipt_id", "in", overflowIds),
  );
}

/** Record one immutable fact only when its action owner has no native durable record. */
export function recordExecutionDecisionFact(
  receipt: unknown,
  options: ExecutionDecisionFactOptions = {},
): "inserted" | "existing" {
  if (!validateDecisionReceiptV1(receipt)) {
    throw new Error("execution decision fact must match DecisionReceiptV1");
  }
  if (receipt.source.owner === "operator_approvals") {
    throw new Error("operator approvals must be read from their owner-native table");
  }
  const opened = openOpenClawStateDatabase(options);
  if (!hasExactExecutionContext(opened.db, receipt)) {
    throw new Error("execution decision fact requires an exact retained execution context");
  }
  const receiptJson = JSON.stringify(receipt);
  const receiptBytes = Buffer.byteLength(receiptJson, "utf8");
  if (receiptBytes > EXECUTION_DECISION_FACT_MAX_BYTES) {
    throw new Error("execution decision fact exceeds 16 KiB");
  }
  ensureExecutionDecisionFactSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = decisionDb(db);
      // The context is the authoritative tuple owner; reread it inside the commit section.
      if (!hasExactExecutionContext(db, receipt)) {
        throw new Error("execution decision fact requires an exact retained execution context");
      }
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("execution_decision_facts")
          .select(["receipt_json"])
          .where("receipt_id", "=", receipt.receiptId),
      );
      if (existing) {
        if (existing.receipt_json !== receiptJson) {
          throw new Error("execution decision fact id conflicts with retained state");
        }
        return "existing" as const;
      }
      executeSqliteQuerySync(
        db,
        kysely.insertInto("execution_decision_facts").values({
          receipt_id: receipt.receiptId,
          context_id: receipt.contextId,
          execution_id: receipt.executionId,
          run_id: receipt.runId,
          action_id: receipt.actionId ?? null,
          action_family: receipt.action.family,
          decision_outcome: receipt.decision.outcome,
          coverage_state: receipt.enforcement.coverageState,
          reason_code: receipt.decision.reasonCode,
          owner: receipt.source.owner,
          source_ref: receipt.source.recordRef,
          occurred_at: receipt.occurredAt,
          receipt_bytes: receiptBytes,
          receipt_json: receiptJson,
        }),
      );
      pruneDecisionFactsAfterInsert(
        db,
        options.now ?? Date.now(),
        options.limits ?? {
          maxRows: EXECUTION_DECISION_FACT_MAX_ROWS,
          pruneBatchRows: EXECUTION_DECISION_FACT_PRUNE_BATCH_ROWS,
        },
      );
      return "inserted" as const;
    },
    options,
    { operationLabel: "audit.execution-decision.record" },
  );
}

function retainedDecisionFactsForContextQuery(db: DatabaseSync, contextId: string, now: number) {
  return decisionDb(db)
    .selectFrom("execution_decision_facts")
    .where("context_id", "=", contextId)
    .where("occurred_at", ">=", now - EXECUTION_DECISION_FACT_RETENTION_MS);
}

function executionDecisionRowId() {
  return /* kysely-allow-raw: SQLite rowid keeps the external cursor compact while the indexed receipt id remains the query key. */ sql<number>`execution_decision_facts.rowid`;
}

function executionDecisionPayloadBytes() {
  return /* kysely-allow-raw: SQLite byte length excludes oversized retained receipt JSON before materialization. */ sql<number>`length(CAST(execution_decision_facts.receipt_json AS BLOB))`;
}

function executionDecisionBoundedPayload() {
  return /* kysely-allow-raw: one page snapshot returns bounded payload bytes beside the owning rowid. */ sql<
    string | null
  >`CASE WHEN length(CAST(execution_decision_facts.receipt_json AS BLOB)) <= ${EXECUTION_DECISION_FACT_MAX_BYTES} THEN execution_decision_facts.receipt_json ELSE NULL END`;
}

function executionDecisionSelectorId(row: ExecutionDecisionMetadataRow): string {
  const rowId = normalizeSqliteNumber(row.receipt_rowid);
  if (rowId === undefined || rowId < 1) {
    throw new Error("invalid execution decision fact rowid");
  }
  return `${EXECUTION_DECISION_SELECTOR_PREFIX}${rowId}`;
}

function retainedDecisionFactMetadata(params: {
  db: DatabaseSync;
  contextId: string;
  now: number;
  after?: ExecutionDecisionFactCursor;
  offset?: number;
  limit: number;
}): ExecutionDecisionMetadataRow[] {
  const boundary = params.after
    ? executeSqliteQueryTakeFirstSync(
        params.db,
        decisionDb(params.db)
          .selectFrom("execution_decision_facts")
          .select(["receipt_id", "occurred_at"])
          .where(executionDecisionRowId(), "=", params.after.rowId)
          .where("context_id", "=", params.contextId)
          .where("occurred_at", "=", params.after.occurredAt),
      )
    : undefined;
  if (params.after && !boundary) {
    throw new Error("execution decision cursor is no longer retained");
  }
  return executeSqliteQuerySync(
    params.db,
    retainedDecisionFactsForContextQuery(params.db, params.contextId, params.now)
      .$if(boundary !== undefined, (query) =>
        query.where((eb) =>
          eb.or([
            eb("occurred_at", ">", boundary!.occurred_at),
            eb.and([
              eb("occurred_at", "=", boundary!.occurred_at),
              eb("receipt_id", ">", boundary!.receipt_id),
            ]),
          ]),
        ),
      )
      .select([
        "receipt_id",
        "context_id",
        "execution_id",
        "run_id",
        "action_id",
        "action_family",
        "decision_outcome",
        "coverage_state",
        "reason_code",
        "owner",
        "source_ref",
        "occurred_at",
        "receipt_bytes",
      ])
      .select([
        executionDecisionRowId().as("receipt_rowid"),
        executionDecisionPayloadBytes().as("payload_bytes"),
        executionDecisionBoundedPayload().as("bounded_receipt_json"),
      ])
      .orderBy("occurred_at", "asc")
      .orderBy("receipt_id", "asc")
      .$if(params.offset !== undefined, (query) => query.offset(params.offset!))
      .limit(params.limit),
  ).rows;
}

function projectDecisionRow(
  row: ExecutionDecisionRow,
  context: ExecutionDecisionContext,
): DecisionReceiptV1 {
  try {
    const receipt = parseDecisionRow(row);
    return receipt.contextId === context.contextId &&
      receipt.executionId === context.executionId &&
      receipt.runId === context.runId
      ? receipt
      : unknownDecisionReceipt(
          row,
          "decision_fact_execution_link_mismatch",
          "decision.execution_link",
        );
  } catch {
    return unknownDecisionReceipt(row, "decision_fact_record_corrupt", "decision.fact.valid");
  }
}

function projectDecisionMetadata(
  metadata: ExecutionDecisionMetadataRow,
  context: ExecutionDecisionContext,
): DecisionReceiptV1 {
  if (metadata.payload_bytes > EXECUTION_DECISION_FACT_MAX_BYTES) {
    return unknownDecisionReceipt(
      metadata,
      "decision_fact_payload_bounded",
      "decision.fact.payload_bounded",
    );
  }
  return typeof metadata.bounded_receipt_json === "string"
    ? projectDecisionRow({ ...metadata, receipt_json: metadata.bounded_receipt_json }, context)
    : unknownDecisionReceipt(metadata, "decision_fact_record_corrupt", "decision.fact.valid");
}

/** Summarize at most 128 owner rows; the 129th makes coverage explicitly unknown. */
export function summarizeExecutionDecisionFactsForContext(params: {
  context: ExecutionDecisionContext;
  now?: number;
  database?: OpenClawStateDatabaseOptions;
}): {
  count: number;
  coverageState?: "enforced" | "unknown" | "unsupported";
  missingEvidence: string[];
} {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, "execution_decision_facts")) {
        return { count: 0, missingEvidence: [] };
      }
      const metadataRows = retainedDecisionFactMetadata({
        db,
        contextId: params.context.contextId,
        now: params.now ?? Date.now(),
        limit: EXECUTION_DECISION_FACT_SUMMARY_MAX_ROWS + 1,
      });
      const count = metadataRows.length;
      if (count === 0) {
        return { count: 0, missingEvidence: [] };
      }
      // Whole-set coverage stays conservative without parsing an unbounded
      // collection of retained JSON receipts on the Gateway event loop.
      if (count > EXECUTION_DECISION_FACT_SUMMARY_MAX_ROWS) {
        return {
          count,
          coverageState: "unknown" as const,
          missingEvidence: ["decision.fact.summary_bounded"],
        };
      }
      const receipts = metadataRows.map((metadata) =>
        projectDecisionMetadata(metadata, params.context),
      );
      const coverage = new Set(receipts.map((receipt) => receipt.enforcement.coverageState));
      return {
        count,
        ...(coverage.has("unsupported")
          ? { coverageState: "unsupported" as const }
          : coverage.has("unknown")
            ? { coverageState: "unknown" as const }
            : coverage.has("enforced")
              ? { coverageState: "enforced" as const }
              : {}),
        missingEvidence: [
          ...new Set(receipts.flatMap((receipt) => receipt.missingEvidence)),
        ].toSorted(),
      };
    }, params.database) ?? { count: 0, missingEvidence: [] }
  );
}

export function hasExecutionDecisionFactsForRun(params: {
  runId: string;
  now?: number;
  database?: OpenClawStateDatabaseOptions;
}): boolean {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, "execution_decision_facts")) {
        return false;
      }
      return Boolean(
        executeSqliteQueryTakeFirstSync(
          db,
          decisionDb(db)
            .selectFrom("execution_decision_facts")
            .select("receipt_id")
            .where("run_id", "=", params.runId)
            .where(
              "occurred_at",
              ">=",
              (params.now ?? Date.now()) - EXECUTION_DECISION_FACT_RETENTION_MS,
            )
            .limit(1),
        ),
      );
    }, params.database) ?? false
  );
}

export function pageExecutionDecisionFactsForContext(params: {
  context: ExecutionDecisionContext;
  after?: ExecutionDecisionFactCursor;
  offset?: number;
  limit: number;
  now?: number;
  database?: OpenClawStateDatabaseOptions;
}): ExecutionDecisionFactPage {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, "execution_decision_facts")) {
        return { entries: [], receipts: [] };
      }
      const metadataRows = retainedDecisionFactMetadata({
        db,
        contextId: params.context.contextId,
        now: params.now ?? Date.now(),
        after: params.after,
        offset: params.offset,
        limit: params.limit + 1,
      });
      const pageMetadata = metadataRows.slice(0, params.limit);
      const entries = pageMetadata.map((metadata) => ({
        receipt: projectDecisionMetadata(metadata, params.context),
        selectorId: executionDecisionSelectorId(metadata),
      }));
      const last = pageMetadata.at(-1);
      return {
        entries,
        receipts: entries.map((entry) => entry.receipt),
        ...(metadataRows.length > params.limit && last
          ? {
              nextCursor: {
                occurredAt: normalizeSqliteNumber(last.occurred_at) ?? 0,
                rowId: last.receipt_rowid,
              },
            }
          : {}),
      };
    }, params.database) ?? { entries: [], receipts: [] }
  );
}

/** Delete one bounded batch without creating the optional table. */
export function pruneExpiredExecutionDecisionFacts(
  params: { now?: number; database?: OpenClawStateDatabaseOptions } = {},
): number {
  const databaseOptions = params.database ?? {};
  const database = openOpenClawStateDatabase(databaseOptions);
  if (!tableExists(database.db, "execution_decision_facts")) {
    return 0;
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) =>
      Number(
        deleteExpiredDecisionFacts(
          db,
          params.now ?? Date.now(),
          EXECUTION_DECISION_FACT_PRUNE_BATCH_ROWS,
        ).numAffectedRows ?? 0n,
      ),
    { ...databaseOptions, database },
    { operationLabel: "audit.execution-decision.maintenance" },
  );
}
