/**
 * Persists subagent run records in the shared sqlite state database, with
 * query-bearing identity columns indexing canonical normalized payload JSON.
 */
import { safeParseJson } from "@openclaw/normalization-core";
import { asFiniteNumber as normalizeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql, type Insertable, type Selectable, type Updateable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import type { SubagentRunReadRecord, SubagentRunRecord } from "./subagent-registry.types.js";

type SubagentRunsTable = OpenClawStateKyselyDatabase["subagent_runs"];
type SubagentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "subagent_runs">;
type SubagentRunSqliteRow = Selectable<SubagentRunsTable>;
type BoundSubagentRunRecord = Insertable<SubagentRunsTable>;
type SubagentRunSqliteInsert = BoundSubagentRunRecord;
type SubagentRunSqliteUpdate = Updateable<SubagentRunsTable>;
type SubagentRunReadSqliteRow = Pick<
  SubagentRunSqliteRow,
  "run_id" | "child_session_key" | "controller_session_key" | "requester_session_key" | "created_at"
> & {
  model: string | null;
  run_timeout_seconds: number | null;
  started_at: number | null;
  session_started_at: number | null;
  accumulated_runtime_ms: number | null;
  ended_at: number | null;
  ended_reason: string | null;
  cleanup_completed_at: number | null;
  generation: number | null;
  outcome_status: string | null;
  delivery_status: string | null;
  delivery_suspended_at: number | null;
  requester_agent_id: string | null;
};
type CanonicalSubagentRunRecord = SubagentRunRecord &
  Required<Pick<SubagentRunRecord, "completion" | "delivery">>;
const EXECUTION_STATUSES = new Set("queued running interrupted terminal".split(" "));
const DELIVERY_STATUSES = new Set(
  "not_required pending in_progress delivered failed suspended discarded".split(" "),
);

function hasStateStatus(
  value: unknown,
  statuses: ReadonlySet<string>,
): value is Record<string, unknown> {
  return isRecord(value) && typeof value.status === "string" && statuses.has(value.status);
}

function isCanonicalSubagentRunRecord(value: unknown): value is CanonicalSubagentRunRecord {
  return (
    isRecord(value) &&
    hasStateStatus(value.execution, EXECUTION_STATUSES) &&
    isRecord(value.completion) &&
    typeof value.completion.required === "boolean" &&
    hasStateStatus(value.delivery, DELIVERY_STATUSES) &&
    !(
      "handoffLeaseId" in value.delivery ||
      "handoffLeasedAt" in value.delivery ||
      "handoffInjectedAt" in value.delivery
    )
  );
}

function parseJson(raw: string | null): unknown {
  return raw ? safeParseJson(raw) : undefined;
}

/** Rehydrates one sqlite row into the normalized subagent run record shape. */
function rowToSubagentRunRecord(row: SubagentRunSqliteRow): SubagentRunRecord | null {
  const payload = parseJson(row.payload_json);
  if (!isCanonicalSubagentRunRecord(payload)) {
    return null;
  }
  // This module owns every production write and commits indexed columns with
  // this complete payload atomically; rehydrating both created competing state.
  payload.runId = row.run_id;
  payload.childSessionKey = row.child_session_key;
  payload.requesterSessionKey = row.requester_session_key;
  const controllerSessionKey = row.controller_session_key?.trim();
  if (controllerSessionKey) {
    payload.controllerSessionKey = controllerSessionKey;
  } else {
    delete payload.controllerSessionKey;
  }
  if (payload.requesterOrigin) {
    payload.requesterOrigin = normalizeDeliveryContext(payload.requesterOrigin);
  }
  if (payload.expectsCompletionMessage === false) {
    payload.delivery.status = "not_required";
  }
  const record = normalizeSubagentRunState(payload);
  return record.runId && record.childSessionKey && record.requesterSessionKey ? record : null;
}

/** Canonically serializes a run before an outer transaction acquires the write lock. */
export function bindSubagentRunRecord(entry: SubagentRunRecord): BoundSubagentRunRecord {
  const normalized = normalizeSubagentRunState(structuredClone(entry));
  if (!isCanonicalSubagentRunRecord(normalized)) {
    throw new Error("subagent run is missing canonical nested state");
  }
  return {
    run_id: normalized.runId,
    child_session_key: normalized.childSessionKey,
    controller_session_key: normalized.controllerSessionKey?.trim() || null,
    requester_session_key: normalized.requesterSessionKey,
    created_at: normalized.createdAt,
    payload_json: JSON.stringify(normalized),
  };
}

/** Upserts a prebound run on the exact supplied shared-state handle. */
export function upsertSubagentRunRowInDatabase(
  database: OpenClawStateDatabase,
  row: BoundSubagentRunRecord,
): void {
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    stateDb
      .insertInto("subagent_runs")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("run_id").doUpdateSet(subagentRunRecordToSqliteUpdate(row)),
      ),
  );
}

