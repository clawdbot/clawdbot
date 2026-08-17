/** Exact execution binding for owner-native outbound message lifecycle facts. */
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableExists, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import {
  parseExecutionIdentityAdmissionToken,
  type ExecutionIdentityAdmissionToken,
} from "./execution-identity-admission.js";

type ExecutionBindingDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "execution_identity_contexts" | "outbound_message_execution_bindings"
>;
const ensuredTerminalBindingDatabases = new WeakSet<DatabaseSync>();

export type MessageExecutionBinding = Readonly<{
  contextId: string;
  executionId: string;
}>;

export function selectMessageExecutionBinding(params: {
  contextId?: string;
  executionId?: string;
}): MessageExecutionBinding | undefined {
  if (params.contextId === undefined && params.executionId === undefined) {
    return undefined;
  }
  if (!params.contextId || !params.executionId) {
    throw new Error("outbound message decision query requires the exact context and execution");
  }
  return { contextId: params.contextId, executionId: params.executionId };
}

export function hasMessageExecutionBindingColumns(
  db: DatabaseSync,
  tableName: "outbound_message_progress",
): boolean {
  return (
    tableHasColumn(db, tableName, "context_id") && tableHasColumn(db, tableName, "execution_id")
  );
}

function terminalBindingSchemaSql(): string {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    "CREATE TABLE IF NOT EXISTS outbound_message_execution_bindings (",
  );
  const indexStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
    "CREATE INDEX IF NOT EXISTS outbound_message_execution_bindings_execution_event_idx",
    start,
  );
  const end = indexStart >= 0 ? OPENCLAW_STATE_SCHEMA_SQL.indexOf(";", indexStart) : -1;
  if (start < 0 || end < 0) {
    throw new Error("canonical outbound message execution binding schema is missing");
  }
  return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + 1);
}

/** Install the terminal binding companion only when an exact producer first uses it. */
export function ensureTerminalMessageExecutionBindingSchema(
  options: OpenClawStateDatabaseOptions,
): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredTerminalBindingDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- feature-local additive schema DDL; bindings use Kysely.
      db.exec(terminalBindingSchemaSql());
    },
    { ...options, database },
    { operationLabel: "audit.outbound-message.execution-binding.schema.ensure" },
  );
  ensuredTerminalBindingDatabases.add(database.db);
}

/** Validate queue-loaded token bytes before entering a synchronous write transaction. */
export function planMessageExecutionBinding(
  token: ExecutionIdentityAdmissionToken | undefined,
  runId: string | undefined,
): ExecutionIdentityAdmissionToken | undefined {
  if (!token) {
    return undefined;
  }
  const planned = parseExecutionIdentityAdmissionToken(token);
  if (!runId || planned.runId !== runId) {
    throw new Error("outbound message execution binding disagrees with the admitted run");
  }
  return planned;
}

/** Confirm the exact retained admission row; run correlation alone never binds a receipt. */
export function confirmMessageExecutionBinding(
  db: DatabaseSync,
  token: ExecutionIdentityAdmissionToken | undefined,
): MessageExecutionBinding | undefined {
  if (!token || !tableExists(db, "execution_identity_contexts")) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<ExecutionBindingDatabase>(db)
      .selectFrom("execution_identity_contexts")
      .select("context_id")
      .where("context_id", "=", token.contextId)
      .where("execution_id", "=", token.executionId)
      .where("run_id", "=", token.runId)
      .where("created_at", "=", token.createdAt),
  );
  return row ? { contextId: token.contextId, executionId: token.executionId } : undefined;
}

export function recordTerminalMessageExecutionBinding(
  db: DatabaseSync,
  params: MessageExecutionBinding & { eventId: string; runId: string },
): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<ExecutionBindingDatabase>(db)
      .insertInto("outbound_message_execution_bindings")
      .values({
        event_id: params.eventId,
        context_id: params.contextId,
        execution_id: params.executionId,
        run_id: params.runId,
      }),
  );
}

export function recordConfirmedTerminalMessageExecutionBinding(
  db: DatabaseSync,
  params: { eventId: string | undefined; token?: ExecutionIdentityAdmissionToken },
): void {
  if (!params.eventId) {
    return;
  }
  const binding = confirmMessageExecutionBinding(db, params.token);
  if (binding && params.token) {
    recordTerminalMessageExecutionBinding(db, {
      eventId: params.eventId,
      runId: params.token.runId,
      ...binding,
    });
  }
}
