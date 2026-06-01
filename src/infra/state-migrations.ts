import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  listBundledChannelLegacySessionSurfaces,
  listBundledChannelLegacyStateMigrationDetectors,
} from "../channels/plugins/bundled.js";
import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/types.core.js";
import {
  resolveLegacyStateDirs,
  resolveNewStateDir,
  resolveOAuthDir,
  resolveStateDir,
} from "../config/paths.js";
import type { SessionEntry } from "../config/sessions.js";
import { saveSessionStore } from "../config/sessions.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { SessionScope } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  countPluginStateLiveEntries,
  createPluginStateKeyedStore,
  MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN,
  type OpenKeyedStoreOptions,
} from "../plugin-state/plugin-state-store.js";
import {
  listPluginDoctorStateMigrationEntries,
  type PluginDoctorStateMigrationContext,
  type PluginDoctorStateMigration,
} from "../plugins/doctor-contract-registry.js";
import {
  parseInstalledPluginIndex,
  readPersistedInstalledPluginIndexSync,
  resolveLegacyInstalledPluginIndexStorePath,
  writePersistedInstalledPluginIndexSync,
} from "../plugins/installed-plugin-index-store.js";
import {
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  INSTALLED_PLUGIN_INDEX_VERSION,
  type InstalledPluginIndex,
} from "../plugins/installed-plugin-index.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { expandHomePrefix } from "./home-dir.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { isWithinDir } from "./path-safety.js";
import {
  ensureDir,
  existsDir,
  fileExists,
  parseSessionStoreJson5,
  readSessionStoreJson5,
  type SessionEntryLike,
  safeReadDir,
} from "./state-migrations.fs.js";

export type LegacyStateDetection = {
  targetAgentId: string;
  targetMainKey: string;
  targetScope?: SessionScope;
  stateDir: string;
  oauthDir: string;
  sessions: {
    legacyDir: string;
    legacyStorePath: string;
    targetDir: string;
    targetStorePath: string;
    hasLegacy: boolean;
    legacyKeys: string[];
  };
  agentDir: {
    legacyDir: string;
    targetDir: string;
    hasLegacy: boolean;
  };
  channelPlans: {
    hasLegacy: boolean;
    plans: ChannelLegacyStateMigrationPlan[];
  };
  pluginPlans?: {
    hasLegacy: boolean;
    plans: DetectedPluginDoctorStateMigrationPlan[];
  };
  pluginStateSidecar: {
    sourcePath: string;
    hasLegacy: boolean;
  };
  pluginInstallIndex: {
    sourcePath: string;
    hasLegacy: boolean;
  };
  taskStateSidecars: {
    taskRunsPath: string;
    flowRunsPath: string;
    hasLegacy: boolean;
  };
  deliveryQueues: {
    outboundPath: string;
    sessionPath: string;
    hasLegacy: boolean;
  };
  preview: string[];
};

type MigrationLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

let autoMigrateChecked = false;
let autoMigrateStateDirChecked = false;
let autoMigrateTaskStateSidecarsChecked = false;
let cachedLegacySessionSurfaces: LegacySessionSurface[] | null = null;

type LegacySessionSurface = {
  isLegacyGroupSessionKey?: (key: string) => boolean;
  canonicalizeLegacySessionKey?: (params: {
    key: string;
    agentId: string;
  }) => string | null | undefined;
};

type LegacyPluginStateSidecarRow = {
  plugin_id: string;
  namespace: string;
  entry_key: string;
  value_json: string;
  created_at: number | bigint;
  expires_at: number | bigint | null;
};

type LegacyPluginStateImportDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_state_entries">;
type SqliteBindRow = Record<string, SQLInputValue>;

type DetectedPluginDoctorStateMigrationPlan = {
  pluginId: string;
  migration: PluginDoctorStateMigration;
  preview: string[];
};

const PLUGIN_STATE_SQLITE_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;
const TASK_STATE_SQLITE_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;
const LEGACY_DELIVERY_QUEUE_DIRS = [
  { label: "outbound delivery queue", queueName: "outbound", dirName: "delivery-queue" },
  { label: "session delivery queue", queueName: "session", dirName: "session-delivery-queue" },
] as const;
type LegacyDeliveryQueueFile = {
  sourcePath: string;
  status: "pending" | "failed";
};

class LegacyPluginStateSidecarConflictError extends Error {
  constructor(readonly conflictedKeys: string[]) {
    super("legacy plugin-state sidecar conflicts with shared state");
  }
}

class LegacyTaskStateSidecarConflictError extends Error {
  constructor(readonly conflictedKeys: string[]) {
    super("legacy task-state sidecar conflicts with shared state");
  }
}

function getLegacySessionSurfaces(): LegacySessionSurface[] {
  // Legacy migrations run on cold doctor/startup paths. Prefer the narrower
  // setup plugin surface here so session-key cleanup does not materialize full
  // bundled channel runtimes.
  cachedLegacySessionSurfaces ??= [...listBundledChannelLegacySessionSurfaces()];
  return cachedLegacySessionSurfaces;
}

function isSurfaceGroupKey(key: string): boolean {
  return key.includes(":group:") || key.includes(":channel:");
}

function isLegacyGroupKey(key: string): boolean {
  const trimmed = key.trim();
  if (!trimmed) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower.startsWith("group:") || lower.startsWith("channel:")) {
    return true;
  }
  for (const surface of getLegacySessionSurfaces()) {
    if (surface.isLegacyGroupSessionKey?.(trimmed)) {
      return true;
    }
  }
  return false;
}

function buildLegacyMigrationPreview(plan: ChannelLegacyStateMigrationPlan): string {
  if (plan.kind === "plugin-state-import") {
    return plan.preview ?? `- ${plan.label}: ${plan.sourcePath}`;
  }
  return `- ${plan.label}: ${plan.sourcePath} → ${plan.targetPath}`;
}

function resolveLegacyPluginStateSidecarPath(stateDir: string): string {
  return path.join(stateDir, "plugin-state", "state.sqlite");
}

function resolveLegacyTaskRunsSidecarPath(stateDir: string): string {
  return path.join(stateDir, "tasks", "runs.sqlite");
}

function resolveLegacyFlowRunsSidecarPath(stateDir: string): string {
  return path.join(stateDir, "flows", "registry.sqlite");
}

function readLegacyPluginStateSidecarRows(sourcePath: string): LegacyPluginStateSidecarRow[] {
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(sourcePath, { readOnly: true });
  try {
    return db
      .prepare(
        `
          SELECT plugin_id, namespace, entry_key, value_json, created_at, expires_at
          FROM plugin_state_entries
          ORDER BY plugin_id ASC, namespace ASC, entry_key ASC
        `,
      )
      .all() as LegacyPluginStateSidecarRow[];
  } finally {
    db.close();
  }
}

function normalizeLegacySqliteInteger(value: number | bigint | null): number | null {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return value;
}

function legacyPluginStateRowsMatch(
  existing: { value_json: string; created_at: number | bigint; expires_at: number | bigint | null },
  legacy: LegacyPluginStateSidecarRow,
): boolean {
  return (
    existing.value_json === legacy.value_json &&
    normalizeLegacySqliteInteger(existing.created_at) ===
      normalizeLegacySqliteInteger(legacy.created_at) &&
    normalizeLegacySqliteInteger(existing.expires_at) ===
      normalizeLegacySqliteInteger(legacy.expires_at)
  );
}

function archiveLegacyPluginStateSidecar(params: {
  sourcePath: string;
  changes: string[];
  warnings: string[];
}): void {
  const existingSources = PLUGIN_STATE_SQLITE_SIDECAR_SUFFIXES.map(
    (suffix) => `${params.sourcePath}${suffix}`,
  ).filter(fileExists);
  const existingArchives = existingSources
    .map((sourcePath) => `${sourcePath}.migrated`)
    .filter(fileExists);
  if (existingArchives.length > 0) {
    params.warnings.push(
      `Left migrated plugin-state sidecar in place because archive already exists: ${existingArchives[0]}`,
    );
    return;
  }

  for (const sourcePath of existingSources) {
    const archivedPath = `${sourcePath}.migrated`;
    try {
      fs.renameSync(sourcePath, archivedPath);
    } catch (err) {
      params.warnings.push(`Failed archiving plugin-state sidecar ${sourcePath}: ${String(err)}`);
      return;
    }
  }
  params.changes.push(
    `Archived plugin-state sidecar legacy source → ${params.sourcePath}.migrated`,
  );
}

function readLegacyInstalledPluginIndex(sourcePath: string): InstalledPluginIndex | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as unknown;
    const current = parseInstalledPluginIndex(parsed);
    if (current) {
      return current;
    }
    const installRecords =
      readLegacyTopLevelInstallRecords(parsed) ?? readLegacyEmbeddedInstallRecords(parsed);
    if (!installRecords || typeof installRecords !== "object" || Array.isArray(installRecords)) {
      return null;
    }
    return parseInstalledPluginIndex({
      version: INSTALLED_PLUGIN_INDEX_VERSION,
      hostContractVersion: "legacy",
      compatRegistryVersion: "legacy",
      migrationVersion: INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
      policyHash: "legacy",
      generatedAtMs: 0,
      installRecords,
      plugins: [],
      diagnostics: [],
    });
  } catch {
    return null;
  }
}

function readLegacyTopLevelInstallRecords(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const legacy = parsed as { installRecords?: unknown; records?: unknown };
  return legacy.installRecords ?? legacy.records;
}

function readLegacyEmbeddedInstallRecords(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const plugins = (parsed as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) {
    return null;
  }
  const records: Record<string, unknown> = {};
  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== "object" || Array.isArray(plugin)) {
      continue;
    }
    const pluginId = (plugin as { pluginId?: unknown }).pluginId;
    const installRecord = (plugin as { installRecord?: unknown }).installRecord;
    if (
      typeof pluginId === "string" &&
      pluginId.trim() &&
      installRecord &&
      typeof installRecord === "object" &&
      !Array.isArray(installRecord)
    ) {
      records[pluginId] = installRecord;
    }
  }
  return Object.keys(records).length > 0 ? records : null;
}

function legacyInstalledPluginIndexMatches(
  current: InstalledPluginIndex,
  legacy: InstalledPluginIndex,
): boolean {
  return (
    JSON.stringify(current.installRecords) === JSON.stringify(legacy.installRecords) &&
    JSON.stringify(current.plugins) === JSON.stringify(legacy.plugins) &&
    JSON.stringify(current.diagnostics) === JSON.stringify(legacy.diagnostics)
  );
}

function mergeLegacyInstalledPluginIndexRecords(
  current: InstalledPluginIndex,
  legacy: InstalledPluginIndex,
): { merged: InstalledPluginIndex; addedCount: number; conflicts: string[] } {
  const installRecords = { ...current.installRecords };
  const conflicts: string[] = [];
  let addedCount = 0;
  for (const [pluginId, legacyRecord] of Object.entries(legacy.installRecords)) {
    const currentRecord = installRecords[pluginId];
    if (!currentRecord) {
      installRecords[pluginId] = legacyRecord;
      addedCount += 1;
      continue;
    }
    if (JSON.stringify(currentRecord) !== JSON.stringify(legacyRecord)) {
      conflicts.push(pluginId);
    }
  }
  return {
    merged: {
      ...current,
      installRecords,
    },
    addedCount,
    conflicts,
  };
}

function archiveLegacyInstalledPluginIndex(params: {
  sourcePath: string;
  changes: string[];
  warnings: string[];
}): void {
  const archivedPath = `${params.sourcePath}.migrated`;
  if (fileExists(archivedPath)) {
    params.warnings.push(
      `Left migrated plugin install index in place because archive already exists: ${archivedPath}`,
    );
    return;
  }
  try {
    fs.renameSync(params.sourcePath, archivedPath);
    params.changes.push(`Archived plugin install index legacy source → ${archivedPath}`);
  } catch (err) {
    params.warnings.push(
      `Failed archiving plugin install index ${params.sourcePath}: ${String(err)}`,
    );
  }
}