function subagentRunRecordToSqliteUpdate(values: SubagentRunSqliteInsert): SubagentRunSqliteUpdate {
  const { run_id: _runId, ...update } = values;
  return update;
}

function writeSubagentRunValues(
  values: readonly SubagentRunSqliteInsert[],
  deleteRunIds?: readonly string[],
  retainedRunIds?: readonly string[],
): void {
  if (values.length === 0 && deleteRunIds?.length === 0 && retainedRunIds === undefined) {
    return;
  }
  runOpenClawStateWriteTransaction((database) => {
    const { db } = database;
    const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
    for (const row of values) {
      upsertSubagentRunRowInDatabase(database, row);
    }
    if (retainedRunIds !== undefined) {
      const deleteQuery =
        retainedRunIds.length === 0
          ? stateDb.deleteFrom("subagent_runs")
          : stateDb.deleteFrom("subagent_runs").where("run_id", "not in", retainedRunIds);
      executeSqliteQuerySync(db, deleteQuery);
      return;
    }
    if (deleteRunIds && deleteRunIds.length > 0) {
      executeSqliteQuerySync(
        db,
        stateDb.deleteFrom("subagent_runs").where("run_id", "in", deleteRunIds),
      );
    }
  });
}

type SubagentRegistryReadScope =
  | { kind: "controller"; sessionKey: string }
  | { kind: "child"; sessionKey: string };

function readSubagentRegistryRows(scope?: SubagentRegistryReadScope): SubagentRunSqliteRow[] {
  const { db } = openOpenClawStateDatabase();
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
  let query = stateDb.selectFrom("subagent_runs").selectAll();
  if (scope?.kind === "child") {
    query = query.where("child_session_key", "=", scope.sessionKey);
  } else if (scope?.kind === "controller") {
    // The writer trims controller keys; older null/empty rows belong to their requester.
    query = query.where((eb) =>
      eb.or([
        eb("controller_session_key", "=", scope.sessionKey),
        eb.and([
          eb.or([eb("controller_session_key", "is", null), eb("controller_session_key", "=", "")]),
          eb("requester_session_key", "=", scope.sessionKey),
        ]),
      ]),
    );
  }
  return executeSqliteQuerySync(db, query.orderBy("created_at", "asc").orderBy("run_id", "asc"))
    .rows;
}

function subagentPayloadJsonValue<T>(path: string) {
  return /* kysely-allow-raw: SQLite JSON1 projects bounded fields from the canonical payload column. */ sql<T>`json_extract(payload_json, ${path})`;
}

