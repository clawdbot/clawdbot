/**
 * Persists subagent run records in the shared sqlite state database. The
 * store preserves typed columns for hot delivery state while retaining the
 * normalized payload JSON for forward-compatible record hydration.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql, type Insertable, type Selectable, type Updateable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
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
  | "run_id"
  | "child_session_key"
  | "controller_session_key"
  | "requester_session_key"
  | "model"
  | "run_timeout_seconds"
  | "created_at"
  | "started_at"
  | "session_started_at"
  | "accumulated_runtime_ms"
  | "ended_at"
  | "ended_reason"
  | "cleanup_completed_at"
> & {
  generation: number | null;
  outcome_status: string | null;
  delivery_status: string | null;
  delivery_suspended_at: number | null;
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

function hasCanonicalDeliveryState(value: unknown): value is Record<string, unknown> {
  return (
    hasStateStatus(value, DELIVERY_STATUSES) &&
    !("handoffLeaseId" in value || "handoffLeasedAt" in value || "handoffInjectedAt" in value)
  );
}

function isCanonicalSubagentRunRecord(value: unknown): value is CanonicalSubagentRunRecord {
  return (
    isRecord(value) &&
    hasStateStatus(value.execution, EXECUTION_STATUSES) &&
    isRecord(value.completion) &&
    typeof value.completion.required === "boolean" &&
    hasCanonicalDeliveryState(value.delivery)
  );
}

function jsonStringify(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(raw: string | null): unknown {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function boolToSqlite(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

function normalizeFiniteNumber(value: number | null): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Rehydrates one sqlite row into the normalized subagent run record shape. */
function rowToSubagentRunRecord(row: SubagentRunSqliteRow): SubagentRunRecord | null {
  const payload = parseJson(row.payload_json);
  // SQLite shipped after nested state became canonical; unowned rows are transient.
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
  const delivery = normalized.delivery;
  const completion = normalized.completion;
  const requesterSettleWake = normalized.requesterSettleWake;
  return {
    run_id: normalized.runId,
    child_session_key: normalized.childSessionKey,
    controller_session_key: normalized.controllerSessionKey?.trim() || null,
    requester_session_key: normalized.requesterSessionKey,
    requester_display_key: normalized.requesterDisplayKey,
    requester_origin_json: jsonStringify(normalized.requesterOrigin),
    task: normalized.task,
    task_name: normalized.taskName ?? null,
    cleanup: normalized.cleanup,
    label: normalized.label ?? null,
    model: normalized.model ?? null,
    agent_dir: normalized.agentDir ?? null,
    workspace_dir: normalized.workspaceDir ?? null,
    run_timeout_seconds: normalized.runTimeoutSeconds ?? null,
    spawn_mode: normalized.spawnMode ?? null,
    created_at: normalized.createdAt,
    started_at: normalized.execution.startedAt ?? null,
    session_started_at: normalized.sessionStartedAt ?? null,
    accumulated_runtime_ms: normalized.accumulatedRuntimeMs ?? null,
    ended_at: normalized.execution.endedAt ?? null,
    outcome_json: jsonStringify(normalized.execution.outcome),
    archive_at_ms: normalized.archiveAtMs ?? null,
    cleanup_completed_at: normalized.cleanupCompletedAt ?? null,
    cleanup_handled: boolToSqlite(normalized.cleanupHandled),
    suppress_announce_reason: normalized.suppressAnnounceReason ?? null,
    expects_completion_message: boolToSqlite(normalized.expectsCompletionMessage),
    announce_retry_count: delivery?.attemptCount ?? null,
    last_announce_retry_at: delivery?.lastAttemptAt ?? null,
    last_announce_delivery_error: delivery?.lastError ?? null,
    ended_reason: normalized.endedReason ?? null,
    pause_reason: normalized.pauseReason ?? null,
    wake_on_descendant_settle: boolToSqlite(normalized.wakeOnDescendantSettle),
    requester_settle_wake_status: requesterSettleWake?.status ?? null,
    requester_settle_wake_attempt_count: requesterSettleWake?.attemptCount ?? null,
    requester_settle_wake_replay_count: requesterSettleWake?.replayCount ?? null,
    requester_settle_wake_next_attempt_at: requesterSettleWake?.nextAttemptAt ?? null,
    requester_settle_wake_batch_run_ids_json: jsonStringify(requesterSettleWake?.batchRunIds),
    requester_settle_wake_last_error: requesterSettleWake?.lastError ?? null,
    requester_settle_wake_retire_after: boolToSqlite(requesterSettleWake?.retireAfterSettle),
    frozen_result_text: completion?.resultText ?? null,
    frozen_result_captured_at: completion?.capturedAt ?? null,
    fallback_frozen_result_text: completion?.fallbackResultText ?? null,
    fallback_frozen_result_captured_at: completion?.fallbackCapturedAt ?? null,
    ended_hook_emitted_at: normalized.endedHookEmittedAt ?? null,
    pending_final_delivery: boolToSqlite(
      delivery?.status === "pending" || Boolean(delivery?.payload),
    ),
    pending_final_delivery_created_at: delivery?.createdAt ?? null,
    pending_final_delivery_last_attempt_at: delivery?.lastAttemptAt ?? null,
    pending_final_delivery_attempt_count: delivery?.attemptCount ?? null,
    pending_final_delivery_last_error: delivery?.lastError ?? null,
    pending_final_delivery_payload_json: jsonStringify(delivery?.payload),
    completion_announced_at: delivery?.announcedAt ?? null,
    swarm_group_id: normalized.groupId ?? null,
    swarm_collector: boolToSqlite(normalized.collect),
    swarm_output_schema_json: jsonStringify(normalized.outputSchema),
    swarm_completion_status: normalized.collectorCompletion?.status ?? null,
    swarm_structured_json: jsonStringify(normalized.collectorCompletion?.structured),
    swarm_schema_error: normalized.collectorCompletion?.schemaError ?? null,
    swarm_usage_json: jsonStringify(normalized.collectorCompletion?.usage),
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
        "model",
        "run_timeout_seconds",
        "created_at",
        "started_at",
        "session_started_at",
        "accumulated_runtime_ms",
        "ended_at",
        "ended_reason",
        "cleanup_completed_at",
        subagentPayloadJsonValue<number | null>("$.generation").as("generation"),
        subagentPayloadJsonValue<string | null>("$.execution.outcome.status").as("outcome_status"),
        subagentPayloadJsonValue<string | null>("$.delivery.status").as("delivery_status"),
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
