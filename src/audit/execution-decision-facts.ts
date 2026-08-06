/** Immutable decision facts for action boundaries without an owner-native record. */
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
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

type ExecutionDecisionDatabase = Pick<OpenClawStateKyselyDatabase, "execution_decision_facts">;
type ExecutionDecisionRow = Selectable<OpenClawStateKyselyDatabase["execution_decision_facts"]>;

const EXECUTION_DECISION_FACT_MAX_BYTES = 16 * 1024;
const EXECUTION_DECISION_FACT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const EXECUTION_DECISION_FACT_MAX_ROWS = 250_000;
const EXECUTION_DECISION_FACT_PRUNE_BATCH_ROWS = 1_024;

const ensuredDatabases = new WeakSet<DatabaseSync>();

// Keep this feature-local DDL byte-for-byte aligned with the canonical schema.
const EXECUTION_DECISION_FACT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS execution_decision_facts (
  receipt_id TEXT NOT NULL PRIMARY KEY CHECK (length(receipt_id) BETWEEN 1 AND 256),
  context_id TEXT NOT NULL CHECK (length(context_id) BETWEEN 1 AND 256),
  execution_id TEXT NOT NULL CHECK (length(execution_id) BETWEEN 1 AND 256),
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 256),
  action_id TEXT CHECK (action_id IS NULL OR length(action_id) BETWEEN 1 AND 256),
  action_family TEXT NOT NULL CHECK (length(action_family) BETWEEN 1 AND 256),
  decision_outcome TEXT NOT NULL CHECK (
    decision_outcome IN ('allowed', 'denied', 'not-applicable', 'unknown')
  ),
  coverage_state TEXT NOT NULL CHECK (
    coverage_state IN ('enforced', 'attribution-only', 'unattributed', 'unknown', 'unsupported')
  ),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 256),
  owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 256),
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 256),
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  receipt_bytes INTEGER NOT NULL CHECK (receipt_bytes BETWEEN 1 AND 16384),
  receipt_json TEXT NOT NULL CHECK (length(receipt_json) > 0),
  UNIQUE (occurred_at, receipt_id)
) STRICT;
CREATE INDEX IF NOT EXISTS execution_decision_facts_context_occurred_idx
  ON execution_decision_facts (context_id, occurred_at, receipt_id);
CREATE INDEX IF NOT EXISTS execution_decision_facts_run_occurred_idx
  ON execution_decision_facts (run_id, occurred_at, receipt_id);
`;

type ExecutionDecisionFactOptions = OpenClawStateDatabaseOptions & {
  now?: number;
  limits?: { maxRows: number; pruneBatchRows: number };
};

function decisionDb(db: DatabaseSync) {
  return getNodeSqliteKysely<ExecutionDecisionDatabase>(db);
}

function ensureExecutionDecisionFactSchema(options: OpenClawStateDatabaseOptions = {}): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- feature-local additive schema DDL; fact rows use Kysely.
      db.exec(EXECUTION_DECISION_FACT_SCHEMA_SQL);
    },
    options,
    { operationLabel: "audit.execution-decision.schema.ensure" },
  );
  ensuredDatabases.add(database.db);
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

function corruptDecisionReceipt(row: ExecutionDecisionRow): DecisionReceiptV1 {
  return {
    schemaVersion: 1,
    receiptId: row.receipt_id,
    contextId: row.context_id,
    executionId: row.execution_id,
    runId: row.run_id,
    ...(row.action_id ? { actionId: row.action_id } : {}),
    occurredAt: normalizeSqliteNumber(row.occurred_at) ?? 0,
    action: { family: row.action_family, operation: "decision" },
    decision: { outcome: "unknown", reasonCode: "decision_fact_record_corrupt" },
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
    missingEvidence: ["decision.fact.valid"],
    remediation: [
      {
        code: "inspect_state_integrity",
        text: "Run openclaw doctor and inspect the shared state database before trusting this decision.",
      },
    ],
  };
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
  const receiptJson = JSON.stringify(receipt);
  const receiptBytes = Buffer.byteLength(receiptJson, "utf8");
  if (receiptBytes > EXECUTION_DECISION_FACT_MAX_BYTES) {
    throw new Error("execution decision fact exceeds 16 KiB");
  }
  ensureExecutionDecisionFactSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = decisionDb(db);
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

export function countExecutionDecisionFactsForContext(params: {
  contextId: string;
  now?: number;
  database?: OpenClawStateDatabaseOptions;
}): number {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, "execution_decision_facts")) {
        return 0;
      }
      const row = executeSqliteQueryTakeFirstSync(
        db,
        decisionDb(db)
          .selectFrom("execution_decision_facts")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("context_id", "=", params.contextId)
          .where(
            "occurred_at",
            ">=",
            (params.now ?? Date.now()) - EXECUTION_DECISION_FACT_RETENTION_MS,
          ),
      );
      return row ? (normalizeSqliteNumber(row.count) ?? 0) : 0;
    }, params.database) ?? 0
  );
}

export function countExecutionDecisionFactsForRun(params: {
  runId: string;
  now?: number;
  database?: OpenClawStateDatabaseOptions;
}): number {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, "execution_decision_facts")) {
        return 0;
      }
      const row = executeSqliteQueryTakeFirstSync(
        db,
        decisionDb(db)
          .selectFrom("execution_decision_facts")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("run_id", "=", params.runId)
          .where(
            "occurred_at",
            ">=",
            (params.now ?? Date.now()) - EXECUTION_DECISION_FACT_RETENTION_MS,
          ),
      );
      return row ? (normalizeSqliteNumber(row.count) ?? 0) : 0;
    }, params.database) ?? 0
  );
}

export function listExecutionDecisionFactsForContext(params: {
  contextId: string;
  offset: number;
  limit: number;
  now?: number;
  database?: OpenClawStateDatabaseOptions;
}): DecisionReceiptV1[] {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, "execution_decision_facts")) {
        return [];
      }
      const rows = executeSqliteQuerySync(
        db,
        decisionDb(db)
          .selectFrom("execution_decision_facts")
          .selectAll()
          .where("context_id", "=", params.contextId)
          .where(
            "occurred_at",
            ">=",
            (params.now ?? Date.now()) - EXECUTION_DECISION_FACT_RETENTION_MS,
          )
          .orderBy("occurred_at", "asc")
          .orderBy("receipt_id", "asc")
          .offset(params.offset)
          .limit(params.limit),
      ).rows;
      return rows.map((row) => {
        try {
          return parseDecisionRow(row);
        } catch {
          return corruptDecisionReceipt(row);
        }
      });
    }, params.database) ?? []
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