function archiveLegacyTaskStateSidecar(params: {
  sourcePath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): void {
  const existingSources = TASK_STATE_SQLITE_SIDECAR_SUFFIXES.map(
    (suffix) => `${params.sourcePath}${suffix}`,
  ).filter(fileExists);
  const existingArchives = existingSources
    .map((sourcePath) => `${sourcePath}.migrated`)
    .filter(fileExists);
  if (existingArchives.length > 0) {
    params.warnings.push(
      `Left migrated ${params.label} sidecar in place because archive already exists: ${existingArchives[0]}`,
    );
    return;
  }
  for (const sourcePath of existingSources) {
    try {
      fs.renameSync(sourcePath, `${sourcePath}.migrated`);
    } catch (err) {
      params.warnings.push(
        `Failed archiving ${params.label} sidecar ${sourcePath}: ${String(err)}`,
      );
      return;
    }
  }
  params.changes.push(
    `Archived ${params.label} sidecar legacy source → ${params.sourcePath}.migrated`,
  );
}

function hardenLegacyImportSource(params: {
  sourcePath: string;
  label: string;
  warnings: string[];
}): boolean {
  try {
    fs.chmodSync(params.sourcePath, 0o600);
    return true;
  } catch (err) {
    params.warnings.push(`Failed securing ${params.label} legacy source: ${String(err)}`);
    return false;
  }
}

function archiveLegacyImportSource(params: {
  sourcePath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): void {
  const archivedPath = `${params.sourcePath}.migrated`;
  if (fileExists(archivedPath)) {
    params.warnings.push(
      `Left migrated ${params.label} source in place because ${archivedPath} already exists`,
    );
    return;
  }
  if (!hardenLegacyImportSource(params)) {
    return;
  }
  try {
    fs.renameSync(params.sourcePath, archivedPath);
    try {
      fs.chmodSync(archivedPath, 0o600);
    } catch (err) {
      params.warnings.push(
        `Failed securing archived ${params.label} legacy source: ${String(err)}`,
      );
    }
    params.changes.push(`Archived ${params.label} legacy source → ${archivedPath}`);
  } catch (err) {
    params.warnings.push(`Failed archiving ${params.label} legacy source: ${String(err)}`);
  }
}

function listSqliteColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return new Set(rows.flatMap((row) => (row.name ? [row.name] : [])));
}

function pickLegacyColumn(columns: Set<string>, name: string, fallbackSql = "NULL"): string {
  return columns.has(name) ? name : `${fallbackSql} AS ${name}`;
}

function legacyBindValue(value: unknown): SQLInputValue {
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

function legacyKeyValue(value: SQLInputValue): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return `${value}`;
  }
  return "";
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
  return {
    task_id: taskId,
    runtime,
    task_kind: legacyBindValue(row.task_kind),
    source_id: legacyBindValue(row.source_id),
    requester_session_key: scopeKind === "system" ? "" : requesterRaw || ownerKey,
    owner_key: ownerKey,
    scope_kind: scopeKind,
    child_session_key: legacyBindValue(row.child_session_key),
    parent_flow_id: legacyBindValue(row.parent_flow_id),
    parent_task_id: legacyBindValue(row.parent_task_id),
    agent_id: legacyBindValue(row.agent_id),
    run_id: legacyBindValue(row.run_id),
    label: legacyBindValue(row.label),
    task: legacyBindValue(row.task ?? ""),
    status: legacyBindValue(row.status ?? ""),
    delivery_status: legacyBindValue(row.delivery_status ?? ""),
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
  };
}

function normalizeLegacyFlowRow(row: Record<string, unknown>): SqliteBindRow {
  const syncMode =
    row.sync_mode === "task_mirrored" || row.shape === "single_task" ? "task_mirrored" : "managed";
  const ownerKey =
    typeof row.owner_key === "string" && row.owner_key.trim()
      ? row.owner_key.trim()
      : typeof row.owner_session_key === "string"
        ? row.owner_session_key.trim()
        : "";
  const controllerId =
    syncMode === "managed"
      ? typeof row.controller_id === "string" && row.controller_id.trim()
        ? row.controller_id.trim()
        : "core/legacy-restored"
      : null;
  return {
    flow_id: legacyBindValue(row.flow_id ?? ""),
    shape: legacyBindValue(row.shape),
    sync_mode: syncMode,
    owner_key: ownerKey,
    requester_origin_json: legacyBindValue(row.requester_origin_json),
    controller_id: controllerId,
    revision: normalizeLegacySqliteInteger(row.revision as number | bigint | null) ?? 0,
    status: legacyBindValue(row.status ?? ""),
    notify_policy: legacyBindValue(row.notify_policy ?? ""),
    goal: legacyBindValue(row.goal ?? ""),
    current_step: legacyBindValue(row.current_step),
    blocked_task_id: legacyBindValue(row.blocked_task_id),
    blocked_summary: legacyBindValue(row.blocked_summary),
    state_json: legacyBindValue(row.state_json),
    wait_json: legacyBindValue(row.wait_json),
    cancel_requested_at: normalizeLegacySqliteInteger(
      row.cancel_requested_at as number | bigint | null,
    ),
    created_at: normalizeLegacySqliteInteger(row.created_at as number | bigint | null) ?? 0,
    updated_at: normalizeLegacySqliteInteger(row.updated_at as number | bigint | null) ?? 0,
    ended_at: normalizeLegacySqliteInteger(row.ended_at as number | bigint | null),
  };
}

function legacyRowsMatch(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  columns: string[],
): boolean {
  return columns.every(
    (column) =>
      normalizeLegacySqliteInteger(existing[column] as number | bigint | null) ===
      normalizeLegacySqliteInteger(incoming[column] as number | bigint | null),
  );
}

