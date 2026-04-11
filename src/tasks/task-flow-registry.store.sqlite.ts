import { chmodSync, existsSync, mkdirSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { DeliveryContext } from "../utils/delivery-context.js";
import {
  resolveTaskFlowRegistryDir,
  resolveTaskFlowRegistrySqlitePath,
} from "./task-flow-registry.paths.js";
import type { TaskFlowRegistryStoreSnapshot } from "./task-flow-registry.store.types.js";
import type { TaskFlowRecord, TaskFlowSyncMode, JsonValue } from "./task-flow-registry.types.js";

type FlowRegistryRow = {
  flow_id: string;
  sync_mode: TaskFlowSyncMode | null;
  shape?: string | null;
  owner_key: string;
  requester_origin_json: string | null;
  controller_id: string | null;
  revision: number | bigint | null;
  status: TaskFlowRecord["status"];
  notify_policy: TaskFlowRecord["notifyPolicy"];
  goal: string;
  current_step: string | null;
  blocked_task_id: string | null;
  blocked_summary: string | null;
  state_json: string | null;
  wait_json: string | null;
  cancel_requested_at: number | bigint | null;
  created_at: number | bigint;
  updated_at: number | bigint;
  ended_at: number | bigint | null;
};

type FlowRegistryStatements = {
  selectAll: StatementSync;
  upsertRow: StatementSync;
  deleteRow: StatementSync;
  clearRows: StatementSync;
};

type FlowRegistryDatabase = {
  db: DatabaseSync;
  path: string;
  statements: FlowRegistryStatements;
};

let cachedDatabase: FlowRegistryDatabase | null = null;
const FLOW_REGISTRY_DIR_MODE = 0o700;
const FLOW_REGISTRY_FILE_MODE = 0o600;
const FLOW_REGISTRY_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;

function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function serializeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJsonValue<T>(raw: string | null): T | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function rowToSyncMode(row: FlowRegistryRow): TaskFlowSyncMode {
  if (row.sync_mode === "task_mirrored" || row.sync_mode === "managed") {
    return row.sync_mode;
  }
  return row.shape === "single_task" ? "task_mirrored" : "managed";
}

function rowToFlowRecord(row: FlowRegistryRow): TaskFlowRecord {
  const endedAt = normalizeNumber(row.ended_at);
  const cancelRequestedAt = normalizeNumber(row.cancel_requested_at);
  const requesterOrigin = parseJsonValue<DeliveryContext>(row.requester_origin_json);
  const stateJson = parseJsonValue<JsonValue>(row.state_json);
  const waitJson = parseJsonValue<JsonValue>(row.wait_json);
  return {
    flowId: row.flow_id,
    syncMode: rowToSyncMode(row),
    ownerKey: row.owner_key,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    ...(row.controller_id ? { controllerId: row.controller_id } : {}),
    revision: normalizeNumber(row.revision) ?? 0,
    status: row.status,
    notifyPolicy: row.notify_policy,
    goal: row.goal,
    ...(row.current_step ? { currentStep: row.current_step } : {}),
    ...(row.blocked_task_id ? { blockedTaskId: row.blocked_task_id } : {}),
    ...(row.blocked_summary ? { blockedSummary: row.blocked_summary } : {}),
    ...(stateJson !== undefined ? { stateJson } : {}),
    ...(waitJson !== undefined ? { waitJson } : {}),
    ...(cancelRequestedAt != null ? { cancelRequestedAt } : {}),
    createdAt: normalizeNumber(row.created_at) ?? 0,
    updatedAt: normalizeNumber(row.updated_at) ?? 0,
    ...(endedAt != null ? { endedAt } : {}),
  };
}

function bindFlowRecord(record: TaskFlowRecord) {
  return {
    flow_id: record.flowId,
    sync_mode: record.syncMode,
    owner_key: record.ownerKey,
    requester_origin_json: serializeJson(record.requesterOrigin),
    controller_id: record.controllerId ?? null,
    revision: record.revision,
    status: record.status,
    notify_policy: record.notifyPolicy,
    goal: record.goal,
    current_step: record.currentStep ?? null,
    blocked_task_id: record.blockedTaskId ?? null,
    blocked_summary: record.blockedSummary ?? null,
    state_json: serializeJson(record.stateJson),
    wait_json: serializeJson(record.waitJson),
    cancel_requested_at: record.cancelRequestedAt ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    ended_at: record.endedAt ?? null,
  };
}

function createStatements(db: DatabaseSync): FlowRegistryStatements {
  return {
    selectAll: db.prepare(`
      SELECT
        flow_id,
        sync_mode,
        shape,
        owner_key,
        requester_origin_json,
        controller_id,
        revision,
        status,
        notify_policy,
        goal,
        current_step,
        blocked_task_id,
        blocked_summary,
        state_json,
        wait_json,
        cancel_requested_at,
        created_at,
        updated_at,
        ended_at
      FROM flow_runs
      ORDER BY created_at ASC, flow_id ASC
    `),
    upsertRow: db.prepare(`
      INSERT INTO flow_runs (
        flow_id,
        sync_mode,
        owner_key,
        requester_origin_json,
        controller_id,
        revision,
        status,
        notify_policy,
        goal,
        current_step,
        blocked_task_id,
        blocked_summary,
        state_json,
        wait_json,
        cancel_requested_at,
        created_at,
        updated_at,
        ended_at
      ) VALUES (
        @flow_id,
        @sync_mode,
        @owner_key,
        @requester_origin_json,
        @controller_id,
        @revision,
        @status,
        @notify_policy,
        @goal,
        @current_step,
        @blocked_task_id,
        @blocked_summary,
        @state_json,
        @wait_json,
        @cancel_requested_at,
        @created_at,
        @updated_at,
        @ended_at
      )
      ON CONFLICT(flow_id) DO UPDATE SET
        sync_mode = excluded.sync_mode,
        owner_key = excluded.owner_key,
        requester_origin_json = excluded.requester_origin_json,
        controller_id = excluded.controller_id,
        revision = excluded.revision,
        status = excluded.status,
        notify_policy = excluded.notify_policy,
        goal = excluded.goal,
        current_step = excluded.current_step,
        blocked_task_id = excluded.blocked_task_id,
        blocked_summary = excluded.blocked_summary,
        state_json = excluded.state_json,
        wait_json = excluded.wait_json,
        cancel_requested_at = excluded.cancel_requested_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        ended_at = excluded.ended_at
    `),
    deleteRow: db.prepare(`DELETE FROM flow_runs WHERE flow_id = ?`),
    clearRows: db.prepare(`DELETE FROM flow_runs`),
  };
}

function hasFlowRunsColumn(db: DatabaseSync, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(flow_runs)`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
}

function ensureSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS flow_runs (
      flow_id TEXT PRIMARY KEY,
      shape TEXT,
      sync_mode TEXT NOT NULL DEFAULT 'managed',
      owner_key TEXT NOT NULL,
      requester_origin_json TEXT,
      controller_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      notify_policy TEXT NOT NULL,
      goal TEXT NOT NULL,
      current_step TEXT,
      blocked_task_id TEXT,
      blocked_summary TEXT,
      state_json TEXT,
      wait_json TEXT,
      cancel_requested_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER
    );
  `);
  if (!hasFlowRunsColumn(db, "owner_key") && hasFlowRunsColumn(db, "owner_session_key")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN owner_key TEXT;`);
    db.exec(`
      UPDATE flow_runs
      SET owner_key = owner_session_key
      WHERE owner_key IS NULL
    `);
  }
  if (!hasFlowRunsColumn(db, "shape")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN shape TEXT;`);
  }
  if (!hasFlowRunsColumn(db, "sync_mode")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN sync_mode TEXT;`);
    if (hasFlowRunsColumn(db, "shape")) {
      db.exec(`
        UPDATE flow_runs
        SET sync_mode = CASE
          WHEN shape = 'single_task' THEN 'task_mirrored'
          ELSE 'managed'
        END
        WHERE sync_mode IS NULL
      `);
    } else {
      db.exec(`
        UPDATE flow_runs
        SET sync_mode = 'managed'
        WHERE sync_mode IS NULL
      `);
    }
  }
  if (!hasFlowRunsColumn(db, "controller_id")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN controller_id TEXT;`);
  }
  db.exec(`
    UPDATE flow_runs
    SET controller_id = 'core/legacy-restored'
    WHERE sync_mode = 'managed'
      AND (controller_id IS NULL OR trim(controller_id) = '')
  `);
  if (!hasFlowRunsColumn(db, "revision")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN revision INTEGER;`);
    db.exec(`
      UPDATE flow_runs
      SET revision = 0
      WHERE revision IS NULL
    `);
  }
  if (!hasFlowRunsColumn(db, "blocked_task_id")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN blocked_task_id TEXT;`);
  }
  if (!hasFlowRunsColumn(db, "blocked_summary")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN blocked_summary TEXT;`);
  }
  if (!hasFlowRunsColumn(db, "state_json")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN state_json TEXT;`);
  }
  if (!hasFlowRunsColumn(db, "wait_json")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN wait_json TEXT;`);
  }
  if (!hasFlowRunsColumn(db, "cancel_requested_at")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN cancel_requested_at INTEGER;`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_runs_status ON flow_runs(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_runs_owner_key ON flow_runs(owner_key);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_runs_updated_at ON flow_runs(updated_at);`);
}

function ensureFlowRegistryPermissions(pathname: string) {
  const dir = resolveTaskFlowRegistryDir(process.env);
  mkdirSync(dir, { recursive: true, mode: FLOW_REGISTRY_DIR_MODE });
  chmodSync(dir, FLOW_REGISTRY_DIR_MODE);
  for (const suffix of FLOW_REGISTRY_SIDECAR_SUFFIXES) {
    const candidate = `${pathname}${suffix}`;
    if (!existsSync(candidate)) {
      continue;
    }
    chmodSync(candidate, FLOW_REGISTRY_FILE_MODE);
  }
}

function openFlowRegistryDatabase(): FlowRegistryDatabase {
  const pathname = resolveTaskFlowRegistrySqlitePath(process.env);
  if (cachedDatabase && cachedDatabase.path === pathname) {
    return cachedDatabase;
  }
  if (cachedDatabase) {
    cachedDatabase.db.close();
    cachedDatabase = null;
  }
  ensureFlowRegistryPermissions(pathname);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname);
  db.exec(`PRAGMA journal_mode = WAL;`);
  db.exec(`PRAGMA synchronous = NORMAL;`);
  db.exec(`PRAGMA busy_timeout = 5000;`);
  ensureSchema(db);
  ensureFlowRegistryPermissions(pathname);
  cachedDatabase = {
    db,
    path: pathname,
    statements: createStatements(db),
  };
  return cachedDatabase;
}

function withWriteTransaction(write: (statements: FlowRegistryStatements) => void) {
  const { db, path, statements } = openFlowRegistryDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    write(statements);
    db.exec("COMMIT");
    ensureFlowRegistryPermissions(path);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function loadTaskFlowRegistryStateFromSqlite(): TaskFlowRegistryStoreSnapshot {
  const { statements } = openFlowRegistryDatabase();
  const rows = statements.selectAll.all() as FlowRegistryRow[];
  return {
    flows: new Map(rows.map((row) => [row.flow_id, rowToFlowRecord(row)])),
  };
}

export function saveTaskFlowRegistryStateToSqlite(snapshot: TaskFlowRegistryStoreSnapshot) {
  withWriteTransaction((statements) => {
    statements.clearRows.run();
    for (const flow of snapshot.flows.values()) {
      statements.upsertRow.run(bindFlowRecord(flow));
    }
  });
}

export function upsertTaskFlowRegistryRecordToSqlite(flow: TaskFlowRecord) {
  const store = openFlowRegistryDatabase();
  store.statements.upsertRow.run(bindFlowRecord(flow));
  ensureFlowRegistryPermissions(store.path);
}

export function deleteTaskFlowRegistryRecordFromSqlite(flowId: string) {
  const store = openFlowRegistryDatabase();
  store.statements.deleteRow.run(flowId);
  ensureFlowRegistryPermissions(store.path);
}

export function closeTaskFlowRegistrySqliteStore() {
  if (!cachedDatabase) {
    return;
  }
  cachedDatabase.db.close();
  cachedDatabase = null;
}
