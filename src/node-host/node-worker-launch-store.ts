import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";

export type NodeWorkerLaunchState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";
export type NodeWorkerTerminalState = Exclude<NodeWorkerLaunchState, "pending" | "running">;

type NodeWorkerLaunchDatabase = Pick<OpenClawStateDatabase, "node_worker_launches">;
type NodeWorkerLaunchRow = Selectable<NodeWorkerLaunchDatabase["node_worker_launches"]>;

export type NodeWorkerLaunchReceipt = {
  launchId: string;
  planHash: string;
  gatewayNamespace: string;
  environmentId: string;
  sessionId: string;
  ownerEpoch: number;
  placementGeneration: number;
  runId: string;
  state: NodeWorkerLaunchState;
  pid: number | null;
  resultJson: string | null;
  errorText: string | null;
  completedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
};

type NodeWorkerLaunchClaim = Pick<
  NodeWorkerLaunchReceipt,
  | "environmentId"
  | "gatewayNamespace"
  | "launchId"
  | "ownerEpoch"
  | "placementGeneration"
  | "planHash"
  | "runId"
  | "sessionId"
>;

const NODE_WORKER_LAUNCH_SCHEMA_START = "CREATE TABLE IF NOT EXISTS node_worker_launches (";
const NODE_WORKER_LAUNCH_SCHEMA_END = "\n) STRICT;";
const RECOVERY_ERROR = "node host restarted before the worker launch completed";
const initializedDatabases = new WeakSet<DatabaseSync>();
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

function ensureNodeWorkerLaunchSchema(database: DatabaseSync): void {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(NODE_WORKER_LAUNCH_SCHEMA_START);
  const end =
    start >= 0 ? OPENCLAW_STATE_SCHEMA_SQL.indexOf(NODE_WORKER_LAUNCH_SCHEMA_END, start) : -1;
  if (start < 0 || end < start) {
    throw new Error("OpenClaw node worker launch schema marker is missing.");
  }
  database.exec(OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + NODE_WORKER_LAUNCH_SCHEMA_END.length)); // sqlite-allow-raw -- Canonical feature-local additive DDL only.
}

function query(database: DatabaseSync) {
  return getNodeSqliteKysely<NodeWorkerLaunchDatabase>(database);
}

function readRow(database: DatabaseSync, launchId: string): NodeWorkerLaunchRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    database,
    query(database)
      .selectFrom("node_worker_launches")
      .selectAll()
      .where("launch_id", "=", launchId),
  );
}

function receiptFromRow(row: NodeWorkerLaunchRow): NodeWorkerLaunchReceipt {
  if (!isNodeWorkerLaunchState(row.state)) {
    throw new Error(`invalid node worker launch state ${row.state}`);
  }
  return {
    launchId: row.launch_id,
    planHash: row.plan_hash,
    gatewayNamespace: row.gateway_namespace,
    environmentId: row.environment_id,
    sessionId: row.session_id,
    ownerEpoch: row.owner_epoch,
    placementGeneration: row.placement_generation,
    runId: row.run_id,
    state: row.state,
    pid: row.pid,
    resultJson: row.result_json,
    errorText: row.error_text,
    completedAtMs: row.completed_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function isNodeWorkerLaunchState(value: string): value is NodeWorkerLaunchState {
  return value === "pending" || value === "running" || TERMINAL_STATES.has(value);
}

function validateIdentifier(value: string, label: string): void {
  if (!value || value.trim() !== value || value.length > 256 || value.includes("\0")) {
    throw new Error(`${label} must be a bounded non-empty identifier`);
  }
}

function validatePlanHash(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("node worker plan hash must be 64 lowercase hexadecimal characters");
  }
}

function validateTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("node worker launch timestamp must be a non-negative safe integer");
  }
}

function requireMatchingRow(
  database: DatabaseSync,
  launchId: string,
  planHash: string,
): NodeWorkerLaunchRow {
  const row = readRow(database, launchId);
  if (!row) {
    throw new Error(`node worker launch ${launchId} does not exist`);
  }
  if (row.plan_hash !== planHash) {
    throw new Error(`node worker launch ${launchId} was replayed with a different plan`);
  }
  return row;
}

/** Synchronous shared-state owner for durable node worker launch supervision. */
export class NodeWorkerLaunchStore {
  private readonly databaseOptions: OpenClawStateDatabaseOptions;

  constructor(options: { env?: NodeJS.ProcessEnv } = {}) {
    this.databaseOptions = options.env ? { env: options.env } : {};
  }