function readLegacyTaskRows(sourcePath: string): SqliteBindRow[] {
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(sourcePath, { readOnly: true });
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

function readLegacyTaskDeliveryRows(sourcePath: string): SqliteBindRow[] {
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(sourcePath, { readOnly: true });
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

function readLegacyFlowRows(sourcePath: string): SqliteBindRow[] {
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(sourcePath, { readOnly: true });
  try {
    const columns = listSqliteColumns(db, "flow_runs");
    if (columns.size === 0) {
      return [];
    }
    const selectColumns = [
      "flow_id",
      pickLegacyColumn(columns, "shape"),
      pickLegacyColumn(columns, "sync_mode"),
      pickLegacyColumn(columns, "owner_key"),
      pickLegacyColumn(columns, "owner_session_key"),
      pickLegacyColumn(columns, "requester_origin_json"),
      pickLegacyColumn(columns, "controller_id"),
      pickLegacyColumn(columns, "revision", "0"),
      "status",
      "notify_policy",
      "goal",
      pickLegacyColumn(columns, "current_step"),
      pickLegacyColumn(columns, "blocked_task_id"),
      pickLegacyColumn(columns, "blocked_summary"),
      pickLegacyColumn(columns, "state_json"),
      pickLegacyColumn(columns, "wait_json"),
      pickLegacyColumn(columns, "cancel_requested_at"),
      "created_at",
      "updated_at",
      pickLegacyColumn(columns, "ended_at"),
    ];
    return db
      .prepare(
        `SELECT ${selectColumns.join(", ")} FROM flow_runs ORDER BY created_at ASC, flow_id ASC`,
      )
      .all()
      .map((row) => normalizeLegacyFlowRow(row as Record<string, unknown>));
  } finally {
    db.close();
  }
}

function insertTaskRunRowSql(db: DatabaseSync, row: SqliteBindRow): void {
  db.prepare(
    `
      INSERT INTO task_runs (
        task_id, runtime, task_kind, source_id, requester_session_key, owner_key, scope_kind,
        child_session_key, parent_flow_id, parent_task_id, agent_id, run_id, label, task, status,
        delivery_status, notify_policy, created_at, started_at, ended_at, last_event_at,
        cleanup_after, error, progress_summary, terminal_summary, terminal_outcome
      ) VALUES (
        @task_id, @runtime, @task_kind, @source_id, @requester_session_key, @owner_key,
        @scope_kind, @child_session_key, @parent_flow_id, @parent_task_id, @agent_id, @run_id,
        @label, @task, @status, @delivery_status, @notify_policy, @created_at, @started_at,
        @ended_at, @last_event_at, @cleanup_after, @error, @progress_summary, @terminal_summary,
        @terminal_outcome
      )
    `,
  ).run(row);
}

function insertTaskDeliveryRowSql(db: DatabaseSync, row: SqliteBindRow): void {
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

function insertFlowRunRowSql(db: DatabaseSync, row: SqliteBindRow): void {
  db.prepare(
    `
      INSERT INTO flow_runs (
        flow_id, shape, sync_mode, owner_key, requester_origin_json, controller_id, revision,
        status, notify_policy, goal, current_step, blocked_task_id, blocked_summary, state_json,
        wait_json, cancel_requested_at, created_at, updated_at, ended_at
      ) VALUES (
        @flow_id, @shape, @sync_mode, @owner_key, @requester_origin_json, @controller_id,
        @revision, @status, @notify_policy, @goal, @current_step, @blocked_task_id,
        @blocked_summary, @state_json, @wait_json, @cancel_requested_at, @created_at,
        @updated_at, @ended_at
      )
    `,
  ).run(row);
}

async function migrateLegacyTaskRunsSidecar(params: {
  stateDir: string;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const sourcePath = resolveLegacyTaskRunsSidecarPath(params.stateDir);
  if (!fileExists(sourcePath)) {
    return { changes: [], warnings: [] };
  }
  const changes: string[] = [];
  const warnings: string[] = [];
  let taskRows: SqliteBindRow[];
  let deliveryRows: SqliteBindRow[];
  try {
    taskRows = readLegacyTaskRows(sourcePath);
    deliveryRows = readLegacyTaskDeliveryRows(sourcePath);
  } catch (err) {
    return {
      changes,
      warnings: [`Failed reading task registry sidecar ${sourcePath}: ${String(err)}`],
    };
  }

  try {
    const conflicts: string[] = [];
    let importedTasks = 0;
    let importedDeliveryStates = 0;
    let skippedOrphanDeliveryStates = 0;
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const taskColumns = [
          "runtime",
          "task_kind",
          "source_id",
          "requester_session_key",
          "owner_key",
          "scope_kind",
          "child_session_key",
          "parent_flow_id",
          "parent_task_id",
          "agent_id",
          "run_id",
          "label",
          "task",
          "status",
          "delivery_status",
          "notify_policy",
          "created_at",
          "started_at",
          "ended_at",
          "last_event_at",
          "cleanup_after",
          "error",
          "progress_summary",
          "terminal_summary",
          "terminal_outcome",
        ];
        for (const row of taskRows) {
          const existing = db
            .prepare(`SELECT ${taskColumns.join(", ")} FROM task_runs WHERE task_id = ?`)
            .get(legacyKeyValue(row.task_id));
          if (existing) {
            if (!legacyRowsMatch(existing as Record<string, unknown>, row, taskColumns)) {
              conflicts.push(legacyKeyValue(row.task_id));
            }
            continue;
          }
          insertTaskRunRowSql(db, row);
          importedTasks++;
        }
        const deliveryColumns = ["requester_origin_json", "last_notified_event_at"];
        for (const row of deliveryRows) {
          const existing = db
            .prepare(
              `SELECT requester_origin_json, last_notified_event_at FROM task_delivery_state WHERE task_id = ?`,
            )
            .get(legacyKeyValue(row.task_id));
          if (existing) {
            if (!legacyRowsMatch(existing as Record<string, unknown>, row, deliveryColumns)) {
              conflicts.push(`${legacyKeyValue(row.task_id)}/delivery`);
            }
            continue;
          }
          const taskExists = db
            .prepare("SELECT 1 FROM task_runs WHERE task_id = ?")
            .get(legacyKeyValue(row.task_id));
          if (!taskExists) {
            skippedOrphanDeliveryStates++;
            continue;
          }
          insertTaskDeliveryRowSql(db, row);
          importedDeliveryStates++;
        }
        if (conflicts.length > 0) {
          throw new LegacyTaskStateSidecarConflictError(conflicts);
        }
      },
      { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
    );
    if (importedTasks > 0) {
      changes.push(
        `Migrated ${importedTasks} task registry sidecar ${importedTasks === 1 ? "row" : "rows"} → shared SQLite state`,
      );
    }
    if (importedDeliveryStates > 0) {
      changes.push(
        `Migrated ${importedDeliveryStates} task delivery sidecar ${importedDeliveryStates === 1 ? "row" : "rows"} → shared SQLite state`,
      );
    }
    if (skippedOrphanDeliveryStates > 0) {
      warnings.push(
        `Skipped ${skippedOrphanDeliveryStates} orphan task delivery sidecar ${skippedOrphanDeliveryStates === 1 ? "row" : "rows"} with no task run`,
      );
    }
  } catch (err) {
    if (err instanceof LegacyTaskStateSidecarConflictError) {
      return {
        changes,
        warnings: [
          `Left task registry sidecar in place because ${err.conflictedKeys.length} ${err.conflictedKeys.length === 1 ? "row" : "rows"} already existed in shared state: ${err.conflictedKeys[0]}`,
        ],
      };
    }
    return {
      changes,
      warnings: [`Failed migrating task registry sidecar ${sourcePath}: ${String(err)}`],
    };
  }

  archiveLegacyTaskStateSidecar({ sourcePath, label: "task registry", changes, warnings });
  return { changes, warnings };
}

async function migrateLegacyFlowRunsSidecar(params: {
  stateDir: string;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const sourcePath = resolveLegacyFlowRunsSidecarPath(params.stateDir);
  if (!fileExists(sourcePath)) {
    return { changes: [], warnings: [] };
  }
  const changes: string[] = [];
  const warnings: string[] = [];
  let rows: SqliteBindRow[];
  try {
    rows = readLegacyFlowRows(sourcePath);
  } catch (err) {
    return {
      changes,
      warnings: [`Failed reading task flow sidecar ${sourcePath}: ${String(err)}`],
    };
  }

  try {
    const conflicts: string[] = [];
    let imported = 0;
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const columns = [
          "shape",
          "sync_mode",
          "owner_key",
          "requester_origin_json",
          "controller_id",
          "revision",
          "status",
          "notify_policy",
          "goal",
          "current_step",
          "blocked_task_id",
          "blocked_summary",
          "state_json",
          "wait_json",
          "cancel_requested_at",
          "created_at",
          "updated_at",
          "ended_at",
        ];
        for (const row of rows) {
          const existing = db
            .prepare(`SELECT ${columns.join(", ")} FROM flow_runs WHERE flow_id = ?`)
            .get(legacyKeyValue(row.flow_id));
          if (existing) {
            if (!legacyRowsMatch(existing as Record<string, unknown>, row, columns)) {
              conflicts.push(legacyKeyValue(row.flow_id));
            }
            continue;
          }
          insertFlowRunRowSql(db, row);
          imported++;
        }
        if (conflicts.length > 0) {
          throw new LegacyTaskStateSidecarConflictError(conflicts);
        }
      },
      { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
    );
    if (imported > 0) {
      changes.push(
        `Migrated ${imported} task flow sidecar ${imported === 1 ? "row" : "rows"} → shared SQLite state`,
      );
    }
  } catch (err) {
    if (err instanceof LegacyTaskStateSidecarConflictError) {
      return {
        changes,
        warnings: [
          `Left task flow sidecar in place because ${err.conflictedKeys.length} ${err.conflictedKeys.length === 1 ? "row" : "rows"} already existed in shared state: ${err.conflictedKeys[0]}`,
        ],
      };
    }
    return {
      changes,
      warnings: [`Failed migrating task flow sidecar ${sourcePath}: ${String(err)}`],
    };
  }

  archiveLegacyTaskStateSidecar({ sourcePath, label: "task flow", changes, warnings });
  return { changes, warnings };
}

async function migrateLegacyTaskStateSidecars(params: {
  stateDir: string;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const taskRuns = await migrateLegacyTaskRunsSidecar(params);
  const flowRuns = await migrateLegacyFlowRunsSidecar(params);
  return {
    changes: [...taskRuns.changes, ...flowRuns.changes],
    warnings: [...taskRuns.warnings, ...flowRuns.warnings],
  };
}

function resolveLegacyDeliveryQueuePath(stateDir: string, dirName: string): string {
  return path.join(stateDir, dirName);
}

function listLegacyDeliveryQueueFiles(queueDir: string): LegacyDeliveryQueueFile[] {
  const pending = safeReadDir(queueDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({ sourcePath: path.join(queueDir, entry.name), status: "pending" as const }));
  const failedDir = path.join(queueDir, "failed");
  const failed = safeReadDir(failedDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({
      sourcePath: path.join(failedDir, entry.name),
      status: "failed" as const,
    }));
  return [...pending, ...failed];
}

function listLegacyDeliveryQueueDeliveredMarkers(queueDir: string): string[] {
  return safeReadDir(queueDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".delivered"))
    .map((entry) => path.join(queueDir, entry.name));
}

function readLegacyDeliveryQueueEntry(sourcePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function legacyQueueMetadata(entry: Record<string, unknown>): {
  entryKind: string | null;
  sessionKey: string | null;
  channel: string | null;
  target: string | null;
  accountId: string | null;
} {
  const session = entry.session as { key?: unknown } | undefined;
  const route = entry.route as { channel?: unknown; to?: unknown; accountId?: unknown } | undefined;
  const deliveryContext = entry.deliveryContext as
    | { channel?: unknown; to?: unknown; accountId?: unknown }
    | undefined;
  const stringOrNull = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    entryKind: stringOrNull(entry.kind) ?? "outbound",
    sessionKey: stringOrNull(entry.sessionKey) ?? stringOrNull(session?.key),
    channel:
      stringOrNull(entry.channel) ??
      stringOrNull(route?.channel) ??
      stringOrNull(deliveryContext?.channel),
    target: stringOrNull(entry.to) ?? stringOrNull(route?.to) ?? stringOrNull(deliveryContext?.to),
    accountId:
      stringOrNull(entry.accountId) ??
      stringOrNull(route?.accountId) ??
      stringOrNull(deliveryContext?.accountId),
  };
}

function buildLegacyDeliveryQueueRow(params: {
  queueName: string;
  id: string;
  status: "pending" | "failed";
  entry: Record<string, unknown>;
  now: number;
}): SqliteBindRow {
  const enqueuedAt =
    typeof params.entry.enqueuedAt === "number" ? params.entry.enqueuedAt : params.now;
  const retryCount = typeof params.entry.retryCount === "number" ? params.entry.retryCount : 0;
  const failedAt =
    params.status === "failed"
      ? typeof params.entry.failedAt === "number"
        ? params.entry.failedAt
        : typeof params.entry.lastAttemptAt === "number"
          ? params.entry.lastAttemptAt
          : enqueuedAt
      : null;
  const meta = legacyQueueMetadata(params.entry);
  return {
    queue_name: params.queueName,
    id: params.id,
    status: params.status,
    entry_kind: meta.entryKind,
    session_key: meta.sessionKey,
    channel: meta.channel,
    target: meta.target,
    account_id: meta.accountId,
    retry_count: retryCount,
    last_attempt_at:
      typeof params.entry.lastAttemptAt === "number" ? params.entry.lastAttemptAt : null,
    last_error: typeof params.entry.lastError === "string" ? params.entry.lastError : null,
    recovery_state:
      typeof params.entry.recoveryState === "string" ? params.entry.recoveryState : null,
    platform_send_started_at:
      typeof params.entry.platformSendStartedAt === "number"
        ? params.entry.platformSendStartedAt
        : null,
    entry_json: JSON.stringify({ ...params.entry, id: params.id, enqueuedAt, retryCount }),
    enqueued_at: enqueuedAt,
    updated_at: params.now,
    failed_at: failedAt,
  };
}

function legacyDeliveryQueueRowsMatch(
  existing: Record<string, unknown>,
  incoming: SqliteBindRow,
): boolean {
  return [
    "status",
    "entry_kind",
    "session_key",
    "channel",
    "target",
    "account_id",
    "retry_count",
    "last_attempt_at",
    "last_error",
    "recovery_state",
    "platform_send_started_at",
    "entry_json",
    "enqueued_at",
    "failed_at",
  ].every((column) => {
    const left = existing[column];
    const right = incoming[column];
    if (typeof left === "bigint" || typeof right === "bigint") {
      return (
        normalizeLegacySqliteInteger(left as number | bigint | null) ===
        normalizeLegacySqliteInteger(right as number | bigint | null)
      );
    }
    return left === right;
  });
}

function removeLegacyDeliveryQueueDir(params: {
  queueDir: string;
  label: string;
  changes: string[];
  warnings: string[];
}): void {
  try {
    fs.rmSync(params.queueDir, { recursive: true });
    params.changes.push(`Removed ${params.label} legacy source ${params.queueDir}`);
  } catch (err) {
    params.warnings.push(`Failed removing ${params.label} ${params.queueDir}: ${String(err)}`);
  }
}

function removeLegacyDeliveryQueueMarkers(
  markerPaths: string[],
  label: string,
  warnings: string[],
): number | null {
  let removed = 0;
  for (const markerPath of markerPaths) {
    try {
      fs.rmSync(markerPath, { force: true });
      removed++;
    } catch (err) {
      warnings.push(`Failed removing ${label} marker ${markerPath}: ${String(err)}`);
      return null;
    }
  }
  return removed;
}

async function migrateLegacyDeliveryQueues(params: {
  stateDir: string;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const queue of LEGACY_DELIVERY_QUEUE_DIRS) {
    const queueDir = resolveLegacyDeliveryQueuePath(params.stateDir, queue.dirName);
    const files = listLegacyDeliveryQueueFiles(queueDir);
    const markerPaths = listLegacyDeliveryQueueDeliveredMarkers(queueDir);
    if (files.length === 0 && markerPaths.length === 0) {
      continue;
    }
    let imported = 0;
    let skipped = 0;
    const conflicts: string[] = [];
    try {
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          const insert = db.prepare(
            `
            INSERT INTO delivery_queue_entries (
              queue_name, id, status, entry_kind, session_key, channel, target, account_id,
              retry_count, last_attempt_at, last_error, recovery_state,
              platform_send_started_at, entry_json, enqueued_at, updated_at, failed_at
            ) VALUES (
              @queue_name, @id, @status, @entry_kind, @session_key, @channel, @target,
              @account_id, @retry_count, @last_attempt_at, @last_error, @recovery_state,
              @platform_send_started_at, @entry_json, @enqueued_at, @updated_at, @failed_at
            )
          `,
          );
          const now = Date.now();
          for (const file of files) {
            const entry = readLegacyDeliveryQueueEntry(file.sourcePath);
            const id =
              typeof entry?.id === "string" ? entry.id : path.basename(file.sourcePath, ".json");
            if (!entry || !id) {
              skipped++;
              continue;
            }
            const row = buildLegacyDeliveryQueueRow({
              queueName: queue.queueName,
              id,
              status: file.status,
              entry,
              now,
            });
            const existing = db
              .prepare(
                `
                SELECT status, entry_kind, session_key, channel, target, account_id,
                       retry_count, last_attempt_at, last_error, recovery_state,
                       platform_send_started_at, entry_json, enqueued_at, failed_at
                  FROM delivery_queue_entries
                 WHERE queue_name = ? AND id = ?
              `,
              )
              .get(queue.queueName, id);
            if (existing) {
              if (!legacyDeliveryQueueRowsMatch(existing as Record<string, unknown>, row)) {
                conflicts.push(id);
              }
              continue;
            }
            insert.run(row);
            imported++;
          }
        },
        { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
      );
    } catch (err) {
      warnings.push(`Failed migrating ${queue.label} ${queueDir}: ${String(err)}`);
      continue;
    }
    const removedMarkers = removeLegacyDeliveryQueueMarkers(markerPaths, queue.label, warnings);
    if (removedMarkers === null) {
      continue;
    }
    if (removedMarkers > 0) {
      changes.push(
        `Removed ${removedMarkers} ${queue.label} delivered ${removedMarkers === 1 ? "marker" : "markers"}`,
      );
    }
    if (imported > 0) {
      changes.push(
        `Migrated ${imported} ${queue.label} ${imported === 1 ? "entry" : "entries"} → shared SQLite state`,
      );
    }
    if (skipped > 0) {
      warnings.push(
        `Skipped ${skipped} malformed ${queue.label} ${skipped === 1 ? "entry" : "entries"}`,
      );
      warnings.push(`Left ${queue.label} in place because malformed entries need manual cleanup`);
      continue;
    }
    if (conflicts.length > 0) {
      warnings.push(
        `Left ${queue.label} in place because ${conflicts.length} ${conflicts.length === 1 ? "entry" : "entries"} already existed in shared state: ${conflicts[0]}`,
      );
      continue;
    }
    removeLegacyDeliveryQueueDir({ queueDir, label: queue.label, changes, warnings });
  }
  return { changes, warnings };
}

async function migrateLegacyPluginStateSidecar(params: {
  stateDir: string;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const sourcePath = resolveLegacyPluginStateSidecarPath(params.stateDir);
  if (!fileExists(sourcePath)) {
    return { changes: [], warnings: [] };
  }

  const changes: string[] = [];
  const warnings: string[] = [];
  let rows: LegacyPluginStateSidecarRow[];
  try {
    rows = readLegacyPluginStateSidecarRows(sourcePath);
  } catch (err) {
    return {
      changes,
      warnings: [`Failed reading plugin-state sidecar ${sourcePath}: ${String(err)}`],
    };
  }

  try {
    const conflictedKeys: string[] = [];
    const rowsToInsert: LegacyPluginStateSidecarRow[] = [];
    let imported = 0;
    const now = Date.now();
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<LegacyPluginStateImportDatabase>(db);
        for (const row of rows) {
          executeSqliteQuerySync(
            db,
            stateDb
              .deleteFrom("plugin_state_entries")
              .where("plugin_id", "=", row.plugin_id)
              .where("namespace", "=", row.namespace)
              .where("entry_key", "=", row.entry_key)
              .where("expires_at", "is not", null)
              .where("expires_at", "<=", now),
          );
          const existing = executeSqliteQueryTakeFirstSync(
            db,
            stateDb
              .selectFrom("plugin_state_entries")
              .select(["value_json", "created_at", "expires_at"])
              .where("plugin_id", "=", row.plugin_id)
              .where("namespace", "=", row.namespace)
              .where("entry_key", "=", row.entry_key),
          );
          if (existing) {
            if (!legacyPluginStateRowsMatch(existing, row)) {
              conflictedKeys.push(`${row.plugin_id}/${row.namespace}/${row.entry_key}`);
            }
            continue;
          }
          rowsToInsert.push(row);
        }
        if (conflictedKeys.length > 0) {
          throw new LegacyPluginStateSidecarConflictError(conflictedKeys);
        }
        for (const row of rowsToInsert) {
          executeSqliteQuerySync(
            db,
            stateDb
              .insertInto("plugin_state_entries")
              .values({
                plugin_id: row.plugin_id,
                namespace: row.namespace,
                entry_key: row.entry_key,
                value_json: row.value_json,
                created_at: normalizeLegacySqliteInteger(row.created_at) ?? 0,
                expires_at: normalizeLegacySqliteInteger(row.expires_at),
              })
              .onConflict((conflict) =>
                conflict.columns(["plugin_id", "namespace", "entry_key"]).doNothing(),
              ),
          );
          imported += 1;
        }
      },
      { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
    );
    if (imported > 0) {
      changes.push(
        `Migrated ${imported} plugin-state sidecar ${imported === 1 ? "entry" : "entries"} → shared SQLite state`,
      );
    }
  } catch (err) {
    if (err instanceof LegacyPluginStateSidecarConflictError) {
      return {
        changes,
        warnings: [
          `Left plugin-state sidecar in place because ${err.conflictedKeys.length} ${err.conflictedKeys.length === 1 ? "row" : "rows"} already existed in shared state: ${err.conflictedKeys[0]}`,
        ],
      };
    }
    return {
      changes,
      warnings: [`Failed migrating plugin-state sidecar ${sourcePath}: ${String(err)}`],
    };
  }

  archiveLegacyPluginStateSidecar({ sourcePath, changes, warnings });
  return { changes, warnings };
}

async function migrateLegacyInstalledPluginIndex(params: {
  stateDir: string;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const sourcePath = resolveLegacyInstalledPluginIndexStorePath({ stateDir: params.stateDir });
  if (!fileExists(sourcePath)) {
    return { changes: [], warnings: [] };
  }

  const changes: string[] = [];
  const warnings: string[] = [];
  const legacy = readLegacyInstalledPluginIndex(sourcePath);
  if (!legacy) {
    return {
      changes,
      warnings: [`Left plugin install index in place because ${sourcePath} is invalid`],
    };
  }

  const storeOptions = { stateDir: params.stateDir };
  const current = readPersistedInstalledPluginIndexSync(storeOptions);
  if (current && !legacyInstalledPluginIndexMatches(current, legacy)) {
    const merged = mergeLegacyInstalledPluginIndexRecords(current, legacy);
    if (merged.addedCount > 0) {
      try {
        writePersistedInstalledPluginIndexSync(merged.merged, storeOptions);
        changes.push(
          `Merged ${merged.addedCount} legacy plugin install ${merged.addedCount === 1 ? "record" : "records"} → shared SQLite state`,
        );
      } catch (err) {
        return {
          changes,
          warnings: [`Failed merging plugin install index ${sourcePath}: ${String(err)}`],
        };
      }
    }
    if (merged.conflicts.length > 0) {
      return {
        changes,
        warnings: [
          `Left plugin install index in place because shared SQLite state has conflicting plugin install metadata for: ${merged.conflicts.join(", ")}`,
        ],
      };
    }
  }

  if (!current) {
    try {
      writePersistedInstalledPluginIndexSync(legacy, storeOptions);
      const recordCount = Object.keys(legacy.installRecords).length;
      changes.push(
        `Migrated plugin install index ${recordCount} ${recordCount === 1 ? "record" : "records"} → shared SQLite state`,
      );
    } catch (err) {
      return {
        changes,
        warnings: [`Failed migrating plugin install index ${sourcePath}: ${String(err)}`],
      };
    }
  }

  archiveLegacyInstalledPluginIndex({ sourcePath, changes, warnings });
  return { changes, warnings };
}

function resolvePluginStateImportTargetKey(scopeKey: string, key: string): string {
  return scopeKey ? `${scopeKey}:${key}` : key;
}

function findMissingKey(expected: Set<string>, actual: Set<string>): string | undefined {
  for (const key of expected) {
    if (!actual.has(key)) {
      return key;
    }
  }
  return undefined;
}

async function withPluginStateImportEnv<T>(
  plan: Extract<ChannelLegacyStateMigrationPlan, { kind: "plugin-state-import" }>,
  run: () => Promise<T>,
): Promise<T> {
  if (!plan.stateDir) {
    return await run();
  }
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = plan.stateDir;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
  }
}

async function runLegacyMigrationPlans(
  plans: ChannelLegacyStateMigrationPlan[],
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const plan of plans) {
    if (plan.kind === "plugin-state-import") {
      await withPluginStateImportEnv(plan, async () => {
        let storeEntries: Array<{ key: string; value: unknown }>;
        let pluginEntryCount;
        const store = createPluginStateKeyedStore<unknown>(plan.pluginId, {
          namespace: plan.namespace,
          maxEntries: plan.maxEntries,
        });
        try {
          storeEntries = await store.entries();
          pluginEntryCount = countPluginStateLiveEntries(plan.pluginId);
        } catch (err) {
          warnings.push(
            `Failed reading ${plan.label} plugin state before migration: ${String(err)}`,
          );
          return;
        }
        const existingKeys = new Set(storeEntries.map(({ key }) => key));
        const existingValuesByKey = new Map(storeEntries.map(({ key, value }) => [key, value]));
        const expectedKeys = new Set(existingKeys);
        let remainingCapacity = Math.max(0, plan.maxEntries - storeEntries.length);
        let entries: Awaited<ReturnType<typeof plan.readEntries>>;
        try {
          entries = await plan.readEntries();
        } catch (err) {
          warnings.push(`Failed reading ${plan.label} legacy source: ${String(err)}`);
          return;
        }
        const candidateEntries: Array<{
          key: string;
          targetKey: string;
          value: unknown;
          ttlMs?: number;
          existedBefore: boolean;
        }> = [];
        const failedTargetKeys = new Set<string>();
        let missingEntryCount = 0;
        for (const entry of entries) {
          const targetKey = resolvePluginStateImportTargetKey(plan.scopeKey, entry.key);
          const existingValue = existingValuesByKey.get(targetKey);
          if (existingKeys.has(targetKey)) {
            const shouldReplace =
              existingValue !== undefined &&
              (await plan.shouldReplaceExistingEntry?.({
                key: entry.key,
                existingValue,
                incomingValue: entry.value,
              }));
            if (shouldReplace) {
              candidateEntries.push({ ...entry, targetKey, existedBefore: true });
            }
            continue;
          }
          candidateEntries.push({ ...entry, targetKey, existedBefore: false });
          missingEntryCount++;
        }
        const pluginRemainingCapacity = Math.max(
          0,
          MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN - pluginEntryCount,
        );
        if (missingEntryCount > pluginRemainingCapacity) {
          warnings.push(
            `Skipped migrating ${plan.label} because plugin state has room for ${pluginRemainingCapacity} of ${missingEntryCount} missing entries; left legacy source in place`,
          );
          return;
        }
        let imported = 0;
        const changedKeys: string[] = [];
        for (const entry of candidateEntries) {
          if (!entry.existedBefore && remainingCapacity <= 0) {
            break;
          }
          try {
            await store.register(
              entry.targetKey,
              entry.value,
              entry.ttlMs != null ? { ttlMs: entry.ttlMs } : undefined,
            );
            const nextExpectedKeys = new Set(expectedKeys);
            nextExpectedKeys.add(entry.targetKey);
            const liveKeys = new Set((await store.entries()).map(({ key }) => key));
            const missingKey = findMissingKey(nextExpectedKeys, liveKeys);
            if (missingKey) {
              for (const changedKey of changedKeys.toReversed()) {
                if (existingValuesByKey.has(changedKey)) {
                  await store.register(changedKey, existingValuesByKey.get(changedKey));
                } else {
                  await store.delete(changedKey);
                }
              }
              if (existingValuesByKey.has(entry.targetKey)) {
                await store.register(entry.targetKey, existingValuesByKey.get(entry.targetKey));
              } else {
                await store.delete(entry.targetKey);
              }
              warnings.push(
                `Stopped migrating ${plan.label} because plugin state cap evicted ${missingKey}; left legacy source in place`,
              );
              return;
            }
            expectedKeys.add(entry.targetKey);
            existingKeys.add(entry.targetKey);
            changedKeys.push(entry.targetKey);
            if (!entry.existedBefore) {
              remainingCapacity--;
            }
            imported++;
          } catch (err) {
            failedTargetKeys.add(entry.targetKey);
            warnings.push(`Failed migrating ${plan.label} entry ${entry.key}: ${String(err)}`);
          }
        }
        if (imported > 0) {
          changes.push(
            `Migrated ${imported} ${plan.label} ${imported === 1 ? "entry" : "entries"} → plugin state`,
          );
        }
        let cleanupKeys = existingKeys;
        if (plan.cleanupSource === "rename") {
          cleanupKeys = expectedKeys;
        }
        const allEntriesCovered =
          (entries.length === 0 && plan.cleanupWhenEmpty === true) ||
          (entries.length > 0 &&
            entries.every(
              ({ key }) =>
                cleanupKeys.has(resolvePluginStateImportTargetKey(plan.scopeKey, key)) &&
                !failedTargetKeys.has(resolvePluginStateImportTargetKey(plan.scopeKey, key)),
            ));
        if (allEntriesCovered && plan.cleanupSource === "rename" && fileExists(plan.sourcePath)) {
          archiveLegacyImportSource({
            sourcePath: plan.sourcePath,
            label: plan.label,
            changes,
            warnings,
          });
        }
      });
      continue;
    }
    if (fileExists(plan.targetPath)) {
      continue;
    }
    try {
      ensureDir(path.dirname(plan.targetPath));
      if (plan.kind === "move") {
        fs.renameSync(plan.sourcePath, plan.targetPath);
        changes.push(`Moved ${plan.label} → ${plan.targetPath}`);
      } else {
        fs.copyFileSync(plan.sourcePath, plan.targetPath);
        changes.push(`Copied ${plan.label} → ${plan.targetPath}`);
      }
    } catch (err) {
      warnings.push(`Failed migrating ${plan.label} (${plan.sourcePath}): ${String(err)}`);
    }
  }
  return { changes, warnings };
}

function canonicalizeSessionKeyForAgent(params: {
  key: string;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
  skipCrossAgentRemap?: boolean;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const raw = params.key.trim();
  if (!raw) {
    return raw;
  }
  const rawLower = normalizeLowercaseStringOrEmpty(raw);
  const normalized = normalizeSessionKeyPreservingOpaquePeerIds(raw);
  if (rawLower === "global" || rawLower === "unknown") {
    return rawLower;
  }

  // When shared-store guard is active, do not remap keys that belong to a
  // different agent — they are legitimate records for that agent, not orphans.
  // Without this check, canonicalizeMainSessionAlias (which now recognises
  // legacy agent:main:* aliases) would rewrite them before the
  // skipCrossAgentRemap guard below has a chance to block it.
  if (params.skipCrossAgentRemap) {
    const parsed = parseAgentSessionKey(raw);
    if (parsed && normalizeAgentId(parsed.agentId) !== agentId) {
      return normalized;
    }
    if (
      agentId !== DEFAULT_AGENT_ID &&
      (rawLower === DEFAULT_MAIN_KEY || rawLower === params.mainKey)
    ) {
      return rawLower;
    }
  }

  const canonicalMain = canonicalizeMainSessionAlias({
    cfg: { session: { scope: params.scope, mainKey: params.mainKey } },
    agentId,
    sessionKey: raw,
  });
  if (canonicalMain !== raw) {
    return normalizeLowercaseStringOrEmpty(canonicalMain);
  }

  // Handle cross-agent orphaned main-session keys: "agent:main:main" or
  // "agent:main:<mainKey>" in a store belonging to a different agent (e.g.
  // "ops"). Only remap provable orphan aliases — other agent:main:* keys
  // (hooks, subagents, cron, per-sender) may be intentional cross-agent
  // references and must not be touched (#29683).
  const defaultPrefix = `agent:${DEFAULT_AGENT_ID}:`;
  if (
    rawLower.startsWith(defaultPrefix) &&
    agentId !== DEFAULT_AGENT_ID &&
    !params.skipCrossAgentRemap
  ) {
    const rest = rawLower.slice(defaultPrefix.length);
    const isOrphanAlias = rest === DEFAULT_MAIN_KEY || rest === params.mainKey;
    if (isOrphanAlias) {
      const remapped = `agent:${agentId}:${rest}`;
      const canonicalized = canonicalizeMainSessionAlias({
        cfg: { session: { scope: params.scope, mainKey: params.mainKey } },
        agentId,
        sessionKey: remapped,
      });
      return normalizeLowercaseStringOrEmpty(canonicalized);
    }
  }

  if (rawLower.startsWith("agent:")) {
    return normalized;
  }
  if (rawLower.startsWith("subagent:")) {
    const rest = raw.slice("subagent:".length);
    return normalizeLowercaseStringOrEmpty(`agent:${agentId}:subagent:${rest}`);
  }
  // Channel-owned legacy shapes must win before the generic group/channel
  // fallback so plugin-specific legacy group keys can canonicalize to their
  // owning channel instead of the generic `...:unknown:group:...` bucket.
  for (const surface of getLegacySessionSurfaces()) {
    const canonicalized = surface.canonicalizeLegacySessionKey?.({
      key: raw,
      agentId,
    });
    const normalizedCanonicalized = normalizeSessionKeyPreservingOpaquePeerIds(canonicalized);
    if (normalizedCanonicalized) {
      return normalizedCanonicalized;
    }
  }
  if (rawLower.startsWith("group:") || rawLower.startsWith("channel:")) {
    return normalizeLowercaseStringOrEmpty(`agent:${agentId}:unknown:${raw}`);
  }
  if (isSurfaceGroupKey(raw)) {
    return `agent:${agentId}:${normalized}`;
  }
  return normalizeSessionKeyPreservingOpaquePeerIds(`agent:${agentId}:${raw}`);
}

function pickLatestLegacyDirectEntry(
  store: Record<string, SessionEntryLike>,
): SessionEntryLike | null {
  let best: SessionEntryLike | null = null;
  let bestUpdated = -1;
  for (const [key, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const normalized = key.trim();
    if (!normalized) {
      continue;
    }
    if (normalized === "global") {
      continue;
    }
    if (normalized.startsWith("agent:")) {
      continue;
    }
    if (normalizeLowercaseStringOrEmpty(normalized).startsWith("subagent:")) {
      continue;
    }
    if (isLegacyGroupKey(normalized) || isSurfaceGroupKey(normalized)) {
      continue;
    }
    const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
    if (updatedAt > bestUpdated) {
      bestUpdated = updatedAt;
      best = entry;
    }
  }
  return best;
}

function normalizeSessionEntry(entry: SessionEntryLike): SessionEntry | null {
  const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : null;
  if (!sessionId) {
    return null;
  }
  const updatedAt =
    typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
      ? entry.updatedAt
      : Date.now();
  const normalized = { ...(entry as unknown as SessionEntry), sessionId, updatedAt };
  const rec = normalized as unknown as Record<string, unknown>;
  if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
    rec.groupChannel = rec.room;
  }
  delete rec.room;
  return normalized;
}

function resolveUpdatedAt(entry: SessionEntryLike): number {
  return typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
    ? entry.updatedAt
    : 0;
}

function mergeSessionEntry(params: {
  existing: SessionEntryLike | undefined;
  incoming: SessionEntryLike;
  preferIncomingOnTie?: boolean;
}): SessionEntryLike {
  if (!params.existing) {
    return params.incoming;
  }
  const existingUpdated = resolveUpdatedAt(params.existing);
  const incomingUpdated = resolveUpdatedAt(params.incoming);
  if (incomingUpdated > existingUpdated) {
    return params.incoming;
  }
  if (incomingUpdated < existingUpdated) {
    return params.existing;
  }
  return params.preferIncomingOnTie ? params.incoming : params.existing;
}

function canonicalizeSessionStore(params: {
  store: Record<string, SessionEntryLike>;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
  skipCrossAgentRemap?: boolean;
}): { store: Record<string, SessionEntryLike>; legacyKeys: string[] } {
  const canonical: Record<string, SessionEntryLike> = {};
  const meta = new Map<string, { isCanonical: boolean; updatedAt: number }>();
  const legacyKeys: string[] = [];

  for (const [key, entry] of Object.entries(params.store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const canonicalKey = canonicalizeSessionKeyForAgent({
      key,
      agentId: params.agentId,
      mainKey: params.mainKey,
      scope: params.scope,
      skipCrossAgentRemap: params.skipCrossAgentRemap,
    });
    const isCanonical = canonicalKey === key;
    if (!isCanonical) {
      legacyKeys.push(key);
    }
    const existing = canonical[canonicalKey];
    if (!existing) {
      canonical[canonicalKey] = entry;
      meta.set(canonicalKey, { isCanonical, updatedAt: resolveUpdatedAt(entry) });
      continue;
    }

    const existingMeta = meta.get(canonicalKey);
    const incomingUpdated = resolveUpdatedAt(entry);
    const existingUpdated = existingMeta?.updatedAt ?? resolveUpdatedAt(existing);
    if (incomingUpdated > existingUpdated) {
      canonical[canonicalKey] = entry;
      meta.set(canonicalKey, { isCanonical, updatedAt: incomingUpdated });
      continue;
    }
    if (incomingUpdated < existingUpdated) {
      continue;
    }
    if (existingMeta?.isCanonical && !isCanonical) {
      continue;
    }
    if (!existingMeta?.isCanonical && isCanonical) {
      canonical[canonicalKey] = entry;
      meta.set(canonicalKey, { isCanonical, updatedAt: incomingUpdated });
      continue;
    }
  }

  return { store: canonical, legacyKeys };
}

function skipJson5Trivia(raw: string, index: number): number {
  let i = index;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
      i++;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "/") {
      i += 2;
      while (i < raw.length && raw[i] !== "\n") {
        i++;
      }
      continue;
    }
    if (ch === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) {
        i++;
      }
      return i < raw.length ? i + 2 : i;
    }
    break;
  }
  return i;
}

