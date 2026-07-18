/**
 * Persists subagent run records in the shared sqlite state database. The
 * store preserves typed columns for hot delivery state while retaining the
 * normalized payload JSON for forward-compatible record hydration.
 */
import type { Insertable, Selectable, Updateable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import type {
  PendingFinalDeliveryPayload,
  RequesterSettleWakeState,
  SubagentCompletionDeliveryState,
  SubagentCompletionState,
  SubagentExecutionState,
  SubagentRunRecord,
} from "./subagent-registry.types.js";

type SubagentRunsTable = OpenClawStateKyselyDatabase["subagent_runs"];
type SubagentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "subagent_runs">;
type SubagentRunSqliteRow = Selectable<SubagentRunsTable>;
type SubagentRunSqliteInsert = Insertable<SubagentRunsTable>;
type SubagentRunSqliteUpdate = Updateable<SubagentRunsTable>;

/** Converts undefined to null so optional record fields round-trip through sqlite columns. */
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

function sqliteBool(value: number | null): boolean | undefined {
  return value == null ? undefined : value !== 0;
}

function normalizeFiniteNumber(value: number | null): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function createDeliveryFromTypedColumns(
  row: SubagentRunSqliteRow,
  fallback: SubagentCompletionDeliveryState | undefined,
): SubagentCompletionDeliveryState | undefined {
  // Typed delivery columns are authoritative for retry/delivered state while
  // payload_json keeps compatibility with older fields during migration.
  const delivery = fallback ? { ...fallback } : undefined;
  const payload = parseJson(row.pending_final_delivery_payload_json) as
    | PendingFinalDeliveryPayload
    | undefined;
  const status =
    row.expects_completion_message === 0
      ? "not_required"
      : row.pending_final_delivery
        ? "pending"
        : delivery?.status;
  if (!status && row.completion_announced_at == null && row.last_announce_delivery_error == null) {
    return delivery;
  }
  return {
    status: status ?? "pending",
    ...delivery,
    ...(payload ? { payload } : {}),
    ...(normalizeFiniteNumber(row.pending_final_delivery_created_at) !== undefined
      ? { createdAt: row.pending_final_delivery_created_at ?? undefined }
      : {}),
    ...(normalizeFiniteNumber(row.pending_final_delivery_last_attempt_at) !== undefined
      ? { lastAttemptAt: row.pending_final_delivery_last_attempt_at ?? undefined }
      : {}),
    ...(normalizeFiniteNumber(row.pending_final_delivery_attempt_count) !== undefined
      ? { attemptCount: row.pending_final_delivery_attempt_count ?? undefined }
      : {}),
    ...(row.pending_final_delivery_last_error !== null
      ? { lastError: row.pending_final_delivery_last_error }
      : {}),
    ...(row.completion_announced_at !== null && row.expects_completion_message === 1
      ? {
          status: "delivered",
          announcedAt: row.completion_announced_at,
          deliveredAt: delivery?.deliveredAt ?? row.completion_announced_at,
        }
      : row.completion_announced_at !== null
        ? { announcedAt: row.completion_announced_at }
        : {}),
    ...(row.expects_completion_message === 0 ? { status: "not_required" } : {}),
  };
}

function createRequesterSettleWakeFromTypedColumns(
  row: SubagentRunSqliteRow,
  fallback: RequesterSettleWakeState | undefined,
): RequesterSettleWakeState | undefined {
  const fallbackStatus =
    fallback?.status === "pending" || fallback?.status === "dispatching"
      ? fallback.status
      : undefined;
  const status =
    row.requester_settle_wake_status === "pending" ||
    row.requester_settle_wake_status === "dispatching"
      ? row.requester_settle_wake_status
      : fallbackStatus;
  if (!status) {
    return undefined;
  }
  const parsedBatchRunIds = parseJson(row.requester_settle_wake_batch_run_ids_json);
  const batchRunIds = Array.isArray(parsedBatchRunIds)
    ? parsedBatchRunIds.filter(
        (value): value is string => typeof value === "string" && Boolean(value),
      )
    : fallback?.batchRunIds;
  return {
    ...fallback,
    status,
    attemptCount:
      normalizeFiniteNumber(row.requester_settle_wake_attempt_count) ?? fallback?.attemptCount ?? 0,
    ...(normalizeFiniteNumber(row.requester_settle_wake_replay_count) !== undefined
      ? { replayCount: row.requester_settle_wake_replay_count ?? undefined }
      : fallback?.replayCount !== undefined
        ? { replayCount: fallback.replayCount }
        : {}),
    ...(normalizeFiniteNumber(row.requester_settle_wake_next_attempt_at) !== undefined
      ? { nextAttemptAt: row.requester_settle_wake_next_attempt_at ?? undefined }
      : fallback?.nextAttemptAt !== undefined
        ? { nextAttemptAt: fallback.nextAttemptAt }
        : {}),
    ...(batchRunIds && batchRunIds.length > 0 ? { batchRunIds } : {}),
    ...(row.requester_settle_wake_last_error !== null
      ? { lastError: row.requester_settle_wake_last_error }
      : {}),
    ...(sqliteBool(row.requester_settle_wake_retire_after) !== undefined
      ? { retireAfterSettle: sqliteBool(row.requester_settle_wake_retire_after) }
      : {}),
  };
}

/** Rehydrates one sqlite row into the normalized subagent run record shape. */
function rowToSubagentRunRecord(row: SubagentRunSqliteRow): SubagentRunRecord | null {
  const payload = (parseJson(row.payload_json) as Partial<SubagentRunRecord> | undefined) ?? {};
  const requesterOrigin =
    (parseJson(row.requester_origin_json) as SubagentRunRecord["requesterOrigin"] | undefined) ??
    payload.requesterOrigin;
  const outcome =
    (parseJson(row.outcome_json) as SubagentRunRecord["outcome"] | undefined) ?? payload.outcome;
  const completion: SubagentCompletionState | undefined = {
    ...(payload.completion ?? { required: row.expects_completion_message === 1 }),
    required: payload.completion?.required ?? row.expects_completion_message === 1,
    ...(row.frozen_result_text !== null ? { resultText: row.frozen_result_text } : {}),
    ...(row.frozen_result_captured_at !== null
      ? { capturedAt: row.frozen_result_captured_at }
      : {}),
    ...(row.fallback_frozen_result_text !== null
      ? { fallbackResultText: row.fallback_frozen_result_text }
      : {}),
    ...(row.fallback_frozen_result_captured_at !== null
      ? { fallbackCapturedAt: row.fallback_frozen_result_captured_at }
      : {}),
  };
  const execution: SubagentExecutionState | undefined = payload.execution
    ? {
        ...payload.execution,
        ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
        ...(row.ended_at !== null ? { status: "terminal", endedAt: row.ended_at, outcome } : {}),
      }
    : undefined;
  const delivery = createDeliveryFromTypedColumns(row, payload.delivery);
  const requesterSettleWake = createRequesterSettleWakeFromTypedColumns(
    row,
    payload.requesterSettleWake,
  );
  const record = normalizeSubagentRunState({
    ...payload,
    runId: row.run_id,
    childSessionKey: row.child_session_key,
    ...(row.controller_session_key ? { controllerSessionKey: row.controller_session_key } : {}),
    requesterSessionKey: row.requester_session_key,
    ...(requesterOrigin ? { requesterOrigin: normalizeDeliveryContext(requesterOrigin) } : {}),
    requesterDisplayKey: row.requester_display_key,
    task: row.task,
    cleanup: row.cleanup === "delete" ? "delete" : "keep",
    ...(row.task_name ? { taskName: row.task_name } : {}),
    ...(row.label ? { label: row.label } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.agent_dir ? { agentDir: row.agent_dir } : {}),
    ...(row.workspace_dir ? { workspaceDir: row.workspace_dir } : {}),
    ...(row.run_timeout_seconds !== null ? { runTimeoutSeconds: row.run_timeout_seconds } : {}),
    ...(row.spawn_mode === "session" || row.spawn_mode === "run"
      ? { spawnMode: row.spawn_mode }
      : {}),
    createdAt: row.created_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.session_started_at !== null ? { sessionStartedAt: row.session_started_at } : {}),
    ...(row.accumulated_runtime_ms !== null
      ? { accumulatedRuntimeMs: row.accumulated_runtime_ms }
      : {}),
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    ...(outcome ? { outcome } : {}),
    ...(row.archive_at_ms !== null ? { archiveAtMs: row.archive_at_ms } : {}),
    ...(row.cleanup_completed_at !== null ? { cleanupCompletedAt: row.cleanup_completed_at } : {}),
    ...(sqliteBool(row.cleanup_handled) !== undefined
      ? { cleanupHandled: sqliteBool(row.cleanup_handled) }
      : {}),
    ...(row.suppress_announce_reason === "steer-restart" ||
    row.suppress_announce_reason === "killed"
      ? { suppressAnnounceReason: row.suppress_announce_reason }
      : {}),
    ...(sqliteBool(row.expects_completion_message) !== undefined
      ? { expectsCompletionMessage: sqliteBool(row.expects_completion_message) }
      : {}),
    ...(row.ended_reason
      ? { endedReason: row.ended_reason as SubagentRunRecord["endedReason"] }
      : {}),
    ...(row.pause_reason === "sessions_yield" ? { pauseReason: row.pause_reason } : {}),
    ...(sqliteBool(row.wake_on_descendant_settle) !== undefined
      ? { wakeOnDescendantSettle: sqliteBool(row.wake_on_descendant_settle) }
      : {}),
    ...(execution ? { execution } : {}),
    completion,
    ...(row.ended_hook_emitted_at !== null
      ? { endedHookEmittedAt: row.ended_hook_emitted_at }
      : {}),
    ...(delivery ? { delivery } : {}),
    ...(requesterSettleWake ? { requesterSettleWake } : {}),
  });
  return record.runId && record.childSessionKey && record.requesterSessionKey ? record : null;
}

