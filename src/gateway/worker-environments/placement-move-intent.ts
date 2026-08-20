import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { Selectable } from "kysely";
import type { SessionMoveTarget } from "../../../packages/gateway-protocol/src/schema/session-placement.js";
import { WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH } from "../../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import { ensureColumn, tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type {
  DB as StateDatabase,
  WorkerSessionPlacementMoves,
} from "../../state/openclaw-state-db.generated.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { drainWorkerSessionPlacement } from "./placement-drain.js";
import { normalizeEpoch, required, type WorkerSessionPlacementRecord } from "./placement-record.js";
import { getRequired, query, transitionValues } from "./placement-row-codec.js";
import type { PlacementStoreRuntime } from "./placement-runtime.js";
import { boundedWorkerError } from "./worker-error.js";

const MOVE_SCHEMA_START = "CREATE TABLE IF NOT EXISTS worker_session_placement_moves (";
const MOVE_SCHEMA_END = "\n) STRICT;";
const MOVE_OPERATION_PREFIX = "move:v1:";
const MOVE_MACHINE_CLASS_MAX_LENGTH = 128;

type MoveRow = Selectable<WorkerSessionPlacementMoves>;
type MoveDatabase = Pick<
  StateDatabase,
  "worker_environments" | "worker_session_placement_moves" | "worker_session_placements"
>;

export type WorkerPlacementMoveTarget = SessionMoveTarget;

export type WorkerPlacementMoveSource = {
  generation: number;
  environmentId: string;
  ownerEpoch: number;
};

export type WorkerPlacementMoveIntent = {
  operationId: string;
  sessionId: string;
  source: WorkerPlacementMoveSource;
  target: WorkerPlacementMoveTarget;
  lastError: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};

const moveQuery = (db: DatabaseSync) => getNodeSqliteKysely<MoveDatabase>(db);

function moveSchemaSql(): string {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(MOVE_SCHEMA_START);
  const endMarkerStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf(MOVE_SCHEMA_END, start);
  if (start < 0 || endMarkerStart < start) {
    throw new Error("Worker placement move schema marker is missing");
  }
  return OPENCLAW_STATE_SCHEMA_SQL.slice(start, endMarkerStart + MOVE_SCHEMA_END.length);
}

// Single-slot per-handle memo: getPlacementMoves feeds the sessions read
// projection, so the DDL/PRAGMA ensure must not run per read.
const ensuredMoveSchemaHandles = new WeakSet<DatabaseSync>();

function ensureWorkerPlacementMoveSchema(db: DatabaseSync): void {
  if (ensuredMoveSchemaHandles.has(db)) {
    return;
  }
  db.exec(moveSchemaSql()); // sqlite-allow-raw -- Canonical feature-owned additive DDL only.
  // Databases that created this table before the column shipped upgrade in place;
  // the column is bare and nullable, so old readers stay compatible.
  ensureColumn(db, "worker_session_placement_moves", "target_machine_class TEXT");
  ensuredMoveSchemaHandles.add(db);
}

function ensureExistingWorkerPlacementMoveSchema(db: DatabaseSync): boolean {
  if (ensuredMoveSchemaHandles.has(db)) {
    return true;
  }
  // Reads stay lazy: never create the optional table from a read path.
  if (!tableExists(db, "worker_session_placement_moves")) {
    return false;
  }
  ensureWorkerPlacementMoveSchema(db);
  return true;
}

function normalizeGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Worker placement move source generation must be a non-negative integer");
  }
  return value;
}

function boundedIdentifier(
  value: string,
  field: string,
  maximumLength = WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
): string {
  const normalized = required(value, field);
  if (normalized.length > maximumLength) {
    throw new Error(`Worker session placement ${field} exceeds ${maximumLength} characters`);
  }
  return normalized;
}

function normalizeOperationId(value: string): string {
  const operationId = required(value, "move operation id");
  if (!operationId.startsWith(MOVE_OPERATION_PREFIX) || operationId.length > 128) {
    throw new Error("Worker session placement move operation id is invalid");
  }
  return operationId;
}

function normalizeWorkerPlacementMoveTarget(
  target: WorkerPlacementMoveTarget,
): WorkerPlacementMoveTarget {
  switch (target.kind) {
    case "gateway":
      return { kind: "gateway" };
    case "profile": {
      const machineClass = target.machineClass;
      return {
        kind: "profile",
        profileId: boundedIdentifier(target.profileId, "move profile id"),
        ...(machineClass === undefined
          ? {}
          : {
              machineClass: boundedIdentifier(
                machineClass,
                "move machine class",
                MOVE_MACHINE_CLASS_MAX_LENGTH,
              ),
            }),
      };
    }
    case "device":
      return { kind: "device", deviceId: boundedIdentifier(target.deviceId, "move device id") };
  }
  throw new Error("Worker placement move target is invalid");
}

