// Reads, normalizes, and inserts rows from the legacy task-runs SQLite sidecar.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { requireNodeSqlite, resolveNodeSqliteLocation } from "./node-sqlite.js";

export type SqliteBindRow = Record<string, SQLInputValue>;

export function normalizeLegacySqliteInteger(value: number | bigint | null): number | null {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return value;
}

export function listSqliteColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return new Set(rows.flatMap((row) => (row.name ? [row.name] : [])));
}

export function pickLegacyColumn(columns: Set<string>, name: string, fallbackSql = "NULL"): string {
  return columns.has(name) ? name : `${fallbackSql} AS ${name}`;
}

export function legacyBindValue(value: unknown): SQLInputValue {
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value ?? null;
  }
  return JSON.stringify(value);
}

function legacyStringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeLegacyTaskRow(row: Record<string, unknown>): SqliteBindRow {
  const runtime = legacyStringValue(row.runtime);
  const sourceId = typeof row.source_id === "string" ? row.source_id : "";
  const taskId = legacyStringValue(row.task_id);
  const ownerRaw = typeof row.owner_key === "string" ? row.owner_key.trim() : "";
  const requesterRaw =
    typeof row.requester_session_key === "string" ? row.requester_session_key.trim() : "";
  const ownerKey = ownerRaw || requesterRaw || `system:${runtime}:${sourceId || taskId}`;
  const scopeRaw = typeof row.scope_kind === "string" ? row.scope_kind : "";
  const scopeKind = scopeRaw === "system" || ownerKey.startsWith("system:") ? "system" : "session";
  const childSessionKey =
    typeof row.child_session_key === "string" ? row.child_session_key.trim() : "";
  const persistedAgentId = typeof row.agent_id === "string" ? row.agent_id.trim() : "";
  const isSpawnRuntime = runtime === "subagent" || runtime === "acp";
  const childAgentId = isSpawnRuntime ? parseAgentSessionKey(childSessionKey)?.agentId : undefined;
  const requesterAgentId =
    (typeof row.requester_agent_id === "string" ? row.requester_agent_id.trim() : "") ||
    (isSpawnRuntime
      ? (parseAgentSessionKey(ownerKey)?.agentId ??
        parseAgentSessionKey(requesterRaw)?.agentId ??
        (childAgentId && persistedAgentId !== childAgentId ? persistedAgentId : ""))
      : "");
  const executorAgentId = requesterAgentId ? childAgentId || persistedAgentId : persistedAgentId;
  const deliveryStatus =
    row.delivery_status === "not-requested" ? "not_applicable" : row.delivery_status;
  return {
    task_id: taskId,
    runtime,
    task_kind: legacyBindValue(row.task_kind),
    source_id: legacyBindValue(row.source_id),
    requester_session_key: scopeKind === "system" ? "" : requesterRaw || ownerKey,
    owner_key: ownerKey,
    scope_kind: scopeKind,
    child_session_key: childSessionKey || null,
    parent_flow_id: legacyBindValue(row.parent_flow_id),
    parent_task_id: legacyBindValue(row.parent_task_id),
    agent_id: executorAgentId || null,
    requester_agent_id: requesterAgentId || null,
    run_id: legacyBindValue(row.run_id),
    label: legacyBindValue(row.label),
    task: legacyBindValue(row.task ?? ""),
    status: legacyBindValue(row.status ?? ""),
    delivery_status: legacyBindValue(deliveryStatus ?? ""),
    notify_policy: legacyBindValue(row.notify_policy ?? ""),
    created_at: normalizeLegacySqliteInteger(row.created_at as number | bigint | null) ?? 0,
    started_at: normalizeLegacySqliteInteger(row.started_at as number | bigint | null),
    ended_at: normalizeLegacySqliteInteger(row.ended_at as number | bigint | null),
    last_event_at: normalizeLegacySqliteInteger(row.last_event_at as number | bigint | null),
    cleanup_after: normalizeLegacySqliteInteger(row.cleanup_after as number | bigint | null),
    error: legacyBindValue(row.error),
    progress_summary: legacyBindValue(row.progress_summary),
    terminal_summary: legacyBindValue(row.terminal_summary),
    terminal_outcome: legacyBindValue(row.terminal_outcome),
    detail_json: legacyBindValue(row.detail_json),
  };
}