function readJson5String(raw: string, index: number): { value: string; next: number } | null {
  const quote = raw[index];
  if (quote !== '"' && quote !== "'") {
    return null;
  }
  let i = index + 1;
  let value = "";
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === quote) {
      return { value, next: i + 1 };
    }
    if (ch === "\\") {
      return null;
    }
    value += ch;
    i++;
  }
  return null;
}

function readJson5BareKey(raw: string, index: number): { value: string; next: number } | null {
  let i = index;
  while (i < raw.length) {
    const ch = raw[i];
    if (
      ch === ":" ||
      ch === " " ||
      ch === "\n" ||
      ch === "\r" ||
      ch === "\t" ||
      ch === "," ||
      ch === "}" ||
      ch === "{" ||
      ch === "[" ||
      ch === "]"
    ) {
      break;
    }
    i++;
  }
  if (i === index) {
    return null;
  }
  return { value: raw.slice(index, i), next: i };
}

function listTopLevelSessionStoreKeys(raw: string): string[] | null {
  let i = skipJson5Trivia(raw, 0);
  if (raw[i] !== "{") {
    return null;
  }
  i++;
  const keys: string[] = [];
  let depth = 1;
  let expectingKey = true;

  while (i < raw.length) {
    i = skipJson5Trivia(raw, i);
    const ch = raw[i];
    if (ch === undefined) {
      return null;
    }
    if (depth === 1 && ch === "}") {
      return keys;
    }
    if (depth === 1 && expectingKey) {
      const key = ch === '"' || ch === "'" ? readJson5String(raw, i) : readJson5BareKey(raw, i);
      if (!key) {
        return null;
      }
      i = skipJson5Trivia(raw, key.next);
      if (raw[i] !== ":") {
        return null;
      }
      keys.push(key.value);
      i++;
      expectingKey = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const str = readJson5String(raw, i);
      if (!str) {
        return null;
      }
      i = str.next;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth--;
      i++;
      if (depth < 1) {
        return keys;
      }
      continue;
    }
    if (depth === 1 && ch === ",") {
      expectingKey = true;
      i++;
      continue;
    }
    i++;
  }
  return null;
}

