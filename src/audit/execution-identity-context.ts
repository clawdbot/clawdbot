/** Immutable execution identity context storage and run-admission projection. */
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import type {
  AuditRunInspectResult,
  ExecutionIdentityContextV1,
} from "../../packages/gateway-protocol/src/index.js";
import { validateExecutionIdentityContextV1 } from "../../packages/gateway-protocol/src/index.js";
import { hasOperatorApprovalReceiptsForRun } from "../gateway/operator-approval-store.js";
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
import { clearAuditIdentityKeyCacheForDatabase } from "./audit-identity.js";
import { hasExecutionDecisionFactsForRun } from "./execution-decision-facts.js";
import { presentExecutionDecisionReceipts } from "./execution-decision-receipts.js";
import {
  parseExecutionIdentityAdmissionEnvelope,
  parseExecutionIdentityAdmissionWork,
  type ExecutionIdentityAdmissionToken,
} from "./execution-identity-admission.js";
import {
  buildExecutionIdentityContext,
  ensureBoundedExecutionIdentityRef,
  freezeExecutionIdentityContext,
} from "./execution-identity-context-build.js";

type ExecutionIdentityDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "audit_events" | "execution_identity_contexts"
>;
type ExecutionIdentityRow = Selectable<OpenClawStateKyselyDatabase["execution_identity_contexts"]>;

const EXECUTION_IDENTITY_CONTEXT_MAX_BYTES = 16 * 1024;
const EXECUTION_IDENTITY_CONTEXT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const EXECUTION_IDENTITY_CONTEXT_MAX_ROWS = 100_000;
const EXECUTION_IDENTITY_CONTEXT_PRUNE_BATCH_ROWS = 1_024;
const EXECUTION_IDENTITY_HMAC_REF_RE = /^hmac-sha256:v1:[a-f0-9]{32}:[a-f0-9]{64}$/u;

const ensuredDatabases = new WeakSet<DatabaseSync>();

// Keep this feature-local DDL byte-for-byte aligned with the canonical schema.
const EXECUTION_IDENTITY_CONTEXT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS execution_identity_contexts (
  context_id TEXT NOT NULL PRIMARY KEY CHECK (length(context_id) BETWEEN 1 AND 256),
  execution_id TEXT NOT NULL UNIQUE CHECK (length(execution_id) BETWEEN 1 AND 256),
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 256),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  coverage_state TEXT NOT NULL CHECK (
    coverage_state IN ('attribution-only', 'unattributed', 'unknown', 'unsupported')
  ),
  context_bytes INTEGER NOT NULL CHECK (context_bytes BETWEEN 1 AND 16384),
  context_json TEXT NOT NULL CHECK (length(context_json) > 0),
  UNIQUE (created_at, context_id)
) STRICT;
CREATE INDEX IF NOT EXISTS execution_identity_contexts_run_created_idx
  ON execution_identity_contexts (run_id, created_at, execution_id);
