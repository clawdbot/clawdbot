import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import {
  type WorkerInferenceTerminalOutcome,
  validateWorkerInferenceTerminalOutcome,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type {
  DB as StateDatabase,
  WorkerInferenceTurns,
} from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";

type InferenceDb = Pick<StateDatabase, "worker_inference_turns">;
type TurnRow = Selectable<WorkerInferenceTurns>;
type TurnInsert = Insertable<WorkerInferenceTurns>;

export type WorkerInferenceTurnInput = {
  environmentId: string;
  sessionId: string;
  runEpoch: number;
  runId: string;
  turnId: string;
  requestHash: string;
};

type WorkerInferenceTurnBeginResult =
  | { kind: "claimed" }
  | { kind: "recover" }
  | { kind: "replay"; outcome: WorkerInferenceTerminalOutcome }
  | { kind: "rejected"; reason: "conflict" };

type NormalizedTurnInput = WorkerInferenceTurnInput & { nowMs: number };
type WorkerInferenceTurnIdentity = Pick<
  WorkerInferenceTurnInput,
  "sessionId" | "runEpoch" | "runId" | "turnId"
>;
type WorkerInferenceRetentionPolicy = {
  maxAgeMs: number;
  maxRows: number;
  maxBytes: number;
};
type ExistingTurnResult = Extract<
  WorkerInferenceTurnBeginResult,
  { kind: "recover" | "replay" | "rejected" }
>;

const REQUEST_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_RETENTION: WorkerInferenceRetentionPolicy = {
  maxAgeMs: 24 * 60 * 60 * 1_000,
  maxRows: 256,
  maxBytes: 64 * 1024 * 1024,
};

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Worker inference turn ${field} must be a non-empty string`);
  }
  return value.trim();
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Worker inference turn ${field} must be a non-negative integer`);
  }
  return value;
}

function normalizeRequestHash(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_HASH_PATTERN.test(value)) {
    throw new Error("Worker inference turn request hash must be lowercase SHA-256 hex");
  }
  return value;
}

function normalizeInput(input: WorkerInferenceTurnInput, nowMs: number): NormalizedTurnInput {
  return {
    environmentId: required(input.environmentId, "environment id"),
    sessionId: required(input.sessionId, "session id"),
    runEpoch: nonNegativeInteger(input.runEpoch, "run epoch"),
    runId: required(input.runId, "run id"),
    turnId: required(input.turnId, "turn id"),
    requestHash: normalizeRequestHash(input.requestHash),
    nowMs: nonNegativeInteger(nowMs, "timestamp"),
  };
}

function parseTerminalJson(value: string): WorkerInferenceTerminalOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error("Worker inference cached terminal outcome is invalid", { cause: error });
  }
  if (!validateWorkerInferenceTerminalOutcome(parsed)) {
    throw new Error("Worker inference cached terminal outcome is invalid");
  }
  return parsed as WorkerInferenceTerminalOutcome;
}

function serializeTerminalOutcome(outcome: WorkerInferenceTerminalOutcome): string {
  if (!validateWorkerInferenceTerminalOutcome(outcome)) {
    throw new Error("Worker inference terminal outcome is invalid");
  }
  const serialized = JSON.stringify(outcome);
  if (!serialized) {
    throw new Error("Worker inference terminal outcome is not serializable");
  }
  return serialized;
}

const query = (db: DatabaseSync) => getNodeSqliteKysely<InferenceDb>(db);

function findTurn(db: DatabaseSync, input: NormalizedTurnInput): TurnRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_inference_turns")
      .selectAll()
      .where("session_id", "=", input.sessionId)
      .where("run_epoch", "=", input.runEpoch)
      .where("run_id", "=", input.runId)
      .where("turn_id", "=", input.turnId),
  );
}

function findPendingTurn(db: DatabaseSync, input: NormalizedTurnInput): TurnRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_inference_turns")
      .selectAll()
      .where("session_id", "=", input.sessionId)
      .where("run_epoch", "=", input.runEpoch)
      .where("run_id", "=", input.runId)
      .where("state", "=", "pending"),
  );
}