export function sessionStoreTextMayNeedCanonicalization(params: {
  raw: string;
  storeAgentIds: Iterable<string>;
  mainKey: string;
  scope?: SessionScope;
}): boolean {
  const keys = listTopLevelSessionStoreKeys(params.raw);
  if (!keys) {
    return true;
  }
  const storeAgentIds = new Set([...params.storeAgentIds].map((id) => normalizeAgentId(id)));
  const hasNonMainAgent = [...storeAgentIds].some((id) => id !== DEFAULT_AGENT_ID);
  for (const key of keys) {
    const rawKey = key.trim();
    if (rawKey !== key) {
      return true;
    }
    if (!rawKey) {
      continue;
    }
    const lowerKey = normalizeLowercaseStringOrEmpty(rawKey);
    if (lowerKey !== rawKey) {
      return true;
    }
    if (lowerKey === "global" || lowerKey === "unknown") {
      continue;
    }
    if (lowerKey === DEFAULT_MAIN_KEY || lowerKey === params.mainKey) {
      return true;
    }
    if (lowerKey.startsWith("subagent:")) {
      return true;
    }
    if (lowerKey.startsWith("group:") || lowerKey.startsWith("channel:")) {
      return true;
    }
    if (!lowerKey.startsWith("agent:")) {
      return true;
    }
    for (const storeAgentId of storeAgentIds) {
      const agentMainAlias = `agent:${storeAgentId}:${DEFAULT_MAIN_KEY}`;
      const agentMainKey = `agent:${storeAgentId}:${params.mainKey}`;
      if (
        lowerKey === agentMainAlias &&
        (params.mainKey !== DEFAULT_MAIN_KEY || params.scope === "global")
      ) {
        return true;
      }
      if (lowerKey === agentMainKey && params.scope === "global") {
        return true;
      }
    }
    if (
      lowerKey === `agent:${DEFAULT_AGENT_ID}:${DEFAULT_MAIN_KEY}` &&
      (params.mainKey !== DEFAULT_MAIN_KEY || hasNonMainAgent || params.scope === "global")
    ) {
      return true;
    }
    if (
      lowerKey === `agent:${DEFAULT_AGENT_ID}:${params.mainKey}` &&
      hasNonMainAgent &&
      !storeAgentIds.has(DEFAULT_AGENT_ID)
    ) {
      return true;
    }
  }
  return false;
}

function listLegacySessionKeys(params: {
  store: Record<string, SessionEntryLike>;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
}): string[] {
  const legacy: string[] = [];
  for (const key of Object.keys(params.store)) {
    const canonical = canonicalizeSessionKeyForAgent({
      key,
      agentId: params.agentId,
      mainKey: params.mainKey,
      scope: params.scope,
    });
    if (canonical !== key) {
      legacy.push(key);
    }
  }
  return legacy;
}

function emptyDirOrMissing(dir: string): boolean {
  if (!existsDir(dir)) {
    return true;
  }
  return safeReadDir(dir).length === 0;
}

function removeDirIfEmpty(dir: string) {
  if (!existsDir(dir)) {
    return;
  }
  if (!emptyDirOrMissing(dir)) {
    return;
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    // ignore
  }
}

export function resetAutoMigrateLegacyStateForTest() {
  autoMigrateChecked = false;
  autoMigrateTaskStateSidecarsChecked = false;
  cachedLegacySessionSurfaces = null;
}

export function resetAutoMigrateLegacyAgentDirForTest() {
  resetAutoMigrateLegacyStateForTest();
}

export function resetAutoMigrateLegacyStateDirForTest() {
  autoMigrateStateDirChecked = false;
}

export function resetAutoMigrateLegacyTaskStateSidecarsForTest() {
  autoMigrateTaskStateSidecarsChecked = false;
}

type StateDirMigrationResult = {
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
};

function resolveSymlinkTarget(linkPath: string): string | null {
  try {
    const target = fs.readlinkSync(linkPath);
    return path.resolve(path.dirname(linkPath), target);
  } catch {
    return null;
  }
}

function formatStateDirMigration(legacyDir: string, targetDir: string): string {
  return `State dir: ${legacyDir} → ${targetDir} (legacy path now symlinked)`;
}

function isDirPath(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isLegacyTreeSymlinkMirror(currentDir: string, realTargetDir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.length === 0) {
    return false;
  }

  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entryPath);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) {
      const resolvedTarget = resolveSymlinkTarget(entryPath);
      if (!resolvedTarget) {
        return false;
      }
      let resolvedRealTarget: string;
      try {
        resolvedRealTarget = fs.realpathSync(resolvedTarget);
      } catch {
        return false;
      }
      if (!isWithinDir(realTargetDir, resolvedRealTarget)) {
        return false;
      }
      continue;
    }
    if (stat.isDirectory()) {
      if (!isLegacyTreeSymlinkMirror(entryPath, realTargetDir)) {
        return false;
      }
      continue;
    }
    return false;
  }

  return true;
}

function isLegacyDirSymlinkMirror(legacyDir: string, targetDir: string): boolean {
  let realTargetDir: string;
  try {
    realTargetDir = fs.realpathSync(targetDir);
  } catch {
    return false;
  }
  return isLegacyTreeSymlinkMirror(legacyDir, realTargetDir);
}

