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
  readNodeWorkerLaunchReceipt,
  settleNodeWorkerActiveTurns,
  type NodeWorkerLaunchClaim,
  type NodeWorkerLaunchReceipt,
  type NodeWorkerTerminalState,
} from "./node-worker-launch-store.js";
import type { NodeWorkerProcessIdentity } from "./node-worker-process-identity.js";

type TurnDatabase = Pick<OpenClawStateDatabase, "node_worker_turns">;
type TurnRow = Selectable<TurnDatabase["node_worker_turns"]>;

export type NodeWorkerTurnReceipt = NodeWorkerLaunchReceipt & { ownerLaunchId: string };

const initializedDatabases = new WeakSet<DatabaseSync>();
const TERMINAL_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const TERMINAL_PRUNE_BATCH_LIMIT = 256;

function query(database: DatabaseSync) {
  return getNodeSqliteKysely<TurnDatabase>(database);
}

function ensureTurnSchema(database: DatabaseSync): void {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS node_worker_turns (");
  const endMarker = "\n  WHERE state = 'running';";
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(endMarker, start);
  if (start < 0 || end < start) {
    throw new Error("OpenClaw node worker turn schema marker is missing.");
  }
  database.exec(OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + endMarker.length)); // sqlite-allow-raw -- Canonical feature-local additive DDL only.
}

function readRow(database: DatabaseSync, turnId: string): TurnRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    database,
    query(database).selectFrom("node_worker_turns").selectAll().where("turn_id", "=", turnId),
  );
}

function readReceipt(database: DatabaseSync, turnId: string): NodeWorkerTurnReceipt | undefined {
  let turn = readRow(database, turnId);
  if (!turn) {
    return undefined;
  }
  const owner = readNodeWorkerLaunchReceipt(database, turn.owner_launch_id);
  if (!owner) {
    throw new Error(`node worker turn ${turnId} has no physical owner`);
  }
  if (turn.state === "running" && owner.state !== "pending" && owner.state !== "running") {
    // A predecessor can finish the physical journal without knowing about turn receipts.
    settleNodeWorkerActiveTurns(database, owner);
    turn = readRow(database, turnId)!;
  }
  const state = turn.state === "running" && owner.state === "pending" ? "pending" : turn.state;
  if (
    state !== "pending" &&
    state !== "running" &&
    state !== "completed" &&
    state !== "failed" &&
    state !== "interrupted" &&
    state !== "cancelled"
  ) {
    throw new Error(`invalid node worker turn state ${state}`);
  }
  return {
    ...owner,
    ownerLaunchId: owner.launchId,
    launchId: turn.turn_id,
    planHash: turn.plan_hash,
    runId: turn.run_id,
    state,
    resultJson: turn.result_json,
    errorText: turn.error_text,
    completedAtMs: turn.completed_at_ms,
    createdAtMs: turn.created_at_ms,
    updatedAtMs: turn.updated_at_ms,
  };
}

function matchesIdentity(
  receipt: NodeWorkerTurnReceipt,
  expected: NodeWorkerSupervisorIdentity,
): boolean {
  return (
    receipt.launchId === expected.launchId &&
    receipt.planHash === expected.planHash &&
    receipt.environmentId === expected.environmentId &&
    receipt.sessionId === expected.sessionId &&
    receipt.ownerEpoch === expected.ownerEpoch &&
    receipt.placementGeneration === expected.placementGeneration &&
    receipt.runId === expected.runId
  );
}

function matchesProcess(
  receipt: NodeWorkerLaunchReceipt,
  supervisor: NodeWorkerProcessIdentity,
  worker: NodeWorkerProcessIdentity | null,
): boolean {
  return (
    receipt.supervisor.pid === supervisor.pid &&
    receipt.supervisor.startTime === supervisor.startTime &&
    receipt.worker?.pid === worker?.pid &&
    receipt.worker?.startTime === worker?.startTime
  );
}

function pruneTerminal(database: DatabaseSync, nowMs: number, excludeTurnId: string): void {
  // A warm worker may live indefinitely; its finished turns must not accumulate with it.
  executeSqliteQuerySync(
    database,
    query(database)
      .deleteFrom("node_worker_turns")
      .where(
        "turn_id",
        "in",
        query(database)
          .selectFrom("node_worker_turns")
          .select("turn_id")
          .where("completed_at_ms", "<=", Math.max(0, nowMs - TERMINAL_RECEIPT_RETENTION_MS))
          .where("turn_id", "!=", excludeTurnId)
          .orderBy("completed_at_ms", "asc")
          .orderBy("turn_id", "asc")
          .limit(TERMINAL_PRUNE_BATCH_LIMIT),
      ),
  );
}

/** Immutable turn outcomes attached to a separately supervised physical worker. */
export class NodeWorkerTurnStore {
  private readonly databaseOptions: OpenClawStateDatabaseOptions;

  constructor(options: { env?: NodeJS.ProcessEnv } = {}) {
    this.databaseOptions = options.env ? { env: options.env } : {};
  }