function classifyExistingTurn(
  row: TurnRow | undefined,
  input: NormalizedTurnInput,
): ExistingTurnResult | undefined {
  if (!row) {
    return undefined;
  }
  if (row.environment_id !== input.environmentId || row.request_hash !== input.requestHash) {
    return { kind: "rejected", reason: "conflict" };
  }
  if (row.state === "pending" && row.terminal_json === null) {
    return { kind: "recover" };
  }
  if (row.state === "terminal" && row.terminal_json !== null) {
    return { kind: "replay", outcome: parseTerminalJson(row.terminal_json) };
  }
  throw new Error("Worker inference turn row has invalid terminal state");
}

function insertPendingTurn(db: DatabaseSync, input: NormalizedTurnInput): void {
  const turn: TurnInsert = {
    session_id: input.sessionId,
    run_epoch: input.runEpoch,
    run_id: input.runId,
    turn_id: input.turnId,
    environment_id: input.environmentId,
    request_hash: input.requestHash,
    state: "pending",
    terminal_json: null,
    created_at_ms: input.nowMs,
    updated_at_ms: input.nowMs,
  };
  executeSqliteQuerySync(db, query(db).insertInto("worker_inference_turns").values(turn));
}

function deleteTurn(db: DatabaseSync, row: TurnRow): void {
  executeSqliteQuerySync(
    db,
    query(db)
      .deleteFrom("worker_inference_turns")
      .where("session_id", "=", row.session_id)
      .where("run_epoch", "=", row.run_epoch)
      .where("run_id", "=", row.run_id)
      .where("turn_id", "=", row.turn_id)
      .where("state", "=", "terminal"),
  );
}

function pruneTerminalTurns(params: {
  db: DatabaseSync;
  nowMs: number;
  policy: WorkerInferenceRetentionPolicy;
  preserve?: WorkerInferenceTurnIdentity;
}): void {
  const rows = executeSqliteQuerySync(
    params.db,
    query(params.db)
      .selectFrom("worker_inference_turns")
      .selectAll()
      .where("state", "=", "terminal")
      .orderBy("updated_at_ms", "desc")
      .orderBy("session_id", "asc")
      .orderBy("run_epoch", "desc")
      .orderBy("run_id", "asc")
      .orderBy("turn_id", "asc"),
  ).rows;
  const isPreserved = (row: TurnRow) =>
    params.preserve !== undefined &&
    row.session_id === params.preserve.sessionId &&
    row.run_epoch === params.preserve.runEpoch &&
    row.run_id === params.preserve.runId &&
    row.turn_id === params.preserve.turnId;
  rows.sort((left, right) => Number(isPreserved(right)) - Number(isPreserved(left)));
  const cutoffMs = Math.max(0, params.nowMs - params.policy.maxAgeMs);
  let retainedRows = 0;
  let retainedBytes = 0;
  for (const row of rows) {
    const terminalBytes = Buffer.byteLength(row.terminal_json ?? "", "utf8");
    const preserve = isPreserved(row);
    const expired = row.updated_at_ms < cutoffMs;
    const exceedsRows = retainedRows >= params.policy.maxRows;
    const exceedsBytes = retainedRows > 0 && retainedBytes + terminalBytes > params.policy.maxBytes;
    if (!preserve && (expired || exceedsRows || exceedsBytes)) {
      // Expired identities leave the bounded replay window.
      deleteTurn(params.db, row);
      continue;
    }
    retainedRows += 1;
    retainedBytes += terminalBytes;
  }
}