export async function autoMigrateLegacyStateDir(params: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: MigrationLogger;
}): Promise<StateDirMigrationResult> {
  if (autoMigrateStateDirChecked) {
    return { migrated: false, skipped: true, changes: [], warnings: [] };
  }
  autoMigrateStateDirChecked = true;

  const homedir = params.homedir ?? os.homedir;
  const env = params.env ?? process.env;
  const warnings: string[] = [];
  const changes: string[] = [];
  const hasCustomStateDir = Boolean(env.OPENCLAW_STATE_DIR?.trim());
  const targetDir = hasCustomStateDir ? resolveStateDir(env, homedir) : resolveNewStateDir(homedir);
  const migratePluginInstallIndex = async () => {
    const result = await migrateLegacyInstalledPluginIndex({ stateDir: targetDir });
    changes.push(...result.changes);
    warnings.push(...result.warnings);
  };
  if (hasCustomStateDir) {
    await migratePluginInstallIndex();
    return {
      migrated: changes.length > 0,
      skipped: changes.length === 0 && warnings.length === 0,
      changes,
      warnings,
    };
  }

  const legacyDirs = resolveLegacyStateDirs(homedir);
  let legacyDir = legacyDirs.find((dir) => {
    try {
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  });

  let legacyStat: fs.Stats | null;
  try {
    legacyStat = legacyDir ? fs.lstatSync(legacyDir) : null;
  } catch {
    legacyStat = null;
  }
  if (!legacyStat) {
    await migratePluginInstallIndex();
    return { migrated: changes.length > 0, skipped: false, changes, warnings };
  }
  if (!legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
    warnings.push(`Legacy state path is not a directory: ${legacyDir}`);
    return { migrated: false, skipped: false, changes, warnings };
  }

  let symlinkDepth = 0;
  while (legacyStat.isSymbolicLink()) {
    const legacyTarget = legacyDir ? resolveSymlinkTarget(legacyDir) : null;
    if (!legacyTarget) {
      warnings.push(
        `Legacy state dir is a symlink (${legacyDir ?? "unknown"}); could not resolve target.`,
      );
      return { migrated: false, skipped: false, changes, warnings };
    }
    if (path.resolve(legacyTarget) === path.resolve(targetDir)) {
      await migratePluginInstallIndex();
      return { migrated: changes.length > 0, skipped: false, changes, warnings };
    }
    if (legacyDirs.some((dir) => path.resolve(dir) === path.resolve(legacyTarget))) {
      legacyDir = legacyTarget;
      try {
        legacyStat = fs.lstatSync(legacyDir);
      } catch {
        legacyStat = null;
      }
      if (!legacyStat) {
        warnings.push(`Legacy state dir missing after symlink resolution: ${legacyDir}`);
        return { migrated: false, skipped: false, changes, warnings };
      }
      if (!legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
        warnings.push(`Legacy state path is not a directory: ${legacyDir}`);
        return { migrated: false, skipped: false, changes, warnings };
      }
      symlinkDepth += 1;
      if (symlinkDepth > 2) {
        warnings.push(`Legacy state dir symlink chain too deep: ${legacyDir}`);
        return { migrated: false, skipped: false, changes, warnings };
      }
      continue;
    }
    warnings.push(
      `Legacy state dir is a symlink (${legacyDir ?? "unknown"} → ${legacyTarget}); skipping auto-migration.`,
    );
    return { migrated: false, skipped: false, changes, warnings };
  }

  if (isDirPath(targetDir)) {
    if (legacyDir && isLegacyDirSymlinkMirror(legacyDir, targetDir)) {
      await migratePluginInstallIndex();
      return { migrated: changes.length > 0, skipped: false, changes, warnings };
    }
    await migratePluginInstallIndex();
    warnings.push(
      `State dir migration skipped: target already exists (${targetDir}). Remove or merge manually.`,
    );
    return { migrated: changes.length > 0, skipped: false, changes, warnings };
  }

  try {
    if (!legacyDir) {
      throw new Error("Legacy state dir not found");
    }
    fs.renameSync(legacyDir, targetDir);
  } catch (err) {
    warnings.push(
      `Failed to move legacy state dir (${legacyDir ?? "unknown"} → ${targetDir}): ${String(err)}`,
    );
    return { migrated: false, skipped: false, changes, warnings };
  }

  try {
    if (!legacyDir) {
      throw new Error("Legacy state dir not found");
    }
    fs.symlinkSync(targetDir, legacyDir, "dir");
    changes.push(formatStateDirMigration(legacyDir, targetDir));
  } catch (err) {
    try {
      if (process.platform === "win32") {
        if (!legacyDir) {
          throw new Error("Legacy state dir not found", { cause: err });
        }
        fs.symlinkSync(targetDir, legacyDir, "junction");
        changes.push(formatStateDirMigration(legacyDir, targetDir));
      } else {
        throw err;
      }
    } catch (fallbackErr) {
      try {
        if (!legacyDir) {
          throw new Error("Legacy state dir not found", { cause: fallbackErr });
        }
        fs.renameSync(targetDir, legacyDir);
        warnings.push(
          `State dir migration rolled back (failed to link legacy path): ${String(fallbackErr)}`,
        );
        return { migrated: false, skipped: false, changes: [], warnings };
      } catch (rollbackErr) {
        warnings.push(
          `State dir moved but failed to link legacy path (${legacyDir ?? "unknown"} → ${targetDir}): ${String(fallbackErr)}`,
        );
        warnings.push(
          `Rollback failed; set OPENCLAW_STATE_DIR=${targetDir} to avoid split state: ${String(rollbackErr)}`,
        );
        changes.push(`State dir: ${legacyDir ?? "unknown"} → ${targetDir}`);
      }
    }
  }

  await migratePluginInstallIndex();
  return { migrated: changes.length > 0, skipped: false, changes, warnings };
}

export async function autoMigrateLegacyTaskStateSidecars(params: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: MigrationLogger;
}): Promise<{
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
}> {
  if (autoMigrateTaskStateSidecarsChecked) {
    return { migrated: false, skipped: true, changes: [], warnings: [] };
  }
  autoMigrateTaskStateSidecarsChecked = true;

  const stateDir = resolveStateDir(params.env ?? process.env, params.homedir);
  const result = await migrateLegacyTaskStateSidecars({ stateDir });
  const logger = params.log ?? createSubsystemLogger("state-migrations");
  if (result.changes.length > 0) {
    logger.info(
      `Auto-migrated legacy task state:\n${result.changes.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }
  if (result.warnings.length > 0) {
    logger.warn(
      `Legacy task state migration warnings:\n${result.warnings.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }
  return {
    migrated: result.changes.length > 0,
    skipped: false,
    changes: result.changes,
    warnings: result.warnings,
  };
}

async function collectChannelLegacyStateMigrationPlans(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  oauthDir: string;
}): Promise<ChannelLegacyStateMigrationPlan[]> {
  const plans: ChannelLegacyStateMigrationPlan[] = [];
  // Legacy state detection belongs on a narrow setup-entry surface so doctor
  // does not cold-load unrelated runtime channel code.
  const detectors = listBundledChannelLegacyStateMigrationDetectors({ config: params.cfg });
  for (const detectLegacyStateMigrationsLocal of detectors) {
    const detected = await detectLegacyStateMigrationsLocal({
      cfg: params.cfg,
      env: params.env,
      stateDir: params.stateDir,
      oauthDir: params.oauthDir,
    });
    if (detected?.length) {
      for (const detectedPlan of detected) {
        const plan =
          detectedPlan.kind === "plugin-state-import" && !detectedPlan.stateDir
            ? { ...detectedPlan, stateDir: params.stateDir }
            : detectedPlan;
        plans.push(plan);
      }
    }
  }
  return plans;
}

async function collectPluginDoctorStateMigrationPlans(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  oauthDir: string;
}): Promise<DetectedPluginDoctorStateMigrationPlan[]> {
  const plans: DetectedPluginDoctorStateMigrationPlan[] = [];
  for (const entry of listPluginDoctorStateMigrationEntries({
    config: params.cfg,
    env: params.env,
  })) {
    const detected = await entry.migration.detectLegacyState({
      config: params.cfg,
      env: params.env,
      stateDir: params.stateDir,
      oauthDir: params.oauthDir,
      context: createPluginDoctorStateMigrationContext(entry.pluginId, params.env),
    });
    if (detected?.preview.length) {
      plans.push({
        pluginId: entry.pluginId,
        migration: entry.migration,
        preview: detected.preview,
      });
    }
  }
  return plans;
}