  private write<T>(operationLabel: string, operation: (database: DatabaseSync) => T): T {
    let initializedDatabase: DatabaseSync | undefined;
    const result = runOpenClawStateWriteTransaction(
      ({ db }) => {
        if (!initializedDatabases.has(db)) {
          ensureNodeWorkerLaunchSchema(db);
          const interrupted = executeSqliteQuerySync(
            db,
            query(db)
              .selectFrom("node_worker_launches")
              .select(["launch_id", "created_at_ms", "updated_at_ms"])
              .where("state", "in", ["pending", "running"]),
          ).rows;
          for (const row of interrupted) {
            const recoveredAtMs = Math.max(Date.now(), row.created_at_ms, row.updated_at_ms);
            executeSqliteQuerySync(
              db,
              query(db)
                .updateTable("node_worker_launches")
                .set({
                  state: "interrupted",
                  pid: null,
                  result_json: null,
                  error_text: RECOVERY_ERROR,
                  completed_at_ms: recoveredAtMs,
                  updated_at_ms: recoveredAtMs,
                })
                .where("launch_id", "=", row.launch_id)
                .where("state", "in", ["pending", "running"]),
            );
          }
          initializedDatabase = db;
        }
        return operation(db);
      },
      this.databaseOptions,
      { operationLabel },
    );
    if (initializedDatabase) {
      initializedDatabases.add(initializedDatabase);
    }
    return result;
  }

  claim(
    claim: NodeWorkerLaunchClaim,
    nowMs = Date.now(),
  ): { created: boolean; receipt: NodeWorkerLaunchReceipt } {
    validateIdentifier(claim.launchId, "node worker launch id");
    validatePlanHash(claim.planHash);
    validateTimestamp(nowMs);
    return this.write("node-worker-launch.claim", (database) => {
      const existing = readRow(database, claim.launchId);
      if (existing) {
        if (existing.plan_hash !== claim.planHash) {
          throw new Error(
            `node worker launch ${claim.launchId} was replayed with a different plan`,
          );
        }
        return { created: false, receipt: receiptFromRow(existing) };
      }
      executeSqliteQuerySync(
        database,
        query(database).insertInto("node_worker_launches").values({
          launch_id: claim.launchId,
          plan_hash: claim.planHash,
          gateway_namespace: claim.gatewayNamespace,
          environment_id: claim.environmentId,
          session_id: claim.sessionId,
          owner_epoch: claim.ownerEpoch,
          placement_generation: claim.placementGeneration,
          run_id: claim.runId,
          state: "pending",
          pid: null,
          result_json: null,
          error_text: null,
          completed_at_ms: null,
          created_at_ms: nowMs,
          updated_at_ms: nowMs,
        }),
      );
      return {
        created: true,
        receipt: receiptFromRow(requireMatchingRow(database, claim.launchId, claim.planHash)),
      };
    });
  }

  get(launchId: string): NodeWorkerLaunchReceipt | undefined {
    validateIdentifier(launchId, "node worker launch id");
    return this.write("node-worker-launch.get", (database) => {
      const row = readRow(database, launchId);
      return row ? receiptFromRow(row) : undefined;
    });
  }

  markRunning(params: {
    launchId: string;
    planHash: string;
    pid: number;
    nowMs?: number;
  }): NodeWorkerLaunchReceipt {
    const nowMs = params.nowMs ?? Date.now();
    validateTimestamp(nowMs);
    return this.write("node-worker-launch.mark-running", (database) => {
      const current = requireMatchingRow(database, params.launchId, params.planHash);
      if (TERMINAL_STATES.has(current.state)) {
        return receiptFromRow(current);
      }
      if (current.state === "running") {
        if (current.pid !== params.pid) {
          throw new Error(`node worker launch ${params.launchId} changed process identity`);
        }
        return receiptFromRow(current);
      }
      const updatedAtMs = Math.max(nowMs, current.created_at_ms, current.updated_at_ms);
      executeSqliteQuerySync(
        database,
        query(database)
          .updateTable("node_worker_launches")
          .set({ state: "running", pid: params.pid, updated_at_ms: updatedAtMs })
          .where("launch_id", "=", params.launchId)
          .where("plan_hash", "=", params.planHash)
          .where("state", "=", "pending"),
      );
      return receiptFromRow(requireMatchingRow(database, params.launchId, params.planHash));
    });
  }

  finish(params: {
    launchId: string;
    planHash: string;
    state: NodeWorkerTerminalState;
    resultJson?: string;
    errorText?: string;
    nowMs?: number;
  }): NodeWorkerLaunchReceipt {
    const nowMs = params.nowMs ?? Date.now();
    validateTimestamp(nowMs);
    return this.write("node-worker-launch.finish", (database) => {
      const current = requireMatchingRow(database, params.launchId, params.planHash);
      if (TERMINAL_STATES.has(current.state)) {
        return receiptFromRow(current);
      }
      const completedAtMs = Math.max(nowMs, current.created_at_ms, current.updated_at_ms);
      executeSqliteQuerySync(
        database,
        query(database)
          .updateTable("node_worker_launches")
          .set({
            state: params.state,
            pid: null,
            result_json: params.state === "completed" ? (params.resultJson ?? null) : null,
            error_text: params.state === "completed" ? null : (params.errorText ?? null),
            completed_at_ms: completedAtMs,
            updated_at_ms: completedAtMs,
          })
          .where("launch_id", "=", params.launchId)
          .where("plan_hash", "=", params.planHash)
          .where("state", "in", ["pending", "running"]),
      );
      return receiptFromRow(requireMatchingRow(database, params.launchId, params.planHash));
    });
  }
}