export function createWorkerInferenceStore(
  options: {
    database?: OpenClawStateDatabase;
    now?: () => number;
    retention?: Partial<WorkerInferenceRetentionPolicy>;
  } = {},
) {
  const path = (options.database ?? openOpenClawStateDatabase()).path;
  const now = options.now ?? Date.now;
  const retention = { ...DEFAULT_RETENTION, ...options.retention };
  const write = <T>(operation: (db: DatabaseSync) => T): T =>
    runOpenClawStateWriteTransaction(({ db }) => operation(db), { path });

  const begin = (rawInput: WorkerInferenceTurnInput): WorkerInferenceTurnBeginResult => {
    const input = normalizeInput(rawInput, now());
    return write<WorkerInferenceTurnBeginResult>((db) => {
      pruneTerminalTurns({ db, nowMs: input.nowMs, policy: retention });
      const existing = classifyExistingTurn(findTurn(db, input), input);
      if (existing) {
        return existing;
      }
      if (findPendingTurn(db, input)) {
        return { kind: "rejected", reason: "conflict" };
      }
      insertPendingTurn(db, input);
      return { kind: "claimed" };
    });
  };

  const complete = (
    rawInput: WorkerInferenceTurnInput & { outcome: WorkerInferenceTerminalOutcome },
  ): WorkerInferenceTerminalOutcome => {
    const input = normalizeInput(rawInput, now());
    const terminalJson = serializeTerminalOutcome(rawInput.outcome);
    return write<WorkerInferenceTerminalOutcome>((db) => {
      const existing = classifyExistingTurn(findTurn(db, input), input);
      if (!existing) {
        throw new Error("Worker inference turn must begin before terminal completion");
      }
      if (existing.kind === "rejected") {
        throw new Error(`Worker inference terminal completion rejected: ${existing.reason}`);
      }
      if (existing.kind === "replay") {
        return existing.outcome;
      }

      const update = executeSqliteQuerySync(
        db,
        query(db)
          .updateTable("worker_inference_turns")
          .set({ state: "terminal", terminal_json: terminalJson, updated_at_ms: input.nowMs })
          .where("session_id", "=", input.sessionId)
          .where("run_epoch", "=", input.runEpoch)
          .where("run_id", "=", input.runId)
          .where("turn_id", "=", input.turnId)
          .where("environment_id", "=", input.environmentId)
          .where("request_hash", "=", input.requestHash)
          .where("state", "=", "pending"),
      );
      if (update.numAffectedRows !== 1n) {
        throw new Error("Worker inference turn changed during terminal completion");
      }
      pruneTerminalTurns({
        db,
        nowMs: input.nowMs,
        policy: retention,
        preserve: input,
      });
      return rawInput.outcome;
    });
  };

  const cancelPending = (params: {
    environmentId: string;
    sessionId: string;
    runEpoch: number;
    runId: string;
    turnId: string;
    outcome: WorkerInferenceTerminalOutcome;
  }): void => {
    const nowMs = nonNegativeInteger(now(), "timestamp");
    const terminalJson = serializeTerminalOutcome(params.outcome);
    const identity = {
      environmentId: required(params.environmentId, "environment id"),
      sessionId: required(params.sessionId, "session id"),
      runEpoch: nonNegativeInteger(params.runEpoch, "run epoch"),
      runId: required(params.runId, "run id"),
      turnId: required(params.turnId, "turn id"),
    };
    write<void>((db) => {
      executeSqliteQuerySync(
        db,
        query(db)
          .updateTable("worker_inference_turns")
          .set({ state: "terminal", terminal_json: terminalJson, updated_at_ms: nowMs })
          .where("session_id", "=", identity.sessionId)
          .where("run_epoch", "=", identity.runEpoch)
          .where("run_id", "=", identity.runId)
          .where("turn_id", "=", identity.turnId)
          .where("environment_id", "=", identity.environmentId)
          .where("state", "=", "pending"),
      );
      pruneTerminalTurns({ db, nowMs, policy: retention, preserve: identity });
    });
  };

  const recoverPending = (outcome: WorkerInferenceTerminalOutcome): void => {
    const nowMs = nonNegativeInteger(now(), "timestamp");
    const terminalJson = serializeTerminalOutcome(outcome);
    write<void>((db) => {
      executeSqliteQuerySync(
        db,
        query(db)
          .updateTable("worker_inference_turns")
          .set({ state: "terminal", terminal_json: terminalJson, updated_at_ms: nowMs })
          .where("state", "=", "pending"),
      );
      pruneTerminalTurns({ db, nowMs, policy: retention });
    });
  };

  return { begin, cancelPending, complete, recoverPending };
}

export type WorkerInferenceStore = ReturnType<typeof createWorkerInferenceStore>;