function createPluginDoctorStateMigrationContext(
  pluginId: string,
  env: NodeJS.ProcessEnv,
): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStore<T>(pluginId, {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

export async function detectLegacyStateMigrations(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): Promise<LegacyStateDetection> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  const stateDir = resolveStateDir(env, homedir);
  const oauthDir = resolveOAuthDir(env, stateDir);

  const targetAgentId = normalizeAgentId(resolveDefaultAgentId(params.cfg));
  const rawMainKey = params.cfg.session?.mainKey;
  const targetMainKey =
    typeof rawMainKey === "string" && rawMainKey.trim().length > 0
      ? rawMainKey.trim()
      : DEFAULT_MAIN_KEY;
  const targetScope = params.cfg.session?.scope;

  const sessionsLegacyDir = path.join(stateDir, "sessions");
  const sessionsLegacyStorePath = path.join(sessionsLegacyDir, "sessions.json");
  const sessionsTargetDir = path.join(stateDir, "agents", targetAgentId, "sessions");
  const sessionsTargetStorePath = path.join(sessionsTargetDir, "sessions.json");
  const legacySessionEntries = safeReadDir(sessionsLegacyDir);
  const hasLegacySessions =
    fileExists(sessionsLegacyStorePath) ||
    legacySessionEntries.some((e) => e.isFile() && e.name.endsWith(".jsonl"));

  const targetSessionParsed = fileExists(sessionsTargetStorePath)
    ? readSessionStoreJson5(sessionsTargetStorePath)
    : { store: {}, ok: true };
  const legacyKeys = targetSessionParsed.ok
    ? listLegacySessionKeys({
        store: targetSessionParsed.store,
        agentId: targetAgentId,
        mainKey: targetMainKey,
        scope: targetScope,
      })
    : [];

  const legacyAgentDir = path.join(stateDir, "agent");
  const targetAgentDir = path.join(stateDir, "agents", targetAgentId, "agent");
  const hasLegacyAgentDir = existsDir(legacyAgentDir);
  const pluginStateSidecarPath = resolveLegacyPluginStateSidecarPath(stateDir);
  const hasPluginStateSidecar = fileExists(pluginStateSidecarPath);
  const pluginInstallIndexPath = resolveLegacyInstalledPluginIndexStorePath({ stateDir });
  const hasPluginInstallIndex = fileExists(pluginInstallIndexPath);
  const taskRunsSidecarPath = resolveLegacyTaskRunsSidecarPath(stateDir);
  const flowRunsSidecarPath = resolveLegacyFlowRunsSidecarPath(stateDir);
  const hasTaskStateSidecars = fileExists(taskRunsSidecarPath) || fileExists(flowRunsSidecarPath);
  const deliveryQueuePaths = {
    outboundPath: resolveLegacyDeliveryQueuePath(stateDir, "delivery-queue"),
    sessionPath: resolveLegacyDeliveryQueuePath(stateDir, "session-delivery-queue"),
  };
  const hasDeliveryQueues =
    listLegacyDeliveryQueueFiles(deliveryQueuePaths.outboundPath).length > 0 ||
    listLegacyDeliveryQueueDeliveredMarkers(deliveryQueuePaths.outboundPath).length > 0 ||
    listLegacyDeliveryQueueFiles(deliveryQueuePaths.sessionPath).length > 0 ||
    listLegacyDeliveryQueueDeliveredMarkers(deliveryQueuePaths.sessionPath).length > 0;
  const channelPlans = await collectChannelLegacyStateMigrationPlans({
    cfg: params.cfg,
    env,
    stateDir,
    oauthDir,
  });
  const pluginPlans = await collectPluginDoctorStateMigrationPlans({
    cfg: params.cfg,
    env,
    stateDir,
    oauthDir,
  });

  const preview: string[] = [];
  if (hasLegacySessions) {
    preview.push(`- Sessions: ${sessionsLegacyDir} → ${sessionsTargetDir}`);
  }
  if (legacyKeys.length > 0) {
    preview.push(`- Sessions: canonicalize legacy keys in ${sessionsTargetStorePath}`);
  }
  if (hasLegacyAgentDir) {
    preview.push(`- Agent dir: ${legacyAgentDir} → ${targetAgentDir}`);
  }
  if (hasPluginStateSidecar) {
    preview.push(`- Plugin state sidecar: ${pluginStateSidecarPath} → shared SQLite state`);
  }
  if (hasPluginInstallIndex) {
    preview.push(`- Plugin install index: ${pluginInstallIndexPath} → shared SQLite state`);
  }
  if (fileExists(taskRunsSidecarPath)) {
    preview.push(`- Task registry sidecar: ${taskRunsSidecarPath} → shared SQLite state`);
  }
  if (fileExists(flowRunsSidecarPath)) {
    preview.push(`- Task flow sidecar: ${flowRunsSidecarPath} → shared SQLite state`);
  }
  if (hasDeliveryQueues) {
    preview.push("- Delivery queues: legacy JSON queue files → shared SQLite state");
  }
  if (channelPlans.length > 0) {
    preview.push(...channelPlans.map(buildLegacyMigrationPreview));
  }
  if (pluginPlans.length > 0) {
    preview.push(...pluginPlans.flatMap((plan) => plan.preview));
  }

  return {
    targetAgentId,
    targetMainKey,
    targetScope,
    stateDir,
    oauthDir,
    sessions: {
      legacyDir: sessionsLegacyDir,
      legacyStorePath: sessionsLegacyStorePath,
      targetDir: sessionsTargetDir,
      targetStorePath: sessionsTargetStorePath,
      hasLegacy: hasLegacySessions || legacyKeys.length > 0,
      legacyKeys,
    },
    agentDir: {
      legacyDir: legacyAgentDir,
      targetDir: targetAgentDir,
      hasLegacy: hasLegacyAgentDir,
    },
    channelPlans: {
      hasLegacy: channelPlans.length > 0,
      plans: channelPlans,
    },
    pluginPlans: {
      hasLegacy: pluginPlans.length > 0,
      plans: pluginPlans,
    },
    pluginStateSidecar: {
      sourcePath: pluginStateSidecarPath,
      hasLegacy: hasPluginStateSidecar,
    },
    pluginInstallIndex: {
      sourcePath: pluginInstallIndexPath,
      hasLegacy: hasPluginInstallIndex,
    },
    taskStateSidecars: {
      taskRunsPath: taskRunsSidecarPath,
      flowRunsPath: flowRunsSidecarPath,
      hasLegacy: hasTaskStateSidecars,
    },
    deliveryQueues: {
      ...deliveryQueuePaths,
      hasLegacy: hasDeliveryQueues,
    },
    preview,
  };
}

async function migrateLegacySessions(
  detected: LegacyStateDetection,
  now: () => number,
  options: { recoverCorruptTargetStore?: boolean } = {},
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!detected.sessions.hasLegacy) {
    return { changes, warnings };
  }

  ensureDir(detected.sessions.targetDir);

  const legacyParsed = fileExists(detected.sessions.legacyStorePath)
    ? readSessionStoreJson5(detected.sessions.legacyStorePath)
    : { store: {}, ok: true };
  const targetParsed = fileExists(detected.sessions.targetStorePath)
    ? readSessionStoreJson5(detected.sessions.targetStorePath)
    : { store: {}, ok: true };
  const legacyStore = legacyParsed.store;
  const targetStore = targetParsed.store;

  const canonicalizedTarget = canonicalizeSessionStore({
    store: targetStore,
    agentId: detected.targetAgentId,
    mainKey: detected.targetMainKey,
    scope: detected.targetScope,
  });
  const canonicalizedLegacy = canonicalizeSessionStore({
    store: legacyStore,
    agentId: detected.targetAgentId,
    mainKey: detected.targetMainKey,
    scope: detected.targetScope,
  });

  const merged: Record<string, SessionEntryLike> = { ...canonicalizedTarget.store };
  for (const [key, entry] of Object.entries(canonicalizedLegacy.store)) {
    merged[key] = mergeSessionEntry({
      existing: merged[key],
      incoming: entry,
      preferIncomingOnTie: false,
    });
  }

  const mainKey = buildAgentMainSessionKey({
    agentId: detected.targetAgentId,
    mainKey: detected.targetMainKey,
  });
  let migratedDirectChatKey: string | undefined;
  if (!merged[mainKey]) {
    const latest = pickLatestLegacyDirectEntry(legacyStore);
    if (latest?.sessionId) {
      merged[mainKey] = latest;
      migratedDirectChatKey = mainKey;
    }
  }

  if (!legacyParsed.ok) {
    warnings.push(
      `Legacy sessions store unreadable; left in place at ${detected.sessions.legacyStorePath}`,
    );
  }

  const targetExists = fileExists(detected.sessions.targetStorePath);
  let targetReadable = !targetExists || targetParsed.ok;
  if (!targetReadable) {
    if (options.recoverCorruptTargetStore) {
      const archivedTargetPath = `${detected.sessions.targetStorePath}.corrupt-${now()}`;
      try {
        fs.renameSync(detected.sessions.targetStorePath, archivedTargetPath);
        changes.push(`Archived corrupt target sessions store → ${archivedTargetPath}`);
        targetReadable = true;
      } catch (err) {
        warnings.push(
          `Target sessions store unreadable; failed to archive ${detected.sessions.targetStorePath}: ${String(err)}`,
        );
      }
    } else {
      warnings.push(
        `Target sessions store unreadable; left untouched to avoid overwriting at ${detected.sessions.targetStorePath}. Run openclaw doctor --fix to archive it and retry the legacy merge.`,
      );
    }
  }

  if (
    targetReadable &&
    (legacyParsed.ok || targetParsed.ok) &&
    (Object.keys(legacyStore).length > 0 || Object.keys(targetStore).length > 0)
  ) {
    const normalized: Record<string, SessionEntry> = {};
    for (const [key, entry] of Object.entries(merged)) {
      const normalizedEntry = normalizeSessionEntry(entry);
      if (!normalizedEntry) {
        continue;
      }
      normalized[key] = normalizedEntry;
    }
    await saveSessionStore(detected.sessions.targetStorePath, normalized, {
      skipMaintenance: true,
    });
    if (migratedDirectChatKey) {
      changes.push(`Migrated latest direct-chat session → ${migratedDirectChatKey}`);
    }
    changes.push(`Merged sessions store → ${detected.sessions.targetStorePath}`);
    if (canonicalizedTarget.legacyKeys.length > 0) {
      changes.push(`Canonicalized ${canonicalizedTarget.legacyKeys.length} legacy session key(s)`);
    }
  }

  if (!targetReadable) {
    return { changes, warnings };
  }

  const entries = safeReadDir(detected.sessions.legacyDir);
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name === "sessions.json") {
      continue;
    }
    const from = path.join(detected.sessions.legacyDir, entry.name);
    const to = path.join(detected.sessions.targetDir, entry.name);
    if (fileExists(to)) {
      continue;
    }
    try {
      fs.renameSync(from, to);
      changes.push(`Moved ${entry.name} → agents/${detected.targetAgentId}/sessions`);
    } catch (err) {
      warnings.push(`Failed moving ${from}: ${String(err)}`);
    }
  }

  if (legacyParsed.ok && targetReadable) {
    try {
      if (fileExists(detected.sessions.legacyStorePath)) {
        fs.rmSync(detected.sessions.legacyStorePath, { force: true });
      }
    } catch {
      // ignore
    }
  }

  removeDirIfEmpty(detected.sessions.legacyDir);
  const legacyLeft = safeReadDir(detected.sessions.legacyDir).filter((e) => e.isFile());
  if (legacyLeft.length > 0) {
    const backupDir = `${detected.sessions.legacyDir}.legacy-${now()}`;
    try {
      fs.renameSync(detected.sessions.legacyDir, backupDir);
      warnings.push(`Left legacy sessions at ${backupDir}`);
    } catch {
      // ignore
    }
  }

  return { changes, warnings };
}

export async function migrateLegacyAgentDir(
  detected: LegacyStateDetection,
  now: () => number,
): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!detected.agentDir.hasLegacy) {
    return { changes, warnings };
  }

  ensureDir(detected.agentDir.targetDir);

  const entries = safeReadDir(detected.agentDir.legacyDir);
  for (const entry of entries) {
    const from = path.join(detected.agentDir.legacyDir, entry.name);
    const to = path.join(detected.agentDir.targetDir, entry.name);
    if (fs.existsSync(to)) {
      continue;
    }
    try {
      fs.renameSync(from, to);
      changes.push(`Moved agent file ${entry.name} → agents/${detected.targetAgentId}/agent`);
    } catch (err) {
      warnings.push(`Failed moving ${from}: ${String(err)}`);
    }
  }

  removeDirIfEmpty(detected.agentDir.legacyDir);
  if (!emptyDirOrMissing(detected.agentDir.legacyDir)) {
    const backupDir = path.join(
      detected.stateDir,
      "agents",
      detected.targetAgentId,
      `agent.legacy-${now()}`,
    );
    try {
      fs.renameSync(detected.agentDir.legacyDir, backupDir);
      warnings.push(`Left legacy agent dir at ${backupDir}`);
    } catch (err) {
      warnings.push(`Failed relocating legacy agent dir: ${String(err)}`);
    }
  }

  return { changes, warnings };
}