  private write<T>(operationLabel: string, operation: (database: DatabaseSync) => T): T {
    let initialized: DatabaseSync | undefined;
    const result = runOpenClawStateWriteTransaction(
      ({ db }) => {
        if (!initializedDatabases.has(db)) {
          ensureTurnSchema(db);
          initialized = db;
        }
        return operation(db);
      },
      this.databaseOptions,
      { operationLabel },
    );
    if (initialized) {
      initializedDatabases.add(initialized);
    }
    return result;
  }

  claim(params: {
    claim: NodeWorkerLaunchClaim;
    ownerLaunchId: string;
    supervisor: NodeWorkerProcessIdentity;
    worker?: NodeWorkerProcessIdentity | null;
    nowMs?: number;
  }): { action: "start" | "replay"; receipt: NodeWorkerTurnReceipt } {
    const { claim, ownerLaunchId, supervisor } = params;
    const nowMs = params.nowMs ?? Date.now();
    return this.write("node-worker-turn.claim", (database) => {
      const existing = readReceipt(database, claim.launchId);
      if (existing) {
        if (
          !matchesIdentity(existing, claim) ||
          existing.gatewayNamespace !== claim.gatewayNamespace ||
          existing.ownerLaunchId !== ownerLaunchId
        ) {
          throw new Error(
            `node worker turn ${claim.launchId} was replayed with a different plan or owner`,
          );
        }
        pruneTerminal(database, nowMs, claim.launchId);
        return { action: "replay", receipt: existing };
      }
      const owner = readNodeWorkerLaunchReceipt(database, ownerLaunchId);
      if (
        !owner ||
        (owner.state !== "pending" && owner.state !== "running") ||
        !matchesProcess(owner, supervisor, params.worker ?? null) ||
        owner.gatewayNamespace !== claim.gatewayNamespace ||
        owner.environmentId !== claim.environmentId ||
        owner.sessionId !== claim.sessionId ||
        owner.ownerEpoch !== claim.ownerEpoch ||
        owner.placementGeneration !== claim.placementGeneration ||
        (owner.state === "pending" && owner.launchId !== claim.launchId) ||
        (owner.launchId === claim.launchId &&
          (owner.state !== "pending" ||
            owner.planHash !== claim.planHash ||
            owner.runId !== claim.runId))
      ) {
        throw new Error(
          `node worker turn ${claim.launchId} does not match its live physical owner`,
        );
      }
      executeSqliteQuerySync(
        database,
        query(database).insertInto("node_worker_turns").values({
          turn_id: claim.launchId,
          owner_launch_id: ownerLaunchId,
          plan_hash: claim.planHash,
          run_id: claim.runId,
          state: "running",
          result_json: null,
          error_text: null,
          completed_at_ms: null,
          created_at_ms: nowMs,
          updated_at_ms: nowMs,
        }),
      );
      pruneTerminal(database, nowMs, claim.launchId);
      return { action: "start", receipt: readReceipt(database, claim.launchId)! };
    });
  }

  get(turnId: string): NodeWorkerTurnReceipt | undefined {
    return this.write("node-worker-turn.get", (database) => readReceipt(database, turnId));
  }

  getMatching(expected: NodeWorkerSupervisorIdentity): NodeWorkerTurnReceipt | undefined {
    const receipt = this.get(expected.launchId);
    return receipt && matchesIdentity(receipt, expected) ? receipt : undefined;
  }

  finish(params: {
    expected: NodeWorkerSupervisorIdentity;
    ownerLaunchId: string;
    supervisor: NodeWorkerProcessIdentity;
    worker: NodeWorkerProcessIdentity | null;
    state: NodeWorkerTerminalState;
    resultJson?: string;
    errorText?: string;
    nowMs?: number;
  }): NodeWorkerTurnReceipt | undefined {
    return this.write("node-worker-turn.finish", (database) => {
      const receipt = readReceipt(database, params.expected.launchId);
      if (
        !receipt ||
        !matchesIdentity(receipt, params.expected) ||
        receipt.ownerLaunchId !== params.ownerLaunchId
      ) {
        return undefined;
      }
      if (
        (receipt.state !== "pending" && receipt.state !== "running") ||
        !matchesProcess(receipt, params.supervisor, params.worker)
      ) {
        return receipt;
      }
      const nowMs = params.nowMs ?? Date.now();
      const completedAtMs = Math.max(nowMs, receipt.createdAtMs, receipt.updatedAtMs);
      executeSqliteQuerySync(
        database,
        query(database)
          .updateTable("node_worker_turns")
          .set({
            state: params.state,
            result_json: params.state === "completed" ? (params.resultJson ?? null) : null,
            error_text: params.state === "completed" ? null : (params.errorText ?? null),
            completed_at_ms: completedAtMs,
            updated_at_ms: completedAtMs,
          })
          .where("turn_id", "=", receipt.launchId)
          .where("state", "=", "running"),
      );
      pruneTerminal(database, nowMs, receipt.launchId);
      return readReceipt(database, receipt.launchId);
    });
  }
}