/** Flattens a normalized subagent run into typed sqlite columns plus payload_json. */
function subagentRunRecordToSqliteInsert(entry: SubagentRunRecord): SubagentRunSqliteInsert {
  const normalized = normalizeSubagentRunState(structuredClone(entry));
  const delivery = normalized.delivery;
  const completion = normalized.completion;
  const requesterSettleWake = normalized.requesterSettleWake;
  return {
    run_id: normalized.runId,
    child_session_key: normalized.childSessionKey,
    controller_session_key: normalized.controllerSessionKey ?? null,
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
    started_at: normalized.startedAt ?? null,
    session_started_at: normalized.sessionStartedAt ?? null,
    accumulated_runtime_ms: normalized.accumulatedRuntimeMs ?? null,
    ended_at: normalized.endedAt ?? null,
    outcome_json: jsonStringify(normalized.outcome),
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
    payload_json: JSON.stringify(normalized),
  };
}

function subagentRunRecordToSqliteUpdate(values: SubagentRunSqliteInsert): SubagentRunSqliteUpdate {
  const { run_id: _runId, ...update } = values;
  return update;
}

function readSubagentRegistryRows(): SubagentRunSqliteRow[] {
  const { db } = openOpenClawStateDatabase();
  const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
  return executeSqliteQuerySync(
    db,
    stateDb
      .selectFrom("subagent_runs")
      .selectAll()
      .orderBy("created_at", "asc")
      .orderBy("run_id", "asc"),
  ).rows;
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

/** Saves the complete subagent run snapshot to sqlite and prunes rows not in the snapshot. */
export function saveSubagentRegistryToSqlite(runs: Map<string, SubagentRunRecord>): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<SubagentRegistryDatabase>(db);
    const runIds: string[] = [];
    for (const entry of runs.values()) {
      const values = subagentRunRecordToSqliteInsert(entry);
      runIds.push(values.run_id);
      executeSqliteQuerySync(
        db,
        stateDb
          .insertInto("subagent_runs")
          .values(values)
          .onConflict((conflict) =>
            conflict.column("run_id").doUpdateSet(subagentRunRecordToSqliteUpdate(values)),
          ),
      );
    }
    const deleteQuery =
      runIds.length === 0
        ? stateDb.deleteFrom("subagent_runs")
        : stateDb.deleteFrom("subagent_runs").where("run_id", "not in", runIds);
    executeSqliteQuerySync(db, deleteQuery);
  });
}