function canonicalSubagentPayloadFilter() {
  return /* kysely-allow-raw: Keep projection eligibility identical to the full canonical payload parser. */ sql<boolean>`json_valid(payload_json)
    AND json_type(payload_json, '$.execution') = 'object'
    AND json_extract(payload_json, '$.execution.status')
      IN ('queued', 'running', 'interrupted', 'terminal')
    AND json_type(payload_json, '$.completion') = 'object'
    AND json_type(payload_json, '$.completion.required') IN ('true', 'false')
    AND json_type(payload_json, '$.delivery') = 'object'
    AND json_extract(payload_json, '$.delivery.status')
      IN (
        'not_required',
        'pending',
        'in_progress',
        'delivered',
        'failed',
        'suspended',
        'discarded'
      )
    AND json_type(payload_json, '$.delivery.handoffLeaseId') IS NULL
    AND json_type(payload_json, '$.delivery.handoffLeasedAt') IS NULL
    AND json_type(payload_json, '$.delivery.handoffInjectedAt') IS NULL`;
}

function readSubagentSessionListRows(): SubagentRunReadSqliteRow[] {
  const { db } = openOpenClawStateDatabase();
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
  return executeSqliteQuerySync(
    db,
    stateDb
      .selectFrom("subagent_runs")
      .select([
        "run_id",
        "child_session_key",
        "controller_session_key",
        "requester_session_key",
        "created_at",
        subagentPayloadJsonValue<string | null>("$.model").as("model"),
        subagentPayloadJsonValue<number | null>("$.runTimeoutSeconds").as("run_timeout_seconds"),
        subagentPayloadJsonValue<number | null>("$.execution.startedAt").as("started_at"),
        subagentPayloadJsonValue<number | null>("$.sessionStartedAt").as("session_started_at"),
        subagentPayloadJsonValue<number | null>("$.accumulatedRuntimeMs").as(
          "accumulated_runtime_ms",
        ),
        subagentPayloadJsonValue<number | null>("$.execution.endedAt").as("ended_at"),
        subagentPayloadJsonValue<string | null>("$.endedReason").as("ended_reason"),
        subagentPayloadJsonValue<number | null>("$.cleanupCompletedAt").as("cleanup_completed_at"),
        subagentPayloadJsonValue<number | null>("$.generation").as("generation"),
        subagentPayloadJsonValue<string | null>("$.execution.outcome.status").as("outcome_status"),
        subagentPayloadJsonValue<string | null>("$.delivery.status").as("delivery_status"),
        subagentPayloadJsonValue<string | null>("$.requesterAgentId").as("requester_agent_id"),
        subagentPayloadJsonValue<number | null>("$.delivery.suspendedAt").as(
          "delivery_suspended_at",
        ),
      ])
      // Keep the projection aligned with the canonical full-registry row filter
      // without transferring and parsing the retained payload in JavaScript.
      .where(canonicalSubagentPayloadFilter())
      .orderBy("created_at", "asc")
      .orderBy("run_id", "asc"),
  ).rows as SubagentRunReadSqliteRow[];
}

function rowToSubagentRunReadRecord(row: SubagentRunReadSqliteRow): SubagentRunReadRecord | null {
  const runId = row.run_id.trim();
  const childSessionKey = row.child_session_key.trim();
  const requesterSessionKey = row.requester_session_key.trim();
  if (!runId || !childSessionKey || !requesterSessionKey) {
    return null;
  }
  const outcomeStatus =
    row.outcome_status === "ok" ||
    row.outcome_status === "error" ||
    row.outcome_status === "timeout" ||
    row.outcome_status === "unknown"
      ? row.outcome_status
      : undefined;
  const deliveryStatus = DELIVERY_STATUSES.has(row.delivery_status ?? "")
    ? (row.delivery_status as NonNullable<SubagentRunRecord["delivery"]>["status"])
    : undefined;
  const startedAt = normalizeFiniteNumber(row.started_at);
  const endedAt = normalizeFiniteNumber(row.ended_at);
  return Object.fromEntries(
    Object.entries({
      runId,
      childSessionKey,
      controllerSessionKey: row.controller_session_key?.trim() || undefined,
      requesterSessionKey,
      requesterAgentId: row.requester_agent_id?.trim() || undefined,
      model: row.model || undefined,
      generation: normalizeFiniteNumber(row.generation),
      createdAt: row.created_at,
      execution: {
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(endedAt !== undefined ? { endedAt } : {}),
        ...(outcomeStatus ? { outcome: { status: outcomeStatus } } : {}),
      },
      sessionStartedAt: normalizeFiniteNumber(row.session_started_at),
      accumulatedRuntimeMs: normalizeFiniteNumber(row.accumulated_runtime_ms),
      runTimeoutSeconds: normalizeFiniteNumber(row.run_timeout_seconds),
      endedReason: row.ended_reason || undefined,
      cleanupCompletedAt: normalizeFiniteNumber(row.cleanup_completed_at),
      delivery: deliveryStatus
        ? {
            status: deliveryStatus,
            ...(normalizeFiniteNumber(row.delivery_suspended_at) !== undefined
              ? { suspendedAt: row.delivery_suspended_at ?? undefined }
              : {}),
          }
        : undefined,
    }).filter(([, value]) => value !== undefined),
  ) as SubagentRunReadRecord;
}

