import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type {
  DB as StateDatabase,
  WorkerSessionPlacementMoves,
} from "../../state/openclaw-state-db.generated.js";
import { normalizeEpoch, required } from "./placement-record.js";

export type WorkerPlacementMoveTarget =
  | { kind: "gateway" }
  | { kind: "profile"; profileId: string }
  | { kind: "device"; deviceId: string };

export type WorkerPlacementMoveSource = {
  generation: number;
  environmentId: string;
  ownerEpoch: number;
};

export type WorkerPlacementMoveIntent = {
  sessionId: string;
  source: WorkerPlacementMoveSource;
  target: WorkerPlacementMoveTarget;
  lastError: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};

type MoveRow = Selectable<WorkerSessionPlacementMoves>;
type MoveDatabase = Pick<StateDatabase, "worker_session_placement_moves">;

export const moveQuery = (db: DatabaseSync) => getNodeSqliteKysely<MoveDatabase>(db);

function normalizeGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Worker placement move source generation must be a non-negative integer");
  }
  return value;
}

export function normalizeWorkerPlacementMoveTarget(
  target: WorkerPlacementMoveTarget,
): WorkerPlacementMoveTarget {
  switch (target.kind) {
    case "gateway":
      return { kind: "gateway" };
    case "profile":
      return { kind: "profile", profileId: required(target.profileId, "move profile id") };
    case "device":
      return { kind: "device", deviceId: required(target.deviceId, "move device id") };
  }
}

export function normalizeWorkerPlacementMoveSource(
  source: WorkerPlacementMoveSource,
): WorkerPlacementMoveSource {
  return {
    generation: normalizeGeneration(source.generation),
    environmentId: required(source.environmentId, "move source environment id"),
    ownerEpoch: normalizeEpoch(source.ownerEpoch, "move source owner epoch"),
  };
}

function targetValues(target: WorkerPlacementMoveTarget): {
  target_kind: MoveRow["target_kind"];
  target_id: MoveRow["target_id"];
} {
  switch (target.kind) {
    case "gateway":
      return { target_kind: target.kind, target_id: null };
    case "profile":
      return { target_kind: target.kind, target_id: target.profileId };
    case "device":
      return { target_kind: target.kind, target_id: target.deviceId };
  }
}

function fromRow(row: MoveRow): WorkerPlacementMoveIntent {
  const source = normalizeWorkerPlacementMoveSource({
    generation: row.source_generation,
    environmentId: row.source_environment_id,
    ownerEpoch: row.source_owner_epoch,
  });
  let target: WorkerPlacementMoveTarget;
  if (row.target_kind === "gateway" && row.target_id === null) {
    target = { kind: "gateway" };
  } else if (row.target_kind === "profile" && row.target_id !== null) {
    target = { kind: "profile", profileId: required(row.target_id, "move profile id") };
  } else if (row.target_kind === "device" && row.target_id !== null) {
    target = { kind: "device", deviceId: required(row.target_id, "move device id") };
  } else {
    throw new Error(`Invalid worker placement move target: ${row.target_kind}`);
  }
  return {
    sessionId: required(row.session_id, "move session id"),
    source,
    target,
    lastError: row.last_error,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

export function findWorkerPlacementMoveIntent(
  db: DatabaseSync,
  sessionId: string,
): WorkerPlacementMoveIntent | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    moveQuery(db)
      .selectFrom("worker_session_placement_moves")
      .selectAll()
      .where("session_id", "=", sessionId),
  );
  return row ? fromRow(row) : undefined;
}

export function listWorkerPlacementMoveIntents(db: DatabaseSync): WorkerPlacementMoveIntent[] {
  return executeSqliteQuerySync(
    db,
    moveQuery(db)
      .selectFrom("worker_session_placement_moves")
      .selectAll()
      .orderBy("created_at_ms")
      .orderBy("session_id"),
  ).rows.map(fromRow);
}

export function insertWorkerPlacementMoveIntent(
  db: DatabaseSync,
  input: {
    sessionId: string;
    source: WorkerPlacementMoveSource;
    target: WorkerPlacementMoveTarget;
    nowMs: number;
  },
): void {
  const sessionId = required(input.sessionId, "move session id");
  const source = normalizeWorkerPlacementMoveSource(input.source);
  const target = normalizeWorkerPlacementMoveTarget(input.target);
  const result = executeSqliteQuerySync(
    db,
    moveQuery(db)
      .insertInto("worker_session_placement_moves")
      .values({
        session_id: sessionId,
        source_generation: source.generation,
        source_environment_id: source.environmentId,
        source_owner_epoch: source.ownerEpoch,
        ...targetValues(target),
        last_error: null,
        created_at_ms: input.nowMs,
        updated_at_ms: input.nowMs,
      })
      .onConflict((conflict) => conflict.column("session_id").doNothing()),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Session ${sessionId} already has a placement move`);
  }
}

export function deleteWorkerPlacementMoveIntent(db: DatabaseSync, sessionId: string): void {
  const result = executeSqliteQuerySync(
    db,
    moveQuery(db)
      .deleteFrom("worker_session_placement_moves")
      .where("session_id", "=", sessionId),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Session ${sessionId} placement move changed before completion`);
  }
}