function normalizeWorkerPlacementMoveSource(
  source: WorkerPlacementMoveSource,
): WorkerPlacementMoveSource {
  return {
    generation: normalizeGeneration(source.generation),
    environmentId: boundedIdentifier(source.environmentId, "move source environment id"),
    ownerEpoch: normalizeEpoch(source.ownerEpoch, "move source owner epoch"),
  };
}

function targetValues(target: WorkerPlacementMoveTarget): {
  target_kind: MoveRow["target_kind"];
  target_id: MoveRow["target_id"];
  target_machine_class: MoveRow["target_machine_class"];
} {
  switch (target.kind) {
    case "gateway":
      return { target_kind: target.kind, target_id: null, target_machine_class: null };
    case "profile":
      return {
        target_kind: target.kind,
        target_id: target.profileId,
        target_machine_class: target.machineClass ?? null,
      };
    case "device":
      return { target_kind: target.kind, target_id: target.deviceId, target_machine_class: null };
  }
  throw new Error("Worker placement move target is invalid");
}

function fromRow(row: MoveRow): WorkerPlacementMoveIntent {
  const source = normalizeWorkerPlacementMoveSource({
    generation: row.source_generation,
    environmentId: row.source_environment_id,
    ownerEpoch: row.source_owner_epoch,
  });
  let target: WorkerPlacementMoveTarget;
  if (row.target_kind !== "profile" && row.target_machine_class !== null) {
    throw new Error(`Invalid worker placement move target: ${row.target_kind}`);
  }
  if (row.target_kind === "gateway" && row.target_id === null) {
    target = { kind: "gateway" };
  } else if (row.target_kind === "profile" && row.target_id !== null) {
    target = {
      kind: "profile",
      profileId: boundedIdentifier(row.target_id, "move profile id"),
      ...(row.target_machine_class === null
        ? {}
        : {
            machineClass: boundedIdentifier(
              row.target_machine_class,
              "move machine class",
              MOVE_MACHINE_CLASS_MAX_LENGTH,
            ),
          }),
    };
  } else if (row.target_kind === "device" && row.target_id !== null) {
    target = { kind: "device", deviceId: boundedIdentifier(row.target_id, "move device id") };
  } else {
    throw new Error(`Invalid worker placement move target: ${row.target_kind}`);
  }
  return {
    operationId: normalizeOperationId(row.operation_id),
    sessionId: required(row.session_id, "move session id"),
    source,
    target,
    lastError: row.last_error,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function findMoveRowBySession(db: DatabaseSync, sessionId: string): MoveRow | undefined {
  if (!ensureExistingWorkerPlacementMoveSchema(db)) {
    return undefined;
  }
  return executeSqliteQueryTakeFirstSync(
    db,
    moveQuery(db)
      .selectFrom("worker_session_placement_moves")
      .selectAll()
      .where("session_id", "=", sessionId),
  );
}

function findMoveRowByOperation(db: DatabaseSync, operationId: string): MoveRow | undefined {
  if (!ensureExistingWorkerPlacementMoveSchema(db)) {
    return undefined;
  }
  return executeSqliteQueryTakeFirstSync(
    db,
    moveQuery(db)
      .selectFrom("worker_session_placement_moves")
      .selectAll()
      .where("operation_id", "=", operationId),
  );
}

function requireExactMove(
  db: DatabaseSync,
  input: { operationId: string; sessionId: string },
): WorkerPlacementMoveIntent {
  const operationId = normalizeOperationId(input.operationId);
  const sessionId = required(input.sessionId, "move session id");
  const row = findMoveRowByOperation(db, operationId);
  if (!row || row.session_id !== sessionId) {
    throw new Error(`Session ${sessionId} placement move changed before completion`);
  }
  return fromRow(row);
}

function deleteExactMove(db: DatabaseSync, intent: WorkerPlacementMoveIntent): void {
  const values = targetValues(intent.target);
  let statement = moveQuery(db)
    .deleteFrom("worker_session_placement_moves")
    .where("operation_id", "=", intent.operationId)
    .where("session_id", "=", intent.sessionId)
    .where("source_generation", "=", intent.source.generation)
    .where("source_environment_id", "=", intent.source.environmentId)
    .where("source_owner_epoch", "=", intent.source.ownerEpoch)
    .where("target_kind", "=", values.target_kind);
  statement =
    values.target_id === null
      ? statement.where("target_id", "is", null)
      : statement.where("target_id", "=", values.target_id);
  statement =
    values.target_machine_class === null
      ? statement.where("target_machine_class", "is", null)
      : statement.where("target_machine_class", "=", values.target_machine_class);
  const result = executeSqliteQuerySync(db, statement);
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Session ${intent.sessionId} placement move changed before completion`);
  }
}

function requireExactAttachedEnvironment(
  db: DatabaseSync,
  input: {
    sessionId: string;
    environmentId: string;
    ownerEpoch: number;
    profileId?: string;
  },
): void {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    moveQuery(db)
      .selectFrom("worker_environments")
      .select(["state", "owner_epoch", "profile_id", "attached_session_ids_json"])
      .where("environment_id", "=", input.environmentId),
  );
  let attachedSessionIds: unknown;
  try {
    attachedSessionIds = row ? (JSON.parse(row.attached_session_ids_json) as unknown) : undefined;
  } catch {
    attachedSessionIds = undefined;
  }
  if (
    !row ||
    row.state !== "attached" ||
    row.owner_epoch !== input.ownerEpoch ||
    (input.profileId !== undefined && row.profile_id !== input.profileId) ||
    !Array.isArray(attachedSessionIds) ||
    attachedSessionIds.length !== 1 ||
    attachedSessionIds[0] !== input.sessionId
  ) {
    throw new Error(`Cannot move stale worker environment for session ${input.sessionId}`);
  }
}

export function createPlacementMoveOps(runtime: PlacementStoreRuntime) {
  const { read, write, now } = runtime;
  return {
    getPlacementMove(sessionId: string): WorkerPlacementMoveIntent | undefined {
      const row = findMoveRowBySession(read(), required(sessionId, "move session id"));
      return row ? fromRow(row) : undefined;
    },

    getPlacementMoves(
      sessionIds: readonly string[],
    ): ReadonlyMap<string, WorkerPlacementMoveIntent> {
      const normalizedIds = [
        ...new Set(sessionIds.map((sessionId) => required(sessionId, "move session id"))),
      ];
      const results = new Map<string, WorkerPlacementMoveIntent>();
      const db = read();
      if (!ensureExistingWorkerPlacementMoveSchema(db)) {
        return results;
      }
      for (let offset = 0; offset < normalizedIds.length; offset += 250) {
        const chunk = normalizedIds.slice(offset, offset + 250);
        for (const row of executeSqliteQuerySync(
          db,
          moveQuery(db)
            .selectFrom("worker_session_placement_moves")
            .selectAll()
            .where("session_id", "in", chunk),
        ).rows) {
          const intent = fromRow(row);
          results.set(intent.sessionId, intent);
        }
      }
      return results;
    },

    listPlacementMoves(): WorkerPlacementMoveIntent[] {
      const db = read();
      if (!ensureExistingWorkerPlacementMoveSchema(db)) {
        return [];
      }
      return executeSqliteQuerySync(
        db,
        moveQuery(db)
          .selectFrom("worker_session_placement_moves")
          .selectAll()
          .orderBy("created_at_ms")
          .orderBy("session_id"),
      ).rows.map(fromRow);
    },

    beginPlacementMove(input: {
      sessionId: string;
      source: WorkerPlacementMoveSource;
      target: WorkerPlacementMoveTarget;
    }): {
      intent: WorkerPlacementMoveIntent;
      placement: WorkerSessionPlacementRecord;
      joined: boolean;
    } {
      const sessionId = required(input.sessionId, "move session id");
      const source = normalizeWorkerPlacementMoveSource(input.source);
      const target = normalizeWorkerPlacementMoveTarget(input.target);
      const operationId = `${MOVE_OPERATION_PREFIX}${generateSecureToken(32)}`;
      return write((db) => {
        const existingRow = findMoveRowBySession(db, sessionId);
        if (existingRow) {
          const existing = fromRow(existingRow);
          if (
            !isDeepStrictEqual(existing.source, source) ||
            !isDeepStrictEqual(existing.target, target)
          ) {
            throw new Error(`Session ${sessionId} already has a conflicting placement move`);
          }
          return { intent: existing, placement: getRequired(db, sessionId), joined: true };
        }
        const current = getRequired(db, sessionId);
        if (
          current.state !== "active" ||
          current.generation !== source.generation ||
          current.environmentId !== source.environmentId ||
          current.activeOwnerEpoch !== source.ownerEpoch
        ) {
          throw new Error(`Cannot move stale worker placement for session ${sessionId}`);
        }
        requireExactAttachedEnvironment(db, { sessionId, ...source });
        ensureWorkerPlacementMoveSchema(db);
        const timestamp = now();
        const row: MoveRow = {
          operation_id: operationId,
          session_id: sessionId,
          source_generation: source.generation,
          source_environment_id: source.environmentId,
          source_owner_epoch: source.ownerEpoch,
          ...targetValues(target),
          last_error: null,
          created_at_ms: timestamp,
          updated_at_ms: timestamp,
        };
        executeSqliteQuerySync(
          db,
          moveQuery(db).insertInto("worker_session_placement_moves").values(row),
        );
        const placement = drainWorkerSessionPlacement(
          db,
          {
            sessionId,
            environmentId: source.environmentId,
            ownerEpoch: source.ownerEpoch,
            expectedGeneration: source.generation,
          },
          timestamp,
        );
        return { intent: fromRow(row), placement, joined: false };
      });
    },

    recordPlacementMoveError(input: {
      operationId: string;
      sessionId: string;
      error: string;
    }): boolean {
      return write((db) => {
        const row = findMoveRowByOperation(db, normalizeOperationId(input.operationId));
        if (!row || row.session_id !== required(input.sessionId, "move session id")) {
          return false;
        }
        const intent = fromRow(row);
        const values = targetValues(intent.target);
        let statement = moveQuery(db)
          .updateTable("worker_session_placement_moves")
          .set({ last_error: boundedWorkerError(input.error), updated_at_ms: now() })
          .where("operation_id", "=", intent.operationId)
          .where("session_id", "=", intent.sessionId)
          .where("source_generation", "=", intent.source.generation)
          .where("source_environment_id", "=", intent.source.environmentId)
          .where("source_owner_epoch", "=", intent.source.ownerEpoch)
          .where("target_kind", "=", values.target_kind);
        statement =
          values.target_id === null
            ? statement.where("target_id", "is", null)
            : statement.where("target_id", "=", values.target_id);
        statement =
          values.target_machine_class === null
            ? statement.where("target_machine_class", "is", null)
            : statement.where("target_machine_class", "=", values.target_machine_class);
        return executeSqliteQuerySync(db, statement).numAffectedRows === 1n;
      });
    },

    cancelPlacementMove(input: { operationId: string; sessionId: string }): void {
      write((db) => {
        deleteExactMove(db, requireExactMove(db, input));
      });
    },

    completePlacementMoveSourceToLocal(input: {
      operationId: string;
      sessionId: string;
      expectedGeneration: number;
    }): WorkerSessionPlacementRecord {
      return write((db) => {
        const intent = requireExactMove(db, input);
        const current = getRequired(db, intent.sessionId);
        if (
          current.state !== "reconciling" ||
          current.generation !== input.expectedGeneration ||
          current.environmentId !== intent.source.environmentId ||
          current.activeOwnerEpoch !== intent.source.ownerEpoch
        ) {
          throw new Error(
            `Cannot complete stale Gateway placement move for session ${intent.sessionId}`,
          );
        }
        const values = transitionValues(current, "local", {}, now());
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_session_placements")
            .set(values)
            .where("session_id", "=", intent.sessionId)
            .where("state", "=", "reconciling")
            .where("transition_generation", "=", current.generation)
            .where("environment_id", "=", intent.source.environmentId)
            .where("active_owner_epoch", "=", intent.source.ownerEpoch)
            .where("turn_claim_owner", "is", null),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Session ${intent.sessionId} changed during Gateway placement move`);
        }
        if (intent.target.kind === "gateway") {
          deleteExactMove(db, intent);
        }
        return getRequired(db, intent.sessionId);
      });
    },

    completePlacementMoveToWorker(input: {
      operationId: string;
      sessionId: string;
      expectedGeneration: number;
      environmentId: string;
      ownerEpoch: number;
    }): WorkerSessionPlacementRecord {
      const environmentId = boundedIdentifier(
        input.environmentId,
        "move destination environment id",
      );
      const ownerEpoch = normalizeEpoch(input.ownerEpoch, "move destination owner epoch");
      return write((db) => {
        const intent = requireExactMove(db, input);
        if (intent.target.kind === "gateway") {
          throw new Error(`Session ${intent.sessionId} placement move target is not a worker`);
        }
        const current = getRequired(db, intent.sessionId);
        if (
          current.state !== "active" ||
          current.generation !== input.expectedGeneration ||
          current.environmentId !== environmentId ||
          current.activeOwnerEpoch !== ownerEpoch
        ) {
          throw new Error(
            `Cannot complete stale worker placement move for session ${intent.sessionId}`,
          );
        }
        const profileId =
          intent.target.kind === "profile"
            ? intent.target.profileId
            : `device:${intent.target.deviceId}`;
        requireExactAttachedEnvironment(db, {
          sessionId: intent.sessionId,
          environmentId,
          ownerEpoch,
          profileId,
        });
        deleteExactMove(db, intent);
        return current;
      });
    },
  };
}
