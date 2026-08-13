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
import type { NodeWorkerSupervisorIdentity } from "../worker/node-supervisor-protocol.js";
import {
  inspectNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";

type NodeWorkerLaunchState =
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
  supervisor: NodeWorkerProcessIdentity;
  worker: NodeWorkerProcessIdentity | null;
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

type NodeWorkerLaunchClaimResult = {
  action: "start" | "replay" | "recover";
  receipt: NodeWorkerLaunchReceipt;
};

const NODE_WORKER_LAUNCH_SCHEMA_START = "CREATE TABLE IF NOT EXISTS node_worker_launches (";
const NODE_WORKER_LAUNCH_SCHEMA_END = "\n) STRICT;";
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

function processIdentity(pid: number, startTime: number): NodeWorkerProcessIdentity {
  return { pid, startTime };
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
    supervisor: processIdentity(row.supervisor_pid, row.supervisor_start_time),
    worker:
      row.worker_pid === null || row.worker_start_time === null
        ? null
        : processIdentity(row.worker_pid, row.worker_start_time),
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

function validateProcessIdentity(identity: NodeWorkerProcessIdentity): void {
  if (
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    identity.pid > 2_147_483_647 ||
    !Number.isSafeInteger(identity.startTime) ||
    identity.startTime < 0
  ) {
    throw new Error("node worker process identity must contain a bounded pid and start time");
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

function rowHasSupervisor(row: NodeWorkerLaunchRow, identity: NodeWorkerProcessIdentity): boolean {
  return row.supervisor_pid === identity.pid && row.supervisor_start_time === identity.startTime;
}

function rowHasWorker(
  row: NodeWorkerLaunchRow,
  identity: NodeWorkerProcessIdentity | null,
): boolean {
  return identity === null
    ? row.worker_pid === null && row.worker_start_time === null
    : row.worker_pid === identity.pid && row.worker_start_time === identity.startTime;
}

function sameObservedOwner(current: NodeWorkerLaunchRow, observed: NodeWorkerLaunchRow): boolean {
  return (
    current.state === observed.state &&
    current.supervisor_pid === observed.supervisor_pid &&
    current.supervisor_start_time === observed.supervisor_start_time &&
    current.worker_pid === observed.worker_pid &&
    current.worker_start_time === observed.worker_start_time
  );
}

function rowMatchesImmutableIdentity(
  row: NodeWorkerLaunchRow,
  expected: NodeWorkerSupervisorIdentity,
): boolean {
  return (
    row.launch_id === expected.launchId &&
    row.plan_hash === expected.planHash &&
    row.environment_id === expected.environmentId &&
    row.session_id === expected.sessionId &&
    row.owner_epoch === expected.ownerEpoch &&
    row.placement_generation === expected.placementGeneration &&
    row.run_id === expected.runId
  );
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
    supervisor: NodeWorkerProcessIdentity,
    nowMs = Date.now(),
  ): NodeWorkerLaunchClaimResult {
    validateIdentifier(claim.launchId, "node worker launch id");
    validatePlanHash(claim.planHash);
    validateTimestamp(nowMs);
    validateProcessIdentity(supervisor);

    // Process inspection is intentionally outside SQLite. The second transaction
    // re-reads the exact owner tuple before an adoption or recovery decision.
    const observed = this.write("node-worker-launch.claim-inspect", (database) =>
      readRow(database, claim.launchId),
    );
    if (observed && observed.plan_hash !== claim.planHash) {
      throw new Error(`node worker launch ${claim.launchId} was replayed with a different plan`);
    }
    const observedSupervisorState = observed
      ? inspectNodeWorkerProcessIdentity(
          processIdentity(observed.supervisor_pid, observed.supervisor_start_time),
        )
      : undefined;

    return this.write("node-worker-launch.claim", (database) => {
      let current = readRow(database, claim.launchId);
      if (!current) {
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
            supervisor_pid: supervisor.pid,
            supervisor_start_time: supervisor.startTime,
            worker_pid: null,
            worker_start_time: null,
            result_json: null,
            error_text: null,
            completed_at_ms: null,
            created_at_ms: nowMs,
            updated_at_ms: nowMs,
          }),
        );
        return {
          action: "start",
          receipt: receiptFromRow(requireMatchingRow(database, claim.launchId, claim.planHash)),
        };
      }
      if (current.plan_hash !== claim.planHash) {
        throw new Error(`node worker launch ${claim.launchId} was replayed with a different plan`);
      }
      const previousOwnerDefinitelyStale =
        observedSupervisorState === "dead" || observedSupervisorState === "reused";
      if (
        current.state === "pending" &&
        observed &&
        sameObservedOwner(current, observed) &&
        previousOwnerDefinitelyStale
      ) {
        const updatedAtMs = Math.max(nowMs, current.created_at_ms, current.updated_at_ms);
        executeSqliteQuerySync(
          database,
          query(database)
            .updateTable("node_worker_launches")
            .set({
              supervisor_pid: supervisor.pid,
              supervisor_start_time: supervisor.startTime,
              updated_at_ms: updatedAtMs,
            })
            .where("launch_id", "=", claim.launchId)
            .where("plan_hash", "=", claim.planHash)
            .where("state", "=", "pending")
            .where("supervisor_pid", "=", observed.supervisor_pid)
            .where("supervisor_start_time", "=", observed.supervisor_start_time)
            .where("worker_pid", "is", null)
            .where("worker_start_time", "is", null),
        );
        current = requireMatchingRow(database, claim.launchId, claim.planHash);
        return {
          action: rowHasSupervisor(current, supervisor) ? "start" : "replay",
          receipt: receiptFromRow(current),
        };
      }
      if (
        current.state === "running" &&
        observed &&
        sameObservedOwner(current, observed) &&
        previousOwnerDefinitelyStale
      ) {
        return { action: "recover", receipt: receiptFromRow(current) };
      }
      return { action: "replay", receipt: receiptFromRow(current) };
    });
  }

  get(launchId: string): NodeWorkerLaunchReceipt | undefined {
    validateIdentifier(launchId, "node worker launch id");
    return this.write("node-worker-launch.get", (database) => {
      const row = readRow(database, launchId);
      return row ? receiptFromRow(row) : undefined;
    });
  }

  getMatching(expected: NodeWorkerSupervisorIdentity): NodeWorkerLaunchReceipt | undefined {
    validateIdentifier(expected.launchId, "node worker launch id");
    validatePlanHash(expected.planHash);
    return this.write("node-worker-launch.get-matching", (database) => {
      const row = readRow(database, expected.launchId);
      return row && rowMatchesImmutableIdentity(row, expected) ? receiptFromRow(row) : undefined;
    });
  }

  finishCancelled(params: {
    expected: NodeWorkerSupervisorIdentity;
    supervisor: NodeWorkerProcessIdentity;
    worker: NodeWorkerProcessIdentity | null;
    nowMs?: number;
  }): NodeWorkerLaunchReceipt | undefined {
    const nowMs = params.nowMs ?? Date.now();
    validateTimestamp(nowMs);
    validateProcessIdentity(params.supervisor);
    if (params.worker) {
      validateProcessIdentity(params.worker);
    }
    return this.write("node-worker-launch.finish-cancelled", (database) => {
      const current = readRow(database, params.expected.launchId);
      if (!current || !rowMatchesImmutableIdentity(current, params.expected)) {
        return undefined;
      }
      if (TERMINAL_STATES.has(current.state)) {
        return receiptFromRow(current);
      }
      if (!rowHasSupervisor(current, params.supervisor) || !rowHasWorker(current, params.worker)) {
        return receiptFromRow(current);
      }
      const completedAtMs = Math.max(nowMs, current.created_at_ms, current.updated_at_ms);
      let update = query(database)
        .updateTable("node_worker_launches")
        .set({
          state: "cancelled",
          result_json: null,
          error_text: "node worker launch cancelled",
          completed_at_ms: completedAtMs,
          updated_at_ms: completedAtMs,
        })
        .where("launch_id", "=", params.expected.launchId)
        .where("plan_hash", "=", params.expected.planHash)
        .where("environment_id", "=", params.expected.environmentId)
        .where("session_id", "=", params.expected.sessionId)
        .where("owner_epoch", "=", params.expected.ownerEpoch)
        .where("placement_generation", "=", params.expected.placementGeneration)
        .where("run_id", "=", params.expected.runId)
        .where("state", "in", ["pending", "running"])
        .where("supervisor_pid", "=", params.supervisor.pid)
        .where("supervisor_start_time", "=", params.supervisor.startTime);
      update = params.worker
        ? update
            .where("worker_pid", "=", params.worker.pid)
            .where("worker_start_time", "=", params.worker.startTime)
        : update.where("worker_pid", "is", null).where("worker_start_time", "is", null);
      executeSqliteQuerySync(database, update);
      const settled = readRow(database, params.expected.launchId);
      return settled && rowMatchesImmutableIdentity(settled, params.expected)
        ? receiptFromRow(settled)
        : undefined;
    });
  }

  markRunning(params: {
    launchId: string;
    planHash: string;
    supervisor: NodeWorkerProcessIdentity;
    worker: NodeWorkerProcessIdentity;
    nowMs?: number;
  }): NodeWorkerLaunchReceipt {
    const nowMs = params.nowMs ?? Date.now();
    validateTimestamp(nowMs);
    validateProcessIdentity(params.supervisor);
    validateProcessIdentity(params.worker);
    return this.write("node-worker-launch.mark-running", (database) => {
      const current = requireMatchingRow(database, params.launchId, params.planHash);
      if (TERMINAL_STATES.has(current.state)) {
        return receiptFromRow(current);
      }
      if (current.state === "running") {
        return receiptFromRow(current);
      }
      if (!rowHasSupervisor(current, params.supervisor) || !rowHasWorker(current, null)) {
        return receiptFromRow(current);
      }
      const updatedAtMs = Math.max(nowMs, current.created_at_ms, current.updated_at_ms);
      executeSqliteQuerySync(
        database,
        query(database)
          .updateTable("node_worker_launches")
          .set({
            state: "running",
            worker_pid: params.worker.pid,
            worker_start_time: params.worker.startTime,
            updated_at_ms: updatedAtMs,
          })
          .where("launch_id", "=", params.launchId)
          .where("plan_hash", "=", params.planHash)
          .where("state", "=", "pending")
          .where("supervisor_pid", "=", params.supervisor.pid)
          .where("supervisor_start_time", "=", params.supervisor.startTime)
          .where("worker_pid", "is", null)
          .where("worker_start_time", "is", null),
      );
      return receiptFromRow(requireMatchingRow(database, params.launchId, params.planHash));
    });
  }

  finish(params: {
    launchId: string;
    planHash: string;
    supervisor: NodeWorkerProcessIdentity;
    worker: NodeWorkerProcessIdentity | null;
    state: NodeWorkerTerminalState;
    resultJson?: string;
    errorText?: string;
    nowMs?: number;
  }): NodeWorkerLaunchReceipt {
    const nowMs = params.nowMs ?? Date.now();
    validateTimestamp(nowMs);
    validateProcessIdentity(params.supervisor);
    if (params.worker) {
      validateProcessIdentity(params.worker);
    }
    return this.write("node-worker-launch.finish", (database) => {
      const current = requireMatchingRow(database, params.launchId, params.planHash);
      if (TERMINAL_STATES.has(current.state)) {
        return receiptFromRow(current);
      }
      if (!rowHasSupervisor(current, params.supervisor) || !rowHasWorker(current, params.worker)) {
        return receiptFromRow(current);
      }
      const completedAtMs = Math.max(nowMs, current.created_at_ms, current.updated_at_ms);
      let update = query(database)
        .updateTable("node_worker_launches")
        .set({
          state: params.state,
          result_json: params.state === "completed" ? (params.resultJson ?? null) : null,
          error_text: params.state === "completed" ? null : (params.errorText ?? null),
          completed_at_ms: completedAtMs,
          updated_at_ms: completedAtMs,
        })
        .where("launch_id", "=", params.launchId)
        .where("plan_hash", "=", params.planHash)
        .where("state", "in", ["pending", "running"])
        .where("supervisor_pid", "=", params.supervisor.pid)
        .where("supervisor_start_time", "=", params.supervisor.startTime);
      update = params.worker
        ? update
            .where("worker_pid", "=", params.worker.pid)
            .where("worker_start_time", "=", params.worker.startTime)
        : update.where("worker_pid", "is", null).where("worker_start_time", "is", null);
      executeSqliteQuerySync(database, update);
      return receiptFromRow(requireMatchingRow(database, params.launchId, params.planHash));
    });
  }
}
