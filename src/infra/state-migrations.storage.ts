import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/types.core.js";
import { parseInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import {
  INSTALLED_PLUGIN_INDEX_MIGRATION_VERSION,
  INSTALLED_PLUGIN_INDEX_VERSION,
  type InstalledPluginIndex,
} from "../plugins/installed-plugin-index.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { parseRegistryNpmSpec } from "./npm-registry-spec.js";
import { fileExists, safeReadDir } from "./state-migrations.fs.js";
import {
  insertTaskDeliveryRowSql,
  insertTaskRunRowSql,
  legacyBindValue,
  listSqliteColumns,
  normalizeLegacySqliteInteger,
  pickLegacyColumn,
  readLegacyTaskDeliveryRows,
  readLegacyTaskRows,
  type SqliteBindRow,
} from "./state-migrations.task-sidecar-rows.js";

export { normalizeLegacySqliteInteger };

export type LegacyPluginStateSidecarRow = {
  plugin_id: string;
  namespace: string;
  entry_key: string;
  value_json: string;
  created_at: number | bigint;
  expires_at: number | bigint | null;
};

// Move the canonical database first so a partial archive never leaves a
// readable database separated from committed WAL rows. Pending sidecars are
// detected and archived without reopening the migrated database.
export const PLUGIN_STATE_SQLITE_SIDECAR_SUFFIXES = ["", "-shm", "-wal", "-journal"] as const;
export const TASK_STATE_SQLITE_SIDECAR_SUFFIXES = ["", "-shm", "-wal", "-journal"] as const;
const LEGACY_DELIVERY_QUEUE_DIRS = [
  { label: "outbound delivery queue", queueName: "outbound", dirName: "delivery-queue" },
  { label: "session delivery queue", queueName: "session", dirName: "session-delivery-queue" },
] as const;
type LegacyDeliveryQueueFile = {
  sourcePath: string;
  status: "pending" | "failed";
};

class LegacyTaskStateSidecarConflictError extends Error {
  constructor(readonly conflictedKeys: string[]) {
    super("legacy task-state sidecar conflicts with shared state");
  }
}

export function buildLegacyMigrationPreview(plan: ChannelLegacyStateMigrationPlan): string {
  if (plan.kind === "plugin-state-import") {
    return plan.preview ?? `- ${plan.label}: ${plan.sourcePath}`;
  }
  return `- ${plan.label}: ${plan.sourcePath} → ${plan.targetPath}`;
}

export function resolveLegacyPluginStateSidecarPath(stateDir: string): string {
  return path.join(stateDir, "plugin-state", "state.sqlite");
}

export function resolveLegacyTaskRunsSidecarPath(stateDir: string): string {
  return path.join(stateDir, "tasks", "runs.sqlite");
}

export function resolveLegacyFlowRunsSidecarPath(stateDir: string): string {
  return path.join(stateDir, "flows", "registry.sqlite");
}

export function readLegacyPluginStateSidecarRows(
  sourcePath: string,
): LegacyPluginStateSidecarRow[] {
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

export function legacyPluginStateRowsMatch(
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

export function isLegacyPluginStateRowExpired(
  row: LegacyPluginStateSidecarRow,
  now: number,
): boolean {
  const expiresAt = normalizeLegacySqliteInteger(row.expires_at);
  return expiresAt !== null && expiresAt <= now;
}

export function hasPendingSqliteSidecarArchive(
  sourcePath: string,
  suffixes: readonly string[],
): boolean {
  return (
    !fileExists(sourcePath) &&
    fileExists(`${sourcePath}.migrated`) &&
    suffixes.some((suffix) => suffix !== "" && fileExists(`${sourcePath}${suffix}`))
  );
}

type LegacyArchiveResolution = {
  sourcePath: string;
  targetPath: string;
  action: "archived" | "removed";
};

function firstFreeArchivePath(sourcePath: string): string {
  for (let index = 2; ; index++) {
    const candidate = `${sourcePath}.migrated.${index}`;
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
}

function archiveLegacyFileSource(params: {
  sourcePath: string;
  label: string;
  warnings: string[];
}): LegacyArchiveResolution | null {
  const archivedPath = `${params.sourcePath}.migrated`;
  try {
    if (fileExists(archivedPath)) {
      // Import has already committed before archival. Identical archive bytes
      // preserve the same snapshot, so the leftover source can be removed.
      if (fs.readFileSync(params.sourcePath).equals(fs.readFileSync(archivedPath))) {
        fs.rmSync(params.sourcePath, { force: true });
        return { sourcePath: params.sourcePath, targetPath: archivedPath, action: "removed" };
      }
      const nextArchivePath = firstFreeArchivePath(params.sourcePath);
      fs.renameSync(params.sourcePath, nextArchivePath);
      return { sourcePath: params.sourcePath, targetPath: nextArchivePath, action: "archived" };
    }
    fs.renameSync(params.sourcePath, archivedPath);
    return { sourcePath: params.sourcePath, targetPath: archivedPath, action: "archived" };
  } catch (err) {
    params.warnings.push(`Failed archiving ${params.label} ${params.sourcePath}: ${String(err)}`);
    return null;
  }
}

function recordArchiveCollisionResolutions(
  changes: string[],
  label: string,
  resolutions: readonly LegacyArchiveResolution[],
): void {
  for (const resolution of resolutions) {
    changes.push(
      resolution.action === "removed"
        ? `Removed already-archived ${label} legacy source ${resolution.sourcePath}`
        : `Archived ${label} legacy source → ${resolution.targetPath}`,
    );
  }
}

export function archiveLegacyPluginStateSidecar(params: {
  sourcePath: string;
  changes: string[];
  warnings: string[];
}): void {
  const existingSources = PLUGIN_STATE_SQLITE_SIDECAR_SUFFIXES.map(
    (suffix) => `${params.sourcePath}${suffix}`,
  ).filter(fileExists);
  if (existingSources.length === 0) {
    return;
  }

  const resolutions: LegacyArchiveResolution[] = [];
  for (const sourcePath of existingSources) {
    const resolution = archiveLegacyFileSource({
      sourcePath,
      label: "plugin-state sidecar",
      warnings: params.warnings,
    });
    if (!resolution) {
      return;
    }
    resolutions.push(resolution);
  }
  if (
    resolutions.every(
      (resolution) =>
        resolution.action === "archived" &&
        resolution.targetPath === `${resolution.sourcePath}.migrated`,
    )
  ) {
    params.changes.push(
      `Archived plugin-state sidecar legacy source → ${params.sourcePath}.migrated`,
    );
  } else {
    recordArchiveCollisionResolutions(params.changes, "plugin-state sidecar", resolutions);
  }
}

export function readLegacyInstalledPluginIndex(sourcePath: string): InstalledPluginIndex | null {
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

export function legacyInstalledPluginIndexMatches(
  current: InstalledPluginIndex,
  legacy: InstalledPluginIndex,
): boolean {
  return (
    JSON.stringify(current.installRecords) === JSON.stringify(legacy.installRecords) &&
    JSON.stringify(current.plugins) === JSON.stringify(legacy.plugins) &&
    JSON.stringify(current.diagnostics) === JSON.stringify(legacy.diagnostics)
  );
}

function readInstallRecordField(
  record: InstalledPluginIndex["installRecords"][string],
  key: string,
): unknown {
  return (record as Partial<Record<string, unknown>>)[key];
}

function readInstallRecordStringField(
  record: InstalledPluginIndex["installRecords"][string],
  key: string,
): string | undefined {
  const value = readInstallRecordField(record, key);
  return typeof value === "string" ? value : undefined;
}

function legacyInstallRecordHasCurrentResolvedIdentity(params: {
  currentRecord: InstalledPluginIndex["installRecords"][string];
  legacyRecord: InstalledPluginIndex["installRecords"][string];
}): boolean {
  const { currentRecord, legacyRecord } = params;
  const currentResolvedSpec = readInstallRecordStringField(currentRecord, "resolvedSpec");
  const legacySpec = readInstallRecordStringField(legacyRecord, "spec");
  if (legacySpec) {
    return currentResolvedSpec === legacySpec;
  }
  const legacyResolvedSpec = readInstallRecordStringField(legacyRecord, "resolvedSpec");
  return Boolean(legacyResolvedSpec && currentResolvedSpec === legacyResolvedSpec);
}

function readAuthoritativeCurrentNpmIdentity(
  record: InstalledPluginIndex["installRecords"][string],
): { name: string; version: string } | null {
  const resolvedName = readInstallRecordStringField(record, "resolvedName");
  const resolvedVersion = readInstallRecordStringField(record, "resolvedVersion");
  if (resolvedName && resolvedVersion) {
    return { name: resolvedName, version: resolvedVersion };
  }
  const resolvedSpec = readInstallRecordStringField(record, "resolvedSpec");
  const parsed = resolvedSpec ? parseRegistryNpmSpec(resolvedSpec) : null;
  if (parsed?.selectorKind === "exact-version" && parsed.selector) {
    return { name: parsed.name, version: parsed.selector };
  }
  return null;
}

function legacyNpmInstallRecordSupersededByCurrent(params: {
  currentRecord: InstalledPluginIndex["installRecords"][string];
  legacyRecord: InstalledPluginIndex["installRecords"][string];
}): boolean {
  const { currentRecord, legacyRecord } = params;
  if (currentRecord.source !== "npm" || legacyRecord.source !== "npm") {
    return false;
  }
  const legacySpec = readInstallRecordStringField(legacyRecord, "spec");
  const legacyParsedSpec = legacySpec ? parseRegistryNpmSpec(legacySpec) : null;
  if (legacyParsedSpec?.selectorKind !== "exact-version") {
    return false;
  }
  const currentIdentity = readAuthoritativeCurrentNpmIdentity(currentRecord);
  return Boolean(
    currentIdentity &&
    legacyParsedSpec.selector &&
    currentIdentity.name === legacyParsedSpec.name &&
    currentIdentity.version === legacyParsedSpec.selector,
  );
}

function legacyInstallRecordCoveredByCurrent(
  currentRecord: InstalledPluginIndex["installRecords"][string],
  legacyRecord: InstalledPluginIndex["installRecords"][string],
): boolean {
  if (currentRecord.source !== legacyRecord.source) {
    return false;
  }
  if (legacyNpmInstallRecordSupersededByCurrent({ currentRecord, legacyRecord })) {
    return true;
  }
  for (const key of Object.keys(legacyRecord).toSorted()) {
    const currentValue = readInstallRecordField(currentRecord, key);
    if (currentValue === readInstallRecordField(legacyRecord, key)) {
      continue;
    }
    if (
      key === "spec" &&
      legacyInstallRecordHasCurrentResolvedIdentity({ currentRecord, legacyRecord })
    ) {
      continue;
    }
    if ((key === "resolvedAt" || key === "installedAt") && typeof currentValue === "string") {
      continue;
    }
    return false;
  }
  return true;
}

export function mergeLegacyInstalledPluginIndexRecords(
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
    if (!legacyInstallRecordCoveredByCurrent(currentRecord, legacyRecord)) {
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

export function archiveLegacyInstalledPluginIndex(params: {
  sourcePath: string;
  changes: string[];
  warnings: string[];
}): void {
  const resolution = archiveLegacyFileSource({
    sourcePath: params.sourcePath,
    label: "plugin install index",
    warnings: params.warnings,
  });
  if (!resolution) {
    return;
  }
  params.changes.push(
    resolution.action === "removed"
      ? `Removed already-archived plugin install index legacy source ${params.sourcePath}`
      : `Archived plugin install index legacy source → ${resolution.targetPath}`,
  );
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
  if (existingSources.length === 0) {
    return;
  }
  const resolutions: LegacyArchiveResolution[] = [];
  for (const sourcePath of existingSources) {
    const resolution = archiveLegacyFileSource({
      sourcePath,
      label: `${params.label} sidecar`,
      warnings: params.warnings,
    });
    if (!resolution) {
      return;
    }
    resolutions.push(resolution);
  }
  if (
    resolutions.every(
      (resolution) =>
        resolution.action === "archived" &&
        resolution.targetPath === `${resolution.sourcePath}.migrated`,
    )
  ) {
    params.changes.push(
      `Archived ${params.label} sidecar legacy source → ${params.sourcePath}.migrated`,
    );
  } else {
    recordArchiveCollisionResolutions(params.changes, `${params.label} sidecar`, resolutions);
  }
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

export function archiveLegacyImportSource(params: {
  sourcePath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): void {
  if (!hardenLegacyImportSource(params)) {
    return;
  }
  const resolution = archiveLegacyFileSource({
    sourcePath: params.sourcePath,
    label: `${params.label} legacy source`,
    warnings: params.warnings,
  });
  if (!resolution) {
    return;
  }
  if (resolution.action === "archived") {
    try {
      fs.chmodSync(resolution.targetPath, 0o600);
    } catch (err) {
      params.warnings.push(
        `Failed securing archived ${params.label} legacy source: ${String(err)}`,
      );
    }
  }
  params.changes.push(
    resolution.action === "removed"
      ? `Removed already-archived ${params.label} legacy source ${params.sourcePath}`
      : `Archived ${params.label} legacy source → ${resolution.targetPath}`,
  );
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
    const changes: string[] = [];
    const warnings: string[] = [];
    if (hasPendingSqliteSidecarArchive(sourcePath, TASK_STATE_SQLITE_SIDECAR_SUFFIXES)) {
      archiveLegacyTaskStateSidecar({ sourcePath, label: "task registry", changes, warnings });
    }
    return { changes, warnings };
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
          "requester_agent_id",
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
          "detail_json",
        ];
        for (const row of taskRows) {
          const taskId = legacyKeyValue(expectDefined(row.task_id, "task migration row key"));
          const existing = db
            .prepare(`SELECT ${taskColumns.join(", ")} FROM task_runs WHERE task_id = ?`)
            .get(taskId);
          if (existing) {
            if (!legacyRowsMatch(existing as Record<string, unknown>, row, taskColumns)) {
              conflicts.push(taskId);
            }
            continue;
          }
          insertTaskRunRowSql(db, row);
          importedTasks++;
        }
        const deliveryColumns = ["requester_origin_json", "last_notified_event_at"];
        for (const row of deliveryRows) {
          const taskId = legacyKeyValue(expectDefined(row.task_id, "delivery migration row key"));
          const existing = db
            .prepare(
              `SELECT requester_origin_json, last_notified_event_at FROM task_delivery_state WHERE task_id = ?`,
            )
            .get(taskId);
          if (existing) {
            if (!legacyRowsMatch(existing as Record<string, unknown>, row, deliveryColumns)) {
              conflicts.push(`${taskId}/delivery`);
            }
            continue;
          }
          const taskExists = db.prepare("SELECT 1 FROM task_runs WHERE task_id = ?").get(taskId);
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
    const changes: string[] = [];
    const warnings: string[] = [];
    if (hasPendingSqliteSidecarArchive(sourcePath, TASK_STATE_SQLITE_SIDECAR_SUFFIXES)) {
      archiveLegacyTaskStateSidecar({ sourcePath, label: "task flow", changes, warnings });
    }
    return { changes, warnings };
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
          const flowId = legacyKeyValue(expectDefined(row.flow_id, "flow migration row key"));
          const existing = db
            .prepare(`SELECT ${columns.join(", ")} FROM flow_runs WHERE flow_id = ?`)
            .get(flowId);
          if (existing) {
            if (!legacyRowsMatch(existing as Record<string, unknown>, row, columns)) {
              conflicts.push(flowId);
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

export async function migrateLegacyTaskStateSidecars(params: {
  stateDir: string;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const taskRuns = await migrateLegacyTaskRunsSidecar(params);
  const flowRuns = await migrateLegacyFlowRunsSidecar(params);
  return {
    changes: [...taskRuns.changes, ...flowRuns.changes],
    warnings: [...taskRuns.warnings, ...flowRuns.warnings],
  };
}

export function resolveLegacyDeliveryQueuePath(stateDir: string, dirName: string): string {
  return path.join(stateDir, dirName);
}

export function listLegacyDeliveryQueueFiles(queueDir: string): LegacyDeliveryQueueFile[] {
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

export function listLegacyDeliveryQueueDeliveredMarkers(queueDir: string): string[] {
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

export async function migrateLegacyDeliveryQueues(params: {
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