`;

type ExecutionIdentityStoreOptions = OpenClawStateDatabaseOptions & {
  now?: number;
  limits?: {
    maxRows: number;
    pruneBatchRows: number;
  };
};

type ExecutionIdentityReadOptions = OpenClawStateDatabaseOptions & {
  now?: number;
};

type ExecutionIdentityContextReadResult =
  | { status: "found"; context: ExecutionIdentityContextV1 }
  | { status: "expired"; runId: string }
  | { status: "missing" }
  | { status: "corrupt"; runId: string; reasonCode: "identity_context_corrupt" };

function executionIdentityDb(db: DatabaseSync) {
  return getNodeSqliteKysely<ExecutionIdentityDatabase>(db);
}

function ensureExecutionIdentityContextSchema(options: OpenClawStateDatabaseOptions = {}): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- feature-local additive schema DDL; context rows use Kysely.
      db.exec(EXECUTION_IDENTITY_CONTEXT_SCHEMA_SQL);
    },
    options,
    { operationLabel: "audit.execution-identity.schema.ensure" },
  );
  ensuredDatabases.add(database.db);
}

function parseExecutionIdentityRow(row: ExecutionIdentityRow): ExecutionIdentityContextV1 {
  if (
    typeof row.context_json !== "string" ||
    Buffer.byteLength(row.context_json, "utf8") !== normalizeSqliteNumber(row.context_bytes) ||
    Buffer.byteLength(row.context_json, "utf8") > EXECUTION_IDENTITY_CONTEXT_MAX_BYTES
  ) {
    throw new Error("invalid context payload bounds");
  }
  const parsed = JSON.parse(row.context_json) as unknown;
  if (!validateExecutionIdentityContextV1(parsed)) {
    throw new Error("invalid context payload schema");
  }
  if (
    parsed.contextId !== row.context_id ||
    parsed.executionId !== row.execution_id ||
    parsed.runId !== row.run_id ||
    parsed.createdAt !== normalizeSqliteNumber(row.created_at) ||
    parsed.coverageState !== row.coverage_state ||
    JSON.stringify(parsed) !== row.context_json ||
    !EXECUTION_IDENTITY_HMAC_REF_RE.test(parsed.trustDomain.domainRef) ||
    !EXECUTION_IDENTITY_HMAC_REF_RE.test(parsed.runtimeInstance.runtimeRef)
  ) {
    throw new Error("context payload disagrees with indexed columns");
  }
  return freezeExecutionIdentityContext(parsed);
}

function readRowByExecutionId(
  db: DatabaseSync,
  executionId: string,
): ExecutionIdentityRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    executionIdentityDb(db)
      .selectFrom("execution_identity_contexts")
      .selectAll()
      .where("execution_id", "=", executionId),
  );
}

function readRowsByRunId(
  db: DatabaseSync,
  runId: string,
  now: number,
  offset: number,
  limit: number,
): ExecutionIdentityRow[] {
  return executeSqliteQuerySync(
    db,
    executionIdentityDb(db)
      .selectFrom("execution_identity_contexts")
      .selectAll()
      .where("run_id", "=", runId)
      .where("created_at", ">=", now - EXECUTION_IDENTITY_CONTEXT_RETENTION_MS)
      .orderBy("created_at", "asc")
      .orderBy("execution_id", "asc")
      .offset(offset)
      .limit(limit),
  ).rows;
}

function deleteExpiredExecutionIdentityContexts(db: DatabaseSync, now: number, limit: number) {
  const kysely = executionIdentityDb(db);
  const expiredIds = kysely
    .selectFrom("execution_identity_contexts")
    .select("context_id")
    .where("created_at", "<", now - EXECUTION_IDENTITY_CONTEXT_RETENTION_MS)
    .orderBy("created_at", "asc")
    .orderBy("context_id", "asc")
    .limit(limit);
  return executeSqliteQuerySync(
    db,
    kysely.deleteFrom("execution_identity_contexts").where("context_id", "in", expiredIds),
  );
}

function pruneExecutionIdentityContextsAfterInsert(
  db: DatabaseSync,
  now: number,
  limits: { maxRows: number; pruneBatchRows: number },
): void {
  const kysely = executionIdentityDb(db);
  const expired = deleteExpiredExecutionIdentityContexts(db, now, limits.pruneBatchRows);
  const expiredCount = Number(expired.numAffectedRows ?? 0n);
  const remainingPruneBudget = Math.max(0, limits.pruneBatchRows - expiredCount);
  if (remainingPruneBudget > 0) {
    // Derive overflow from committed rows inside this transaction. A process-local
    // count misses writes from the Gateway worker or a concurrent direct CLI.
    const retainedIds = kysely
      .selectFrom("execution_identity_contexts")
      .select("context_id")
      .orderBy("created_at", "desc")
      .orderBy("context_id", "desc")
      .limit(limits.maxRows);
    const oldestOverflowIds = kysely
      .selectFrom("execution_identity_contexts")
      .select("context_id")
      .where("context_id", "not in", retainedIds)
      .orderBy("created_at", "asc")
      .orderBy("context_id", "asc")
      .limit(remainingPruneBudget);
    executeSqliteQuerySync(
      db,
      kysely.deleteFrom("execution_identity_contexts").where("context_id", "in", oldestOverflowIds),
    );
  }
}

/** Delete one bounded batch during the existing audit startup/hourly maintenance tick. */
export function pruneExpiredExecutionIdentityContexts(
  params: {
    now?: number;
    database?: OpenClawStateDatabaseOptions;
  } = {},
): number {
  const databaseOptions = params.database ?? {};
  const database = openOpenClawStateDatabase(databaseOptions);
  // Maintenance must not create opt-in storage. First capture owns schema creation;
  // once the table exists, cleanup remains active even after collection is disabled.
  if (!tableExists(database.db, "execution_identity_contexts")) {
    return 0;
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const deleted = deleteExpiredExecutionIdentityContexts(
        db,
        params.now ?? Date.now(),
        EXECUTION_IDENTITY_CONTEXT_PRUNE_BATCH_ROWS,
      );
      return Number(deleted.numAffectedRows ?? 0n);
    },
    { ...databaseOptions, database },
    { operationLabel: "audit.execution-identity.context.maintenance" },
  );
}

/** Worker-owned canonicalization and persistence for one accepted admission envelope. */
function persistExecutionIdentityAdmissionEnvelope(
  input: unknown,
  options: ExecutionIdentityStoreOptions = {},
): ExecutionIdentityContextV1 {
  // Structured clone removes the admission-side freeze. Revalidate all bounds
  // before schema/key access so malformed messages never reach persistence.
  const envelope = parseExecutionIdentityAdmissionEnvelope(input);
  ensureExecutionIdentityContextSchema(options);
  const executionId = envelope.executionId;
  const opened = openOpenClawStateDatabase(options);
  // HMAC lookup/key creation and canonical serialization finish before BEGIN.
  // The transaction only rereads the authoritative row and synchronously commits.
  const plannedContext = buildExecutionIdentityContext(opened.db, envelope, {
    contextId: envelope.contextId,
    createdAt: envelope.createdAt,
  });
  const plannedContextJson = JSON.stringify(plannedContext);
  let transactionDatabase: DatabaseSync | undefined;
  try {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        transactionDatabase = db;
        const existing = readRowByExecutionId(db, executionId);
        if (existing) {
          const context = parseExecutionIdentityRow(existing);
          // Full canonical bytes, including the captured ID and timestamp, own replay identity.
          // Never rewrite a newly captured envelope to resemble the retained execution context.
          if (plannedContextJson !== existing.context_json) {
            throw new Error("execution identity context conflict for execution");
          }
          return context;
        }
        executeSqliteQuerySync(
          db,
          executionIdentityDb(db)
            .insertInto("execution_identity_contexts")
            .values({
              context_id: plannedContext.contextId,
              execution_id: plannedContext.executionId,
              run_id: plannedContext.runId,
              created_at: plannedContext.createdAt,
              coverage_state: plannedContext.coverageState,
              context_bytes: Buffer.byteLength(plannedContextJson, "utf8"),
              context_json: plannedContextJson,
            }),
        );
        pruneExecutionIdentityContextsAfterInsert(
          db,
          options.now ?? Date.now(),
          options.limits ?? {
            maxRows: EXECUTION_IDENTITY_CONTEXT_MAX_ROWS,
            pruneBatchRows: EXECUTION_IDENTITY_CONTEXT_PRUNE_BATCH_ROWS,
          },
        );
        return plannedContext;
      },
      options,
      { operationLabel: "audit.execution-identity.context.record" },
    );
  } catch (error) {
    if (transactionDatabase) {
      clearAuditIdentityKeyCacheForDatabase(transactionDatabase);
    }
    throw error;
  }
}

/** A durable recovery retry may only confirm the originally captured execution. */
function verifyExecutionIdentityAdmissionRetry(
  token: ExecutionIdentityAdmissionToken,
  options: ExecutionIdentityReadOptions = {},
): ExecutionIdentityContextV1 {
  const { db } = openOpenClawStateDatabase(options);
  if (!tableExists(db, "execution_identity_contexts")) {
    throw new Error("execution identity recovery evidence unavailable");
  }
  const existing = readRowByExecutionId(db, token.executionId);
  if (!existing) {
    // Never reconstruct identity from the later runtime after an ambiguous restart.
    throw new Error("execution identity recovery evidence unavailable");
  }
  const context = parseExecutionIdentityRow(existing);
  if (
    context.contextId !== token.contextId ||
    context.executionId !== token.executionId ||
    context.runId !== token.runId ||
    context.createdAt !== token.createdAt
  ) {
    throw new Error("execution identity context conflict for execution");
  }
  return context;
}

/** Worker-owned persistence/verification for one accepted bounded queue item. */
export function processExecutionIdentityAdmissionWork(
  input: unknown,
  options: ExecutionIdentityStoreOptions = {},
): ExecutionIdentityContextV1 {
  const work = parseExecutionIdentityAdmissionWork(input);
  return work.kind === "capture"
    ? persistExecutionIdentityAdmissionEnvelope(work.envelope, options)
    : verifyExecutionIdentityAdmissionRetry(work.token, options);
}

/** Read one exact execution while turning malformed rows into typed diagnostics. */
function readExecutionIdentityContextByExecutionId(
  executionId: string,
  options: ExecutionIdentityReadOptions = {},
): ExecutionIdentityContextReadResult {
  const normalizedExecutionId = ensureBoundedExecutionIdentityRef(executionId, "execution id");
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, "execution_identity_contexts")) {
        return { status: "missing" } as const;
      }
      const row = readRowByExecutionId(db, normalizedExecutionId);
      if (!row) {
        return { status: "missing" } as const;
      }
      const createdAt = normalizeSqliteNumber(row.created_at);
      if (
        createdAt !== undefined &&
        createdAt < (options.now ?? Date.now()) - EXECUTION_IDENTITY_CONTEXT_RETENTION_MS
      ) {
        // The indexed timestamp may explain availability, but expired context JSON
        // must never be parsed or projected while bounded maintenance catches up.
        return { status: "expired", runId: row.run_id } as const;
      }
      try {
        return { status: "found", context: parseExecutionIdentityRow(row) } as const;
      } catch {
        return {
          status: "corrupt",
          runId: row.run_id,
          reasonCode: "identity_context_corrupt",
        } as const;
      }
    }, options) ?? { status: "missing" }
  );
}

function unavailableResult(params: {
  selector: { runId: string } | { executionId: string };
  resolvedRunId?: string;
  runStatus: "known" | "unknown";
  state: "unknown" | "unsupported";
  reasonCode: string;
  missingEvidence: string[];
  remediation: Array<{ code: string; text: string }>;
}): AuditRunInspectResult {
  const run: AuditRunInspectResult["run"] =
    "executionId" in params.selector
      ? {
          executionId: params.selector.executionId,
          ...(params.resolvedRunId ? { runId: params.resolvedRunId } : {}),
          status: params.runStatus,
        }
      : {
          runId: params.resolvedRunId ?? params.selector.runId,
          status: params.runStatus,
        };
  return {
    schemaVersion: 1,
    run,
    identity: {
      state: params.state,
      reasonCode: params.reasonCode,
      missingEvidence: params.missingEvidence,
      remediation: params.remediation,
    },
    decisions: [],
    coverage: { state: params.state, missingEvidence: params.missingEvidence },
  };
}

function unavailableIdentityContext(
  selector: { runId: string } | { executionId: string },
  remediation: { code: string; text: string },
  resolvedRunId?: string,
): AuditRunInspectResult {
  return unavailableResult({
    selector,
    resolvedRunId,
    runStatus: "known",
    state: "unsupported",
    reasonCode: "identity_context_unavailable",
    missingEvidence: ["identity.context"],
    remediation: [remediation],
  });
}

function inspectExactExecution(
  params: { executionId: string; decisionCursor?: string; decisionLimit?: number },
  options: ExecutionIdentityReadOptions,
): AuditRunInspectResult {
  const executionId = ensureBoundedExecutionIdentityRef(params.executionId, "execution id");
  const selector = { executionId };
  const contextResult = readExecutionIdentityContextByExecutionId(executionId, options);
  if (contextResult.status === "found") {
    return presentExecutionDecisionReceipts({
      context: contextResult.context,
      decisionCursor: params.decisionCursor,
      decisionLimit: params.decisionLimit,
      options,
    });
  }
  if (contextResult.status === "corrupt") {
    return unavailableResult({
      selector,
      resolvedRunId: contextResult.runId,
      runStatus: "known",
      state: "unknown",
      reasonCode: contextResult.reasonCode,
      missingEvidence: ["identity.context.valid"],
      remediation: [
        {
          code: "inspect_state_integrity",
          text: "Run openclaw doctor and inspect the shared state database before trusting this execution.",
        },
      ],
    });
  }
  if (contextResult.status === "expired") {
    return unavailableIdentityContext(
      selector,
      {
        code: "run_again_after_expiry",
        text: "This execution's identity context is outside the 30-day retention window; run the operation again to record a new context.",
      },
      contextResult.runId,
    );
  }
  return unavailableResult({
    selector,
    runStatus: "unknown",
    state: "unknown",
    reasonCode: "execution_not_found",
    missingEvidence: ["identity.context"],
    remediation: [
      {
        code: "verify_execution_id",
        text: "Verify the exact execution id; absence of best-effort identity evidence is not proof that no run occurred.",
      },
    ],
  });
}

function hasAnyRunContext(db: DatabaseSync, runId: string): boolean {
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      db,
      executionIdentityDb(db)
        .selectFrom("execution_identity_contexts")
        .select("context_id")
        .where("run_id", "=", runId)
        .limit(1),
    ),
  );
}

function hasRetainedAuditRun(db: DatabaseSync, runId: string, now: number): boolean {
  if (!tableExists(db, "audit_events")) {
    return false;
  }
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      db,
      executionIdentityDb(db)
        .selectFrom("audit_events")
        .select("sequence")
        .where("run_id", "=", runId)
        .where("occurred_at", ">=", now - EXECUTION_IDENTITY_CONTEXT_RETENTION_MS)
        .where("kind", "!=", "message")
        .limit(1),
    ),
  );
}

function inspectRunSelector(
  params: {
    runId: string;
    executionOffset?: number;
    executionLimit?: number;
    decisionCursor?: string;
    decisionLimit?: number;
  },
  options: ExecutionIdentityReadOptions,
): AuditRunInspectResult {
  const runId = ensureBoundedExecutionIdentityRef(params.runId, "run id");
  const now = options.now ?? Date.now();
  const inspected = withExistingOpenClawStateDatabaseReadOnly<AuditRunInspectResult | undefined>(
    ({ db }) => {
      const firstMatches = tableExists(db, "execution_identity_contexts")
        ? readRowsByRunId(db, runId, now, 0, 2)
        : [];
      if (firstMatches.length === 1) {
        let context: ExecutionIdentityContextV1;
        try {
          context = parseExecutionIdentityRow(firstMatches[0]!);
        } catch {
          return unavailableResult({
            selector: { runId },
            runStatus: "known",
            state: "unknown",
            reasonCode: "identity_context_corrupt",
            missingEvidence: ["identity.context.valid"],
            remediation: [
              {
                code: "inspect_state_integrity",
                text: "Run openclaw doctor and inspect the shared state database before trusting this run.",
              },
            ],
          });
        }
        return presentExecutionDecisionReceipts({
          context,
          decisionCursor: params.decisionCursor,
          decisionLimit: params.decisionLimit,
          options,
        });
      }
      if (firstMatches.length > 1) {
        const offset = params.executionOffset ?? 0;
        const limit = params.executionLimit ?? 50;
        const page = readRowsByRunId(db, runId, now, offset, limit + 1);
        const candidates = page.slice(0, limit).map((row) => ({
          executionId: row.execution_id,
          contextId: row.context_id,
          createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
        }));
        return {
          schemaVersion: 1,
          run: { runId, status: "known" },
          identity: {
            state: "ambiguous",
            reasonCode: "execution_selection_required",
            candidates,
            missingEvidence: ["execution.selection"],
            remediation: [
              {
                code: "select_execution_id",
                text: "Select one candidate with openclaw audit --execution <id> --explain.",
              },
            ],
          },
          decisions: [],
          coverage: { state: "unknown", missingEvidence: ["execution.selection"] },
          ...(page.length > limit ? { nextExecutionCursor: String(offset + limit) } : {}),
        };
      }
      if (
        hasOperatorApprovalReceiptsForRun({ runId, nowMs: now, databaseOptions: options }) ||
        hasExecutionDecisionFactsForRun({ runId, now, database: options })
      ) {
        return unavailableResult({
          selector: { runId },
          runStatus: "known",
          state: "unknown",
          reasonCode: "decision_context_link_missing",
          missingEvidence: ["identity.context", "decision.context_link"],
          remediation: [
            {
              code: "record_new_identity_context",
              text: "Confirm execution identity collection is enabled, then run and request the action again to record a linked context.",
            },
          ],
        });
      }
      if (tableExists(db, "execution_identity_contexts") && hasAnyRunContext(db, runId)) {
        return unavailableIdentityContext(
          { runId },
          {
            code: "run_again_after_expiry",
            text: "This run's retained identity contexts are outside the 30-day window; run the operation again to record a new execution.",
          },
        );
      }
      try {
        if (hasRetainedAuditRun(db, runId, now)) {
          return unavailableIdentityContext(
            { runId },
            {
              code: "record_new_identity_context",
              text: "Confirm audit collection is enabled and the Gateway is current, then run the operation again to record a new execution context.",
            },
          );
        }
      } catch {
        return unavailableResult({
          selector: { runId },
          runStatus: "unknown",
          state: "unknown",
          reasonCode: "run_evidence_unreadable",
          missingEvidence: ["run.record", "identity.context"],
          remediation: [
            {
              code: "inspect_state_integrity",
              text: "Run openclaw doctor and retry the run inspection.",
            },
          ],
        });
      }
      return undefined;
    },
    options,
  );
  if (inspected) {
    return inspected;
  }
  return unavailableResult({
    selector: { runId },
    runStatus: "unknown",
    state: "unknown",
    reasonCode: "run_not_found",
    missingEvidence: ["run.record", "identity.context"],
    remediation: [
      {
        code: "verify_run_id",
        text: "Verify the run id; absence of best-effort audit activity is not proof of no run.",
      },
    ],
  });
}

/** Inspect one exact execution or discover bounded executions for a run correlation. */
export function inspectExecutionIdentityRun(
  params:
    | {
        runId: string;
        executionOffset?: number;
        executionLimit?: number;
        decisionCursor?: string;
        decisionLimit?: number;
      }
    | { executionId: string; decisionCursor?: string; decisionLimit?: number },
  options: ExecutionIdentityReadOptions = {},
): AuditRunInspectResult {
  return "executionId" in params
    ? inspectExactExecution(params, options)
    : inspectRunSelector(params, options);
}