export function readLegacyTaskRows(sourcePath: string): SqliteBindRow[] {
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(resolveNodeSqliteLocation(sourcePath), { readOnly: true });
  try {
    const columns = listSqliteColumns(db, "task_runs");
    if (columns.size === 0) {
      return [];
    }
    const selectColumns = [
      "task_id",
      "runtime",
      pickLegacyColumn(columns, "task_kind"),
      pickLegacyColumn(columns, "source_id"),
      pickLegacyColumn(columns, "requester_session_key"),
      pickLegacyColumn(columns, "owner_key"),
      pickLegacyColumn(columns, "scope_kind"),
      pickLegacyColumn(columns, "child_session_key"),
      pickLegacyColumn(columns, "parent_flow_id"),
      pickLegacyColumn(columns, "parent_task_id"),
      pickLegacyColumn(columns, "agent_id"),
      pickLegacyColumn(columns, "requester_agent_id"),
      pickLegacyColumn(columns, "run_id"),
      pickLegacyColumn(columns, "label"),
      "task",
      "status",
      "delivery_status",
      "notify_policy",
      "created_at",
      pickLegacyColumn(columns, "started_at"),
      pickLegacyColumn(columns, "ended_at"),
      pickLegacyColumn(columns, "last_event_at"),
      pickLegacyColumn(columns, "cleanup_after"),
      pickLegacyColumn(columns, "error"),
      pickLegacyColumn(columns, "progress_summary"),
      pickLegacyColumn(columns, "terminal_summary"),
      pickLegacyColumn(columns, "terminal_outcome"),
      pickLegacyColumn(columns, "detail_json"),
    ];
    return db
      .prepare(
        `SELECT ${selectColumns.join(", ")} FROM task_runs ORDER BY created_at ASC, task_id ASC`,
      )
      .all()
      .map((row) => normalizeLegacyTaskRow(row as Record<string, unknown>));
  } finally {
    db.close();
  }
}

export function readLegacyTaskDeliveryRows(sourcePath: string): SqliteBindRow[] {
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(resolveNodeSqliteLocation(sourcePath), { readOnly: true });
  try {
    const columns = listSqliteColumns(db, "task_delivery_state");
    if (columns.size === 0) {
      return [];
    }
    return db
      .prepare(
        `SELECT task_id, requester_origin_json, last_notified_event_at FROM task_delivery_state ORDER BY task_id ASC`,
      )
      .all() as SqliteBindRow[];
  } finally {
    db.close();
  }
}

export function insertTaskRunRowSql(db: DatabaseSync, row: SqliteBindRow): void {
  db.prepare(
    `
      INSERT INTO task_runs (
        task_id, runtime, task_kind, source_id, requester_session_key, owner_key, scope_kind,
        child_session_key, parent_flow_id, parent_task_id, agent_id, requester_agent_id, run_id,
        label, task, status, delivery_status, notify_policy, created_at, started_at, ended_at,
        last_event_at, cleanup_after, error, progress_summary, terminal_summary, terminal_outcome,
        detail_json
      ) VALUES (
        @task_id, @runtime, @task_kind, @source_id, @requester_session_key, @owner_key,
        @scope_kind, @child_session_key, @parent_flow_id, @parent_task_id, @agent_id,
        @requester_agent_id, @run_id, @label, @task, @status, @delivery_status, @notify_policy,
        @created_at, @started_at, @ended_at, @last_event_at, @cleanup_after, @error,
        @progress_summary, @terminal_summary, @terminal_outcome, @detail_json
      )
    `,
  ).run(row);
}

export function insertTaskDeliveryRowSql(db: DatabaseSync, row: SqliteBindRow): void {
  db.prepare(
    `
      INSERT INTO task_delivery_state (
        task_id, requester_origin_json, last_notified_event_at
      ) VALUES (
        @task_id, @requester_origin_json, @last_notified_event_at
      )
    `,
  ).run(row);
}