async function runPluginDoctorStateMigrationPlans(params: {
  detected: LegacyStateDetection;
  config: OpenClawConfig;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const refreshedPlans = await collectPluginDoctorStateMigrationPlans({
    cfg: params.config,
    env: process.env,
    stateDir: params.detected.stateDir,
    oauthDir: params.detected.oauthDir,
  });
  const plans =
    refreshedPlans.length > 0 ? refreshedPlans : (params.detected.pluginPlans?.plans ?? []);
  for (const plan of plans) {
    try {
      const result = await plan.migration.migrateLegacyState({
        config: params.config,
        env: process.env,
        stateDir: params.detected.stateDir,
        oauthDir: params.detected.oauthDir,
        context: createPluginDoctorStateMigrationContext(plan.pluginId, process.env),
      });
      changes.push(...result.changes);
      warnings.push(...result.warnings);
    } catch (err) {
      warnings.push(`Failed migrating ${plan.migration.label}: ${String(err)}`);
    }
  }
  return { changes, warnings };
}

export async function runLegacyStateMigrations(params: {
  detected: LegacyStateDetection;
  config?: OpenClawConfig;
  now?: () => number;
  recoverCorruptTargetStore?: boolean;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const now = params.now ?? (() => Date.now());
  const detected = params.detected;
  const pluginStateSidecar = await migrateLegacyPluginStateSidecar({
    stateDir: detected.stateDir,
  });
  const pluginInstallIndex = await migrateLegacyInstalledPluginIndex({
    stateDir: detected.stateDir,
  });
  const taskStateSidecars = await migrateLegacyTaskStateSidecars({
    stateDir: detected.stateDir,
  });
  const deliveryQueues = await migrateLegacyDeliveryQueues({
    stateDir: detected.stateDir,
  });
  const preSessionChannelPlans = await runLegacyMigrationPlans(
    detected.channelPlans.plans.filter((plan) => plan.kind === "plugin-state-import"),
  );
  const pluginPlans = await runPluginDoctorStateMigrationPlans({
    detected,
    config: params.config ?? ({} as OpenClawConfig),
  });
  const sessions = await migrateLegacySessions(detected, now, {
    recoverCorruptTargetStore: params.recoverCorruptTargetStore,
  });
  const acpSessionMetadata = await migrateLegacyAcpSessionMetadata({
    cfg: params.config ?? ({} as OpenClawConfig),
    env: { ...process.env, OPENCLAW_STATE_DIR: detected.stateDir },
    now,
  });
  const agentDir = await migrateLegacyAgentDir(detected, now);
  const channelPlans = await runLegacyMigrationPlans(
    detected.channelPlans.plans.filter((plan) => plan.kind !== "plugin-state-import"),
  );
  return {
    changes: [
      ...pluginStateSidecar.changes,
      ...pluginInstallIndex.changes,
      ...taskStateSidecars.changes,
      ...deliveryQueues.changes,
      ...preSessionChannelPlans.changes,
      ...pluginPlans.changes,
      ...sessions.changes,
      ...acpSessionMetadata.changes,
      ...agentDir.changes,
      ...channelPlans.changes,
    ],
    warnings: [
      ...pluginStateSidecar.warnings,
      ...pluginInstallIndex.warnings,
      ...taskStateSidecars.warnings,
      ...deliveryQueues.warnings,
      ...preSessionChannelPlans.warnings,
      ...pluginPlans.warnings,
      ...sessions.warnings,
      ...acpSessionMetadata.warnings,
      ...agentDir.warnings,
      ...channelPlans.warnings,
    ],
  };
}

export async function autoMigrateLegacyAgentDir(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: MigrationLogger;
  now?: () => number;
}): Promise<{
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
}> {
  return await autoMigrateLegacyState(params);
}

/**
 * Canonicalize orphaned raw session keys in all known agent session stores.
 *
 * Keys written by resolveSessionKey() used DEFAULT_AGENT_ID="main" regardless
 * of the configured default agent; reads always use resolveSessionStoreKey()
 * which canonicalizes via canonicalizeMainSessionAlias. This migration renames
 * any orphaned raw keys to their canonical form in-place, merging with any
 * existing canonical entry by preferring the most recently updated.
 *
 * Safe to run multiple times (idempotent). See #29683.
 */
export async function migrateOrphanedSessionKeys(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const agentId = normalizeAgentId(resolveDefaultAgentId(params.cfg));
  const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
  const scope = params.cfg.session?.scope as SessionScope | undefined;
  const storeConfig = params.cfg.session?.store;

  // Collect all known agent store paths with their owning agentIds.
  // A single path may be shared by multiple agents when session.store
  // does not contain {agentId}.
  const storeMap = new Map<string, Set<string>>();
  const addToStoreMap = (p: string, id: string) => {
    const existing = storeMap.get(p);
    if (existing) {
      existing.add(id);
    } else {
      storeMap.set(p, new Set([id]));
    }
  };
  // Default agent store.
  const defaultStorePath = storeConfig
    ? resolveStorePathFromTemplate(storeConfig, agentId, env)
    : path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
  addToStoreMap(defaultStorePath, agentId);
  // Configured agents.
  for (const entry of params.cfg.agents?.list ?? []) {
    if (entry?.id) {
      const id = normalizeAgentId(entry.id);
      const p = storeConfig
        ? resolveStorePathFromTemplate(storeConfig, id, env)
        : path.join(stateDir, "agents", id, "sessions", "sessions.json");
      addToStoreMap(p, id);
    }
  }
  // Agent directories present on disk.
  // This only covers the standard state-dir layout so we can still pick up
  // orphaned stores left behind by older configs. Active custom-template paths
  // are already covered by the configured-agents loop above.
  const agentsDir = path.join(stateDir, "agents");
  if (existsDir(agentsDir)) {
    for (const dirEntry of safeReadDir(agentsDir)) {
      if (dirEntry.isDirectory()) {
        const diskAgentId = normalizeAgentId(dirEntry.name);
        if (diskAgentId) {
          const diskPath = path.join(agentsDir, diskAgentId, "sessions", "sessions.json");
          addToStoreMap(diskPath, diskAgentId);
        }
      }
    }
  }

  for (const [storePath, storeAgentIds] of storeMap) {
    if (!fileExists(storePath)) {
      continue;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(storePath, "utf-8");
    } catch (err) {
      warnings.push(`Could not read ${storePath}: ${String(err)}`);
      continue;
    }
    if (
      !sessionStoreTextMayNeedCanonicalization({
        raw,
        storeAgentIds,
        mainKey,
        scope,
      })
    ) {
      continue;
    }
    let parsed: ReturnType<typeof readSessionStoreJson5>;
    try {
      parsed = parseSessionStoreJson5(raw);
    } catch (err) {
      warnings.push(`Could not read ${storePath}: ${String(err)}`);
      continue;
    }
    if (!parsed.ok) {
      continue;
    }

    // When multiple agents share a single store file (session.store without
    // {agentId}), run canonicalization once per agent so each agent's keys are
    // handled correctly. Skip cross-agent "agent:main:*" remapping when "main"
    // is a legitimate configured agent to avoid merging its data into another
    // agent's namespace.
    let working = parsed.store;
    let totalLegacy = 0;
    for (const storeAgentId of storeAgentIds) {
      const { store: canonicalized, legacyKeys } = canonicalizeSessionStore({
        store: working,
        agentId: storeAgentId,
        mainKey,
        scope,
        // When multiple agents share the store and "main" is one of them,
        // agent:main:* keys are legitimate — don't cross-agent remap them.
        skipCrossAgentRemap: storeAgentIds.size > 1 && storeAgentIds.has(DEFAULT_AGENT_ID),
      });
      working = canonicalized;
      // Each pass only counts keys it changed from the current working store, so
      // once a key is canonicalized it is not counted again by later agent passes.
      totalLegacy += legacyKeys.length;
    }
    if (totalLegacy === 0) {
      continue;
    }

    const normalized: Record<string, SessionEntry> = {};
    for (const [key, entry] of Object.entries(working)) {
      const ne = normalizeSessionEntry(entry);
      if (ne) {
        normalized[key] = ne;
      }
    }
    try {
      await saveSessionStore(storePath, normalized, { skipMaintenance: true });
      changes.push(`Canonicalized ${totalLegacy} orphaned session key(s) in ${storePath}`);
    } catch (err) {
      warnings.push(`Failed to write canonicalized store ${storePath}: ${String(err)}`);
    }
  }

  return { changes, warnings };
}

async function migrateLegacyAcpSessionMetadata(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const env = params.env ?? process.env;
  const now = params.now ?? (() => Date.now());
  const targets = resolveAllAgentSessionStoreTargetsSync(params.cfg, { env });
  const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
  const scope = params.cfg.session?.scope as SessionScope | undefined;
  const seenStorePaths = new Set<string>();

  for (const target of targets) {
    const storePath = target.storePath;
    if (seenStorePaths.has(storePath) || !fileExists(storePath)) {
      continue;
    }
    seenStorePaths.add(storePath);
    let parsed: ReturnType<typeof readSessionStoreJson5>;
    try {
      parsed = readSessionStoreJson5(storePath);
    } catch (err) {
      warnings.push(`Could not read ${storePath}: ${String(err)}`);
      continue;
    }
    if (!parsed.ok) {
      continue;
    }

    const normalized: Record<string, SessionEntry> = {};
    let migrated = 0;
    for (const [sessionKey, entry] of Object.entries(parsed.store)) {
      const normalizedEntry = normalizeSessionEntry(entry);
      if (!normalizedEntry) {
        continue;
      }
      if (normalizedEntry.acp) {
        const canonicalSessionKey = canonicalizeSessionKeyForAgent({
          key: sessionKey,
          agentId: target.agentId,
          mainKey,
          scope,
          skipCrossAgentRemap: true,
        });
        writeAcpSessionMetaForMigration({
          sessionKey: canonicalSessionKey,
          sessionId: normalizedEntry.sessionId,
          meta: normalizedEntry.acp,
          env,
          now,
        });
        delete normalizedEntry.acp;
        migrated++;
      }
      normalized[sessionKey] = normalizedEntry;
    }
    if (migrated === 0) {
      continue;
    }
    try {
      await saveSessionStore(storePath, normalized, { skipMaintenance: true });
      changes.push(
        `Migrated ${migrated} ACP session metadata ${migrated === 1 ? "row" : "rows"} → shared SQLite state`,
      );
    } catch (err) {
      warnings.push(`Failed to write ACP metadata migration source ${storePath}: ${String(err)}`);
    }
  }

  return { changes, warnings };
}

function resolveStorePathFromTemplate(
  template: string,
  agentId: string,
  env?: NodeJS.ProcessEnv,
): string {
  const expand = (s: string) =>
    s.startsWith("~") ? expandHomePrefix(s, { env: env ?? process.env, homedir: os.homedir }) : s;
  if (template.includes("{agentId}")) {
    return path.resolve(expand(template.replaceAll("{agentId}", agentId)));
  }
  return path.resolve(expand(template));
}

export async function autoMigrateLegacyState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: MigrationLogger;
  now?: () => number;
  recoverCorruptTargetStore?: boolean;
}): Promise<{
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
}> {
  if (autoMigrateChecked) {
    return { migrated: false, skipped: true, changes: [], warnings: [] };
  }
  autoMigrateChecked = true;

  const env = params.env ?? process.env;
  const stateDirResult = await autoMigrateLegacyStateDir({
    env,
    homedir: params.homedir,
    log: params.log,
  });

  // Canonicalize orphaned session keys regardless of whether legacy migration
  // is needed — the orphan-key bug (#29683) affects all installs with
  // non-default agent IDs or mainKey configuration.
  const orphanKeys = await migrateOrphanedSessionKeys({
    cfg: params.cfg,
    env,
  });
  const acpSessionMetadata = await migrateLegacyAcpSessionMetadata({
    cfg: params.cfg,
    env,
    now: params.now,
  });

  const logMigrationResults = (changes: string[], warnings: string[]) => {
    const logger = params.log ?? createSubsystemLogger("state-migrations");
    if (changes.length > 0) {
      logger.info(
        `Auto-migrated legacy state:\n${changes.map((entry) => `- ${entry}`).join("\n")}`,
      );
    }
    if (warnings.length > 0) {
      logger.warn(
        `Legacy state migration warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`,
      );
    }
  };

  const detected = await detectLegacyStateMigrations({
    cfg: params.cfg,
    env,
    homedir: params.homedir,
  });
  const hasCustomAgentDir = env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
  if (hasCustomAgentDir) {
    const pluginStateSidecar = await migrateLegacyPluginStateSidecar({
      stateDir: detected.stateDir,
    });
    const pluginInstallIndex = await migrateLegacyInstalledPluginIndex({
      stateDir: detected.stateDir,
    });
    const taskStateSidecars = await migrateLegacyTaskStateSidecars({
      stateDir: detected.stateDir,
    });
    const deliveryQueues = await migrateLegacyDeliveryQueues({
      stateDir: detected.stateDir,
    });
    const preSessionChannelPlans = await runLegacyMigrationPlans(
      detected.channelPlans.plans.filter((plan) => plan.kind === "plugin-state-import"),
    );
    const pluginPlans = await runPluginDoctorStateMigrationPlans({
      detected,
      config: params.cfg,
    });
    const changes = [
      ...stateDirResult.changes,
      ...orphanKeys.changes,
      ...acpSessionMetadata.changes,
      ...pluginStateSidecar.changes,
      ...pluginInstallIndex.changes,
      ...taskStateSidecars.changes,
      ...deliveryQueues.changes,
      ...preSessionChannelPlans.changes,
      ...pluginPlans.changes,
    ];
    const warnings = [
      ...stateDirResult.warnings,
      ...orphanKeys.warnings,
      ...acpSessionMetadata.warnings,
      ...pluginStateSidecar.warnings,
      ...pluginInstallIndex.warnings,
      ...taskStateSidecars.warnings,
      ...deliveryQueues.warnings,
      ...preSessionChannelPlans.warnings,
      ...pluginPlans.warnings,
    ];
    logMigrationResults(changes, warnings);
    return {
      migrated:
        stateDirResult.migrated ||
        orphanKeys.changes.length > 0 ||
        acpSessionMetadata.changes.length > 0 ||
        pluginStateSidecar.changes.length > 0 ||
        pluginInstallIndex.changes.length > 0 ||
        taskStateSidecars.changes.length > 0 ||
        deliveryQueues.changes.length > 0 ||
        preSessionChannelPlans.changes.length > 0 ||
        pluginPlans.changes.length > 0,
      skipped: true,
      changes,
      warnings,
    };
  }
  if (
    !detected.sessions.hasLegacy &&
    !detected.agentDir.hasLegacy &&
    !detected.channelPlans.hasLegacy &&
    !detected.pluginPlans?.hasLegacy &&
    !detected.pluginStateSidecar.hasLegacy &&
    !detected.pluginInstallIndex.hasLegacy &&
    !detected.taskStateSidecars.hasLegacy &&
    !detected.deliveryQueues.hasLegacy
  ) {
    const changes = [
      ...stateDirResult.changes,
      ...orphanKeys.changes,
      ...acpSessionMetadata.changes,
    ];
    const warnings = [
      ...stateDirResult.warnings,
      ...orphanKeys.warnings,
      ...acpSessionMetadata.warnings,
    ];
    logMigrationResults(changes, warnings);
    return {
      migrated:
        stateDirResult.migrated ||
        orphanKeys.changes.length > 0 ||
        acpSessionMetadata.changes.length > 0,
      skipped: false,
      changes,
      warnings,
    };
  }

  const now = params.now ?? (() => Date.now());
  const pluginStateSidecar = await migrateLegacyPluginStateSidecar({
    stateDir: detected.stateDir,
  });
  const pluginInstallIndex = await migrateLegacyInstalledPluginIndex({
    stateDir: detected.stateDir,
  });
  const taskStateSidecars = await migrateLegacyTaskStateSidecars({
    stateDir: detected.stateDir,
  });
  const deliveryQueues = await migrateLegacyDeliveryQueues({
    stateDir: detected.stateDir,
  });
  const preSessionChannelPlans = await runLegacyMigrationPlans(
    detected.channelPlans.plans.filter((plan) => plan.kind === "plugin-state-import"),
  );
  const pluginPlans = await runPluginDoctorStateMigrationPlans({
    detected,
    config: params.cfg,
  });
  const sessions = await migrateLegacySessions(detected, now, {
    recoverCorruptTargetStore: params.recoverCorruptTargetStore,
  });
  const postSessionAcpMetadata = await migrateLegacyAcpSessionMetadata({
    cfg: params.cfg,
    env,
    now,
  });
  const agentDir = await migrateLegacyAgentDir(detected, now);
  const channelPlans = await runLegacyMigrationPlans(
    detected.channelPlans.plans.filter((plan) => plan.kind !== "plugin-state-import"),
  );
  const changes = [
    ...stateDirResult.changes,
    ...orphanKeys.changes,
    ...acpSessionMetadata.changes,
    ...pluginStateSidecar.changes,
    ...pluginInstallIndex.changes,
    ...taskStateSidecars.changes,
    ...deliveryQueues.changes,
    ...preSessionChannelPlans.changes,
    ...pluginPlans.changes,
    ...sessions.changes,
    ...postSessionAcpMetadata.changes,
    ...agentDir.changes,
    ...channelPlans.changes,
  ];
  const warnings = [
    ...stateDirResult.warnings,
    ...orphanKeys.warnings,
    ...acpSessionMetadata.warnings,
    ...pluginStateSidecar.warnings,
    ...pluginInstallIndex.warnings,
    ...taskStateSidecars.warnings,
    ...deliveryQueues.warnings,
    ...preSessionChannelPlans.warnings,
    ...pluginPlans.warnings,
    ...sessions.warnings,
    ...postSessionAcpMetadata.warnings,
    ...agentDir.warnings,
    ...channelPlans.warnings,
  ];

  logMigrationResults(changes, warnings);

  return {
    migrated: changes.length > 0,
    skipped: false,
    changes,
    warnings,
  };
}