function loadScopedSubagentRuns(scope: SubagentRegistryReadScope): SubagentRunRecord[] {
  const key = scope.sessionKey.trim();
  if (!key) {
    return [];
  }
  return readSubagentRegistryRows({ ...scope, sessionKey: key }).flatMap((row) => {
    const run = rowToSubagentRunRecord(row);
    return run ? [run] : [];
  });
}

/** Loads runs controlled by one session, preserving the legacy requester fallback. */
export function loadSubagentRunsForControllerFromSqlite(
  controllerSessionKey: string,
): SubagentRunRecord[] {
  return loadScopedSubagentRuns({ kind: "controller", sessionKey: controllerSessionKey });
}

/** Loads all persisted generations for one child session through its existing index. */
export function loadSubagentRunsForChildSessionFromSqlite(
  childSessionKey: string,
): SubagentRunRecord[] {
  return loadScopedSubagentRuns({ kind: "child", sessionKey: childSessionKey });
}

/** Loads the canonical subagent registry from shared SQLite state. */
export function loadSubagentRegistryFromSqlite(): Map<string, SubagentRunRecord> {
  // Retired file-era runs are intentionally not recovered here: after SQLite
  // pruning, the file cannot prove whether a run is live or stale. Doctor owns discard.
  const runs = new Map<string, SubagentRunRecord>();
  for (const row of readSubagentRegistryRows()) {
    const entry = rowToSubagentRunRecord(row);
    if (entry) {
      runs.set(entry.runId, entry);
    }
  }
  return runs;
}

/** Loads only the canonical fields needed to build session-list topology metadata. */
export function loadSubagentSessionListRunsFromSqlite(): Map<string, SubagentRunReadRecord> {
  const runs = new Map<string, SubagentRunReadRecord>();
  for (const row of readSubagentSessionListRows()) {
    const entry = rowToSubagentRunReadRecord(row);
    if (entry) {
      runs.set(entry.runId, entry);
    }
  }
  return runs;
}

/** Saves the complete subagent run snapshot to sqlite and prunes rows not in the snapshot. */
export function saveSubagentRegistryToSqlite(runs: Map<string, SubagentRunRecord>): void {
  const values = [...runs.values()].map(bindSubagentRunRecord);
  writeSubagentRunValues(
    values,
    undefined,
    values.map((row) => row.run_id),
  );
}

/** Persists only named run mutations, deleting names absent from the current registry. */
export function saveSubagentRegistryChangesToSqlite(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[],
): void {
  const runIds = [...new Set(changedRunIds.map((runId) => runId.trim()).filter(Boolean))];
  const values: SubagentRunSqliteInsert[] = [];
  const deleteRunIds: string[] = [];
  for (const runId of runIds) {
    const entry = runs.get(runId);
    if (entry) {
      values.push(bindSubagentRunRecord(entry));
    } else {
      deleteRunIds.push(runId);
    }
  }
  writeSubagentRunValues(values, deleteRunIds);
}
