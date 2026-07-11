// Applies persisted state migrations across OpenClaw config files.
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
  isNamedProfile,
  resolveLegacyStateDirs,
  resolveNewStateDir,
  resolveOAuthDir,
  resolveStateDir,
} from "../config/paths.js";
import type { SessionEntry } from "../config/sessions.js";
import { saveSessionStore } from "../config/sessions.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { normalizePersistedSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import {
  listConfiguredSessionStoreAgentIds,
  resolveAllAgentSessionStoreTargetsSync,
} from "../config/sessions/targets.js";
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
  collectRelevantDoctorPluginIds,
  listPluginDoctorSessionStoreAgentIds,
  listPluginDoctorStateMigrationEntries,
  type PluginDoctorStateMigrationContext,
  type PluginDoctorStateMigrationDetection,
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
  isValidAgentId,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  detectOpenClawStateDatabaseSchemaMigrations,
  repairOpenClawStateDatabaseSchema,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { assertNoSymlinkParentsSync, sameFileIdentity } from "./fs-safe-advanced.js";
import { expandHomePrefix, resolveRequiredHomeDir } from "./home-dir.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { parseRegistryNpmSpec } from "./npm-registry-spec.js";
import { normalizeConversationRef } from "./outbound/session-binding-normalization.js";
import type { SessionBindingRecord } from "./outbound/session-binding.types.js";
import { isWithinDir } from "./path-safety.js";
import {
  detectLegacyDebugProxyCaptureSidecar,
  migrateLegacyDebugProxyCaptureSidecar,
} from "./state-migrations.debug-proxy.js";
import {
  ensureDir,
  existsDir,
  fileExists,
  parseSessionStoreJson5,
  readSessionStoreJson5,
  type SessionEntryLike,
  safeReadDir,
} from "./state-migrations.fs.js";
import { normalizeVoiceWakeRoutingConfig } from "./voicewake-routing.js";

type SessionStoreAliasPlan = {
  hasDistinctAliases: boolean;
  hasFinalSymlink: boolean;
  hasUnresolvedIdentity: boolean;
};

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
    preserveAmbiguousKeys: boolean;
    preserveForeignMainAliases: boolean;
    targetStoreAliases: SessionStoreAliasPlan;
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
  debugProxyCaptureSidecar: {
    sourcePath: string;
    blobDir: string;
    hasLegacy: boolean;
  };
  stateSchema: {
    hasLegacy: boolean;
    preview: string[];
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
  voiceWake: {
    triggersPath: string;
    routingPath: string;
    hasLegacy: boolean;
  };
  updateCheck: {
    sourcePath: string;
    hasLegacy: boolean;
  };
  configHealth: {
    sourcePath: string;
    hasLegacy: boolean;
  };
  pluginBindingApprovals: {
    sourcePath: string;
    hasLegacy: boolean;
  };
  currentConversationBindings: {
    sourcePath: string;
    hasLegacy: boolean;
  };
  execApprovals: {
    sourcePath: string;
    targetPath: string;
    hasLegacy: boolean;
  };
  warnings: string[];
  notices: string[];
  preview: string[];
};

type LegacyExecApprovalsMigrationDetection = LegacyStateDetection["execApprovals"];

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
type LegacyVoiceWakeImportDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "voicewake_routing_config" | "voicewake_routing_routes" | "voicewake_triggers"
>;
type LegacyUpdateCheckImportDatabase = Pick<OpenClawStateKyselyDatabase, "update_check_state">;
type LegacyConfigHealthImportDatabase = Pick<OpenClawStateKyselyDatabase, "config_health_entries">;
type LegacyPluginBindingApprovalsImportDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "plugin_binding_approvals"
>;
type LegacyCurrentConversationBindingsImportDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "current_conversation_bindings"
>;
type SqliteBindRow = Record<string, SQLInputValue>;

type DetectedPluginDoctorStateMigrationPlan = {
  pluginId: string;
  migration: PluginDoctorStateMigration;
  preview: string[];
};

type MigrationMessages = {
  changes: string[];
  warnings: string[];
  notices?: string[];
};

// Move the canonical database first so a partial archive never leaves a
// readable database separated from committed WAL rows. Pending sidecars are
// detected and archived without reopening the migrated database.
const PLUGIN_STATE_SQLITE_SIDECAR_SUFFIXES = ["", "-shm", "-wal", "-journal"] as const;
const TASK_STATE_SQLITE_SIDECAR_SUFFIXES = ["", "-shm", "-wal", "-journal"] as const;
const LEGACY_DELIVERY_QUEUE_DIRS = [
  { label: "outbound delivery queue", queueName: "outbound", dirName: "delivery-queue" },
  { label: "session delivery queue", queueName: "session", dirName: "session-delivery-queue" },
] as const;
const EXEC_APPROVALS_FILENAME = "exec-approvals.json";
const EXEC_APPROVALS_SOCKET_FILENAME = "exec-approvals.sock";
type LegacyDeliveryQueueFile = {
  sourcePath: string;
  status: "pending" | "failed";
};

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

function resolveDefaultExecApprovalsStateDir(
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): string {
  return path.join(resolveRequiredHomeDir(env, homedir), ".openclaw");
}

function resolveDefaultExecApprovalsPath(env: NodeJS.ProcessEnv, homedir: () => string): string {
  return path.join(resolveDefaultExecApprovalsStateDir(env, homedir), EXEC_APPROVALS_FILENAME);
}

function resolveExecApprovalsPathForStateDir(stateDir: string): string {
  return path.join(stateDir, EXEC_APPROVALS_FILENAME);
}

function resolveExecApprovalsSocketPathForStateDir(stateDir: string): string {
  return path.join(stateDir, EXEC_APPROVALS_SOCKET_FILENAME);
}

function detectLegacyExecApprovalsMigration(params: {
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  stateDir: string;
}): LegacyExecApprovalsMigrationDetection {
  const sourcePath = resolveDefaultExecApprovalsPath(params.env, params.homedir);
  const targetPath = resolveExecApprovalsPathForStateDir(params.stateDir);
  return {
    sourcePath,
    targetPath,
    hasLegacy:
      Boolean(params.env.OPENCLAW_STATE_DIR?.trim()) &&
      !isNamedProfile(params.env) &&
      path.resolve(sourcePath) !== path.resolve(targetPath) &&
      fileExists(sourcePath) &&
      !fileExists(targetPath),
  };
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

function isLegacyPluginStateRowExpired(row: LegacyPluginStateSidecarRow, now: number): boolean {
  const expiresAt = normalizeLegacySqliteInteger(row.expires_at);
  return expiresAt !== null && expiresAt <= now;
}

function hasPendingSqliteSidecarArchive(sourcePath: string, suffixes: readonly string[]): boolean {
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

function archiveLegacyPluginStateSidecar(params: {
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

function archiveLegacyInstalledPluginIndex(params: {
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

function archiveLegacyImportSource(params: {
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
    chain_id: legacyBindValue(row.chain_id),
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
      pickLegacyColumn(columns, "chain_id"),
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
        child_session_key, parent_flow_id, parent_task_id, agent_id, requester_agent_id, run_id,
        label, task, status, delivery_status, notify_policy, created_at, started_at, ended_at,
        last_event_at, cleanup_after, error, progress_summary, terminal_summary, terminal_outcome
      ) VALUES (
        @task_id, @runtime, @task_kind, @source_id, @requester_session_key, @owner_key,
        @scope_kind, @child_session_key, @parent_flow_id, @parent_task_id, @agent_id,
        @requester_agent_id, @run_id, @label, @task, @status, @delivery_status, @notify_policy,
        @created_at, @started_at, @ended_at, @last_event_at, @cleanup_after, @error,
        @progress_summary, @terminal_summary, @terminal_outcome
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
        flow_id, shape, sync_mode, owner_key, chain_id, requester_origin_json, controller_id,
        revision, status, notify_policy, goal, current_step, blocked_task_id, blocked_summary,
        state_json, wait_json, cancel_requested_at, created_at, updated_at, ended_at
      ) VALUES (
        @flow_id, @shape, @sync_mode, @owner_key, @chain_id, @requester_origin_json, @controller_id,
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

const VOICEWAKE_CONFIG_KEY = "default";
const DEFAULT_VOICEWAKE_TRIGGERS = ["openclaw", "claude", "computer"];

function resolveLegacyVoiceWakeTriggersPath(stateDir: string): string {
  return path.join(stateDir, "settings", "voicewake.json");
}

function resolveLegacyVoiceWakeRoutingPath(stateDir: string): string {
  return path.join(stateDir, "settings", "voicewake-routing.json");
}

function readLegacyJsonObject(sourcePath: string): unknown {
  return JSON.parse(fs.readFileSync(sourcePath, "utf8")) as unknown;
}

function normalizeLegacyVoiceWakeTriggers(input: unknown): string[] {
  const rec = input && typeof input === "object" ? (input as { triggers?: unknown }) : {};
  const triggers = Array.isArray(rec.triggers)
    ? rec.triggers
        .flatMap((entry) => (typeof entry === "string" ? [entry.trim()] : []))
        .filter((entry) => entry.length > 0)
    : [];
  return triggers.length > 0 ? triggers : DEFAULT_VOICEWAKE_TRIGGERS;
}

function legacyVoiceWakeTriggersMatch(
  rows: Array<{ trigger: string }>,
  triggers: string[],
): boolean {
  return (
    rows.length === triggers.length && rows.every((row, index) => row.trigger === triggers[index])
  );
}

function legacyVoiceWakeTargetColumns(target: {
  agentId?: string;
  mode?: "current";
  sessionKey?: string;
}): {
  targetAgentId: string | null;
  targetMode: string;
  targetSessionKey: string | null;
} {
  if (target.agentId) {
    return { targetAgentId: target.agentId, targetMode: "agent", targetSessionKey: null };
  }
  if (target.sessionKey) {
    return { targetAgentId: null, targetMode: "session", targetSessionKey: target.sessionKey };
  }
  return { targetAgentId: null, targetMode: "current", targetSessionKey: null };
}

function legacyVoiceWakeTargetColumnsMatch(
  left: ReturnType<typeof legacyVoiceWakeTargetColumns>,
  right: {
    target_agent_id?: string | null;
    target_mode?: string | null;
    target_session_key?: string | null;
  },
): boolean {
  return (
    left.targetAgentId === (right.target_agent_id ?? null) &&
    left.targetMode === right.target_mode &&
    left.targetSessionKey === (right.target_session_key ?? null)
  );
}

function legacyVoiceWakeRoutingMatches(
  configRow: {
    default_target_agent_id: string | null;
    default_target_mode: string;
    default_target_session_key: string | null;
  },
  routeRows: Array<{
    target_agent_id: string | null;
    target_mode: string;
    target_session_key: string | null;
    trigger: string;
  }>,
  routingConfig: ReturnType<typeof normalizeVoiceWakeRoutingConfig>,
): boolean {
  const defaultTarget = legacyVoiceWakeTargetColumns(routingConfig.defaultTarget);
  if (
    !legacyVoiceWakeTargetColumnsMatch(defaultTarget, {
      target_agent_id: configRow.default_target_agent_id,
      target_mode: configRow.default_target_mode,
      target_session_key: configRow.default_target_session_key,
    })
  ) {
    return false;
  }
  return (
    routeRows.length === routingConfig.routes.length &&
    routeRows.every((row, index) => {
      const route = routingConfig.routes[index];
      if (!route || row.trigger !== route.trigger) {
        return false;
      }
      return legacyVoiceWakeTargetColumnsMatch(legacyVoiceWakeTargetColumns(route.target), row);
    })
  );
}

function migrateLegacyVoiceWakeSettings(params: {
  detected: LegacyStateDetection["voiceWake"];
  stateDir: string;
}): { changes: string[]; warnings: string[] } {
  const changes: string[] = [];
  const warnings: string[] = [];
  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  if (fileExists(params.detected.triggersPath)) {
    let triggers: string[];
    try {
      triggers = normalizeLegacyVoiceWakeTriggers(
        readLegacyJsonObject(params.detected.triggersPath),
      );
    } catch (err) {
      warnings.push(
        `Failed reading legacy voice wake triggers ${params.detected.triggersPath}: ${String(err)}`,
      );
      triggers = [];
    }
    if (triggers.length > 0) {
      let imported = false;
      let shouldArchive = false;
      try {
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            const stateDb = getNodeSqliteKysely<LegacyVoiceWakeImportDatabase>(db);
            const existing = executeSqliteQuerySync(
              db,
              stateDb
                .selectFrom("voicewake_triggers")
                .select(["trigger"])
                .where("config_key", "=", VOICEWAKE_CONFIG_KEY)
                .orderBy("position", "asc"),
            ).rows;
            if (existing.length > 0) {
              if (!legacyVoiceWakeTriggersMatch(existing, triggers)) {
                warnings.push(
                  `Left legacy voice wake triggers in place because shared SQLite state already has different triggers: ${params.detected.triggersPath}`,
                );
              } else {
                shouldArchive = true;
              }
              return;
            }
            const updatedAtMs = Date.now();
            executeSqliteQuerySync(
              db,
              stateDb.insertInto("voicewake_triggers").values(
                triggers.map((trigger, position) => ({
                  config_key: VOICEWAKE_CONFIG_KEY,
                  position,
                  trigger,
                  updated_at_ms: updatedAtMs,
                })),
              ),
            );
            imported = true;
            shouldArchive = true;
          },
          { env },
        );
      } catch (err) {
        warnings.push(`Failed migrating legacy voice wake triggers: ${String(err)}`);
      }
      if (imported) {
        changes.push(
          `Migrated ${triggers.length} voice wake ${triggers.length === 1 ? "trigger" : "triggers"} → shared SQLite state`,
        );
      }
      if (shouldArchive) {
        archiveLegacyImportSource({
          sourcePath: params.detected.triggersPath,
          label: "voice wake triggers",
          changes,
          warnings,
        });
      }
    }
  }

  if (fileExists(params.detected.routingPath)) {
    let routingConfig: ReturnType<typeof normalizeVoiceWakeRoutingConfig> | null = null;
    try {
      routingConfig = normalizeVoiceWakeRoutingConfig(
        readLegacyJsonObject(params.detected.routingPath),
      );
    } catch (err) {
      warnings.push(
        `Failed reading legacy voice wake routing ${params.detected.routingPath}: ${String(err)}`,
      );
    }
    if (routingConfig) {
      let imported = false;
      let shouldArchive = false;
      try {
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            const stateDb = getNodeSqliteKysely<LegacyVoiceWakeImportDatabase>(db);
            const existing = executeSqliteQueryTakeFirstSync(
              db,
              stateDb
                .selectFrom("voicewake_routing_config")
                .select([
                  "default_target_agent_id",
                  "default_target_mode",
                  "default_target_session_key",
                ])
                .where("config_key", "=", VOICEWAKE_CONFIG_KEY),
            );
            if (existing) {
              const routeRows = executeSqliteQuerySync(
                db,
                stateDb
                  .selectFrom("voicewake_routing_routes")
                  .select(["target_agent_id", "target_mode", "target_session_key", "trigger"])
                  .where("config_key", "=", VOICEWAKE_CONFIG_KEY)
                  .orderBy("position", "asc"),
              ).rows;
              if (legacyVoiceWakeRoutingMatches(existing, routeRows, routingConfig)) {
                shouldArchive = true;
              } else {
                warnings.push(
                  `Left legacy voice wake routing in place because shared SQLite routing already exists with different routes: ${params.detected.routingPath}`,
                );
              }
              return;
            }
            const updatedAtMs = Date.now();
            const defaultTarget = legacyVoiceWakeTargetColumns(routingConfig.defaultTarget);
            executeSqliteQuerySync(
              db,
              stateDb.insertInto("voicewake_routing_config").values({
                config_key: VOICEWAKE_CONFIG_KEY,
                version: 1,
                default_target_mode: defaultTarget.targetMode,
                default_target_agent_id: defaultTarget.targetAgentId,
                default_target_session_key: defaultTarget.targetSessionKey,
                updated_at_ms: updatedAtMs,
              }),
            );
            if (routingConfig.routes.length > 0) {
              executeSqliteQuerySync(
                db,
                stateDb.insertInto("voicewake_routing_routes").values(
                  routingConfig.routes.map((route, position) => {
                    const target = legacyVoiceWakeTargetColumns(route.target);
                    return {
                      config_key: VOICEWAKE_CONFIG_KEY,
                      position,
                      trigger: route.trigger,
                      target_mode: target.targetMode,
                      target_agent_id: target.targetAgentId,
                      target_session_key: target.targetSessionKey,
                      updated_at_ms: updatedAtMs,
                    };
                  }),
                ),
              );
            }
            imported = true;
            shouldArchive = true;
          },
          { env },
        );
      } catch (err) {
        warnings.push(`Failed migrating legacy voice wake routing: ${String(err)}`);
      }
      if (imported) {
        changes.push(
          `Migrated voice wake routing config with ${routingConfig.routes.length} ${routingConfig.routes.length === 1 ? "route" : "routes"} → shared SQLite state`,
        );
      }
      if (shouldArchive) {
        archiveLegacyImportSource({
          sourcePath: params.detected.routingPath,
          label: "voice wake routing",
          changes,
          warnings,
        });
      }
    }
  }

  return { changes, warnings };
}

const UPDATE_CHECK_STATE_KEY = "default";

type LegacyUpdateCheckState = {
  lastCheckedAt?: string;
  lastNotifiedVersion?: string;
  lastNotifiedTag?: string;
  lastAvailableVersion?: string;
  lastAvailableTag?: string;
  autoInstallId?: string;
  autoFirstSeenVersion?: string;
  autoFirstSeenTag?: string;
  autoFirstSeenAt?: string;
  autoLastAttemptVersion?: string;
  autoLastAttemptAt?: string;
  autoLastSuccessVersion?: string;
  autoLastSuccessAt?: string;
};

function resolveLegacyUpdateCheckPath(stateDir: string): string {
  return path.join(stateDir, "update-check.json");
}

function optionalLegacyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeLegacyUpdateCheckState(input: unknown): LegacyUpdateCheckState {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    lastCheckedAt: optionalLegacyString(record, "lastCheckedAt"),
    lastNotifiedVersion: optionalLegacyString(record, "lastNotifiedVersion"),
    lastNotifiedTag: optionalLegacyString(record, "lastNotifiedTag"),
    lastAvailableVersion: optionalLegacyString(record, "lastAvailableVersion"),
    lastAvailableTag: optionalLegacyString(record, "lastAvailableTag"),
    autoInstallId: optionalLegacyString(record, "autoInstallId"),
    autoFirstSeenVersion: optionalLegacyString(record, "autoFirstSeenVersion"),
    autoFirstSeenTag: optionalLegacyString(record, "autoFirstSeenTag"),
    autoFirstSeenAt: optionalLegacyString(record, "autoFirstSeenAt"),
    autoLastAttemptVersion: optionalLegacyString(record, "autoLastAttemptVersion"),
    autoLastAttemptAt: optionalLegacyString(record, "autoLastAttemptAt"),
    autoLastSuccessVersion: optionalLegacyString(record, "autoLastSuccessVersion"),
    autoLastSuccessAt: optionalLegacyString(record, "autoLastSuccessAt"),
  };
}

function legacyUpdateCheckStateMatches(
  row: {
    last_checked_at: string | null;
    last_notified_version: string | null;
    last_notified_tag: string | null;
    last_available_version: string | null;
    last_available_tag: string | null;
    auto_install_id: string | null;
    auto_first_seen_version: string | null;
    auto_first_seen_tag: string | null;
    auto_first_seen_at: string | null;
    auto_last_attempt_version: string | null;
    auto_last_attempt_at: string | null;
    auto_last_success_version: string | null;
    auto_last_success_at: string | null;
  },
  state: LegacyUpdateCheckState,
): boolean {
  return (
    (state.lastCheckedAt ?? null) === row.last_checked_at &&
    (state.lastNotifiedVersion ?? null) === row.last_notified_version &&
    (state.lastNotifiedTag ?? null) === row.last_notified_tag &&
    (state.lastAvailableVersion ?? null) === row.last_available_version &&
    (state.lastAvailableTag ?? null) === row.last_available_tag &&
    (state.autoInstallId ?? null) === row.auto_install_id &&
    (state.autoFirstSeenVersion ?? null) === row.auto_first_seen_version &&
    (state.autoFirstSeenTag ?? null) === row.auto_first_seen_tag &&
    (state.autoFirstSeenAt ?? null) === row.auto_first_seen_at &&
    (state.autoLastAttemptVersion ?? null) === row.auto_last_attempt_version &&
    (state.autoLastAttemptAt ?? null) === row.auto_last_attempt_at &&
    (state.autoLastSuccessVersion ?? null) === row.auto_last_success_version &&
    (state.autoLastSuccessAt ?? null) === row.auto_last_success_at
  );
}

function migrateLegacyUpdateCheckState(params: {
  detected: LegacyStateDetection["updateCheck"];
  stateDir: string;
}): { changes: string[]; warnings: string[] } {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!fileExists(params.detected.sourcePath)) {
    return { changes, warnings };
  }

  let state: LegacyUpdateCheckState;
  try {
    state = normalizeLegacyUpdateCheckState(readLegacyJsonObject(params.detected.sourcePath));
  } catch (err) {
    warnings.push(
      `Failed reading legacy update-check state ${params.detected.sourcePath}: ${String(err)}`,
    );
    return { changes, warnings };
  }

  let imported = false;
  let shouldArchive = false;
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<LegacyUpdateCheckImportDatabase>(db);
        const existing = executeSqliteQueryTakeFirstSync(
          db,
          stateDb
            .selectFrom("update_check_state")
            .selectAll()
            .where("state_key", "=", UPDATE_CHECK_STATE_KEY),
        );
        if (existing) {
          if (legacyUpdateCheckStateMatches(existing, state)) {
            shouldArchive = true;
          } else {
            warnings.push(
              `Left legacy update-check state in place because shared SQLite state already differs: ${params.detected.sourcePath}`,
            );
          }
          return;
        }
        executeSqliteQuerySync(
          db,
          stateDb.insertInto("update_check_state").values({
            state_key: UPDATE_CHECK_STATE_KEY,
            last_checked_at: state.lastCheckedAt ?? null,
            last_notified_version: state.lastNotifiedVersion ?? null,
            last_notified_tag: state.lastNotifiedTag ?? null,
            last_available_version: state.lastAvailableVersion ?? null,
            last_available_tag: state.lastAvailableTag ?? null,
            auto_install_id: state.autoInstallId ?? null,
            auto_first_seen_version: state.autoFirstSeenVersion ?? null,
            auto_first_seen_tag: state.autoFirstSeenTag ?? null,
            auto_first_seen_at: state.autoFirstSeenAt ?? null,
            auto_last_attempt_version: state.autoLastAttemptVersion ?? null,
            auto_last_attempt_at: state.autoLastAttemptAt ?? null,
            auto_last_success_version: state.autoLastSuccessVersion ?? null,
            auto_last_success_at: state.autoLastSuccessAt ?? null,
            updated_at_ms: Date.now(),
          }),
        );
        imported = true;
        shouldArchive = true;
      },
      { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
    );
  } catch (err) {
    warnings.push(`Failed migrating legacy update-check state: ${String(err)}`);
  }
  if (imported) {
    changes.push("Migrated update-check state → shared SQLite state");
  }
  if (shouldArchive) {
    archiveLegacyImportSource({
      sourcePath: params.detected.sourcePath,
      label: "update-check state",
      changes,
      warnings,
    });
  }
  return { changes, warnings };
}

type LegacyConfigHealthFile = {
  entries?: unknown;
};

type LegacyConfigHealthEntry = {
  configPath: string;
  lastKnownGoodJson: string | null;
  lastPromotedGoodJson: string | null;
  lastObservedSuspiciousSignature: string | null;
};

function resolveLegacyConfigHealthPath(stateDir: string): string {
  return path.join(stateDir, "logs", "config-health.json");
}

function normalizeLegacyConfigHealthEntry(
  configPath: string,
  input: unknown,
): LegacyConfigHealthEntry | null {
  if (!configPath.trim() || !input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const entry = input as {
    lastKnownGood?: unknown;
    lastPromotedGood?: unknown;
    lastObservedSuspiciousSignature?: unknown;
  };
  const lastKnownGoodJson =
    entry.lastKnownGood && typeof entry.lastKnownGood === "object"
      ? JSON.stringify(entry.lastKnownGood)
      : null;
  const lastPromotedGoodJson =
    entry.lastPromotedGood && typeof entry.lastPromotedGood === "object"
      ? JSON.stringify(entry.lastPromotedGood)
      : null;
  const lastObservedSuspiciousSignature =
    typeof entry.lastObservedSuspiciousSignature === "string"
      ? entry.lastObservedSuspiciousSignature
      : null;
  if (!lastKnownGoodJson && !lastPromotedGoodJson && !lastObservedSuspiciousSignature) {
    return null;
  }
  return {
    configPath,
    lastKnownGoodJson,
    lastPromotedGoodJson,
    lastObservedSuspiciousSignature,
  };
}

function normalizeLegacyConfigHealthFile(input: unknown): LegacyConfigHealthEntry[] {
  const file = input && typeof input === "object" ? (input as LegacyConfigHealthFile) : {};
  const entries = file.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return [];
  }
  return Object.entries(entries)
    .flatMap(([configPath, entry]) => {
      const normalized = normalizeLegacyConfigHealthEntry(configPath, entry);
      return normalized ? [normalized] : [];
    })
    .toSorted((a, b) => a.configPath.localeCompare(b.configPath));
}

function configHealthRow(entry: LegacyConfigHealthEntry): {
  config_path: string;
  last_known_good_json: string | null;
  last_promoted_good_json: string | null;
  last_observed_suspicious_signature: string | null;
  updated_at_ms: number;
} {
  return {
    config_path: entry.configPath,
    last_known_good_json: entry.lastKnownGoodJson,
    last_promoted_good_json: entry.lastPromotedGoodJson,
    last_observed_suspicious_signature: entry.lastObservedSuspiciousSignature,
    updated_at_ms: Date.now(),
  };
}

function retireLegacyConfigHealthSource(params: {
  sourcePath: string;
  changes: string[];
  warnings: string[];
}): void {
  const archivedPath = `${params.sourcePath}.migrated`;
  if (!fileExists(archivedPath)) {
    archiveLegacyImportSource({
      sourcePath: params.sourcePath,
      label: "config health state",
      changes: params.changes,
      warnings: params.warnings,
    });
    return;
  }

  // Released macOS builds can recreate this source after it was archived.
  // Once reconciled into SQLite, retaining it causes every run to warn again.
  try {
    fs.rmSync(params.sourcePath, { force: true });
    params.changes.push("Removed regenerated config health legacy source");
  } catch (err) {
    params.warnings.push(`Failed removing regenerated config health legacy source: ${String(err)}`);
  }
}

function migrateLegacyConfigHealth(params: {
  detected: LegacyStateDetection["configHealth"];
  stateDir: string;
}): { changes: string[]; warnings: string[] } {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!fileExists(params.detected.sourcePath)) {
    return { changes, warnings };
  }
  let entries: LegacyConfigHealthEntry[];
  try {
    entries = normalizeLegacyConfigHealthFile(readLegacyJsonObject(params.detected.sourcePath));
  } catch (err) {
    warnings.push(
      `Failed reading legacy config health state ${params.detected.sourcePath}: ${String(err)}`,
    );
    return { changes, warnings };
  }

  let importedCount = 0;
  let reconciledCount = 0;
  let shouldArchive = false;
  try {
    const result = runOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<LegacyConfigHealthImportDatabase>(db);
        const existing = executeSqliteQuerySync(
          db,
          stateDb
            .selectFrom("config_health_entries")
            .select([
              "config_path",
              "last_known_good_json",
              "last_promoted_good_json",
              "last_observed_suspicious_signature",
            ]),
        ).rows;
        const existingByPath = new Map(existing.map((row) => [row.config_path, row] as const));
        const entriesToInsert: LegacyConfigHealthEntry[] = [];
        let transactionReconciledCount = 0;
        for (const entry of entries) {
          const existingEntry = existingByPath.get(entry.configPath);
          if (!existingEntry) {
            entriesToInsert.push(entry);
            continue;
          }

          const lastKnownGoodJson = existingEntry.last_known_good_json ?? entry.lastKnownGoodJson;
          const lastPromotedGoodJson =
            existingEntry.last_promoted_good_json ?? entry.lastPromotedGoodJson;
          if (
            lastKnownGoodJson === existingEntry.last_known_good_json &&
            lastPromotedGoodJson === existingEntry.last_promoted_good_json
          ) {
            continue;
          }
          executeSqliteQuerySync(
            db,
            stateDb
              .updateTable("config_health_entries")
              .set({
                last_known_good_json: lastKnownGoodJson,
                last_promoted_good_json: lastPromotedGoodJson,
                updated_at_ms: Date.now(),
              })
              .where("config_path", "=", entry.configPath),
          );
          transactionReconciledCount += 1;
        }
        if (entriesToInsert.length > 0) {
          executeSqliteQuerySync(
            db,
            stateDb
              .insertInto("config_health_entries")
              .values(entriesToInsert.map(configHealthRow)),
          );
        }
        return {
          importedCount: entriesToInsert.length,
          reconciledCount: transactionReconciledCount,
        };
      },
      { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
    );
    importedCount = result.importedCount;
    reconciledCount = result.reconciledCount;
    shouldArchive = true;
  } catch (err) {
    warnings.push(`Failed migrating legacy config health state: ${String(err)}`);
  }
  if (importedCount > 0) {
    changes.push(
      `Migrated ${importedCount} config health ${importedCount === 1 ? "entry" : "entries"} → shared SQLite state`,
    );
  }
  if (reconciledCount > 0) {
    changes.push(
      `Reconciled ${reconciledCount} config health ${reconciledCount === 1 ? "entry" : "entries"} → shared SQLite state`,
    );
  }
  if (shouldArchive) {
    retireLegacyConfigHealthSource({
      sourcePath: params.detected.sourcePath,
      changes,
      warnings,
    });
  }
  return { changes, warnings };
}

type LegacyPluginBindingApprovalsFile = {
  version?: unknown;
  approvals?: unknown;
};

type LegacyPluginBindingApprovalEntry = {
  pluginRoot: string;
  pluginId: string;
  pluginName?: string;
  channel: string;
  accountId: string;
  approvedAt: number;
};

function resolveLegacyPluginBindingApprovalsPath(
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): string {
  return path.join(
    resolveRequiredHomeDir(env, homedir),
    ".openclaw",
    "plugin-binding-approvals.json",
  );
}

function pluginBindingApprovalScopeKey(entry: {
  pluginRoot: string;
  channel: string;
  accountId: string;
}): string {
  return [entry.pluginRoot, normalizeLowercaseStringOrEmpty(entry.channel), entry.accountId].join(
    "::",
  );
}

function normalizeLegacyPluginBindingApprovalEntry(
  input: unknown,
): LegacyPluginBindingApprovalEntry | null {
  const entry =
    input && typeof input === "object" ? (input as Partial<LegacyPluginBindingApprovalEntry>) : {};
  const pluginRoot = typeof entry.pluginRoot === "string" ? entry.pluginRoot.trim() : "";
  const pluginId = typeof entry.pluginId === "string" ? entry.pluginId.trim() : "";
  const channel =
    typeof entry.channel === "string" ? normalizeLowercaseStringOrEmpty(entry.channel) : "";
  const accountId =
    typeof entry.accountId === "string" && entry.accountId.trim()
      ? entry.accountId.trim()
      : "default";
  if (!pluginRoot || !pluginId || !channel) {
    return null;
  }
  return {
    pluginRoot,
    pluginId,
    pluginName: typeof entry.pluginName === "string" ? entry.pluginName : undefined,
    channel,
    accountId,
    approvedAt:
      typeof entry.approvedAt === "number" && Number.isFinite(entry.approvedAt)
        ? Math.floor(entry.approvedAt)
        : Date.now(),
  };
}

function normalizeLegacyPluginBindingApprovalsFile(
  input: unknown,
): LegacyPluginBindingApprovalEntry[] {
  const file =
    input && typeof input === "object" ? (input as LegacyPluginBindingApprovalsFile) : {};
  if (file.version !== 1 || !Array.isArray(file.approvals)) {
    return [];
  }
  const approvals = new Map<string, LegacyPluginBindingApprovalEntry>();
  for (const item of file.approvals) {
    const entry = normalizeLegacyPluginBindingApprovalEntry(item);
    if (!entry) {
      continue;
    }
    approvals.set(pluginBindingApprovalScopeKey(entry), entry);
  }
  return [...approvals.values()].toSorted((a, b) =>
    pluginBindingApprovalScopeKey(a).localeCompare(pluginBindingApprovalScopeKey(b)),
  );
}

function pluginBindingApprovalRow(entry: LegacyPluginBindingApprovalEntry): {
  plugin_root: string;
  channel: string;
  account_id: string;
  plugin_id: string;
  plugin_name: string | null;
  approved_at: number;
} {
  return {
    plugin_root: entry.pluginRoot,
    channel: entry.channel,
    account_id: entry.accountId,
    plugin_id: entry.pluginId,
    plugin_name: entry.pluginName ?? null,
    approved_at: entry.approvedAt,
  };
}

function pluginBindingApprovalComparable(entry: LegacyPluginBindingApprovalEntry): string {
  return JSON.stringify(pluginBindingApprovalRow(entry));
}

function migrateLegacyPluginBindingApprovals(params: {
  detected: LegacyStateDetection["pluginBindingApprovals"];
  stateDir: string;
}): { changes: string[]; warnings: string[] } {
  const changes: string[] = [];
  const warnings: string[] = [];
  // hasLegacy is the detection verdict (it stays false for suppressed
  // cross-state-dir sources); fileExists re-checks for races since detection.
  if (!params.detected.hasLegacy || !fileExists(params.detected.sourcePath)) {
    return { changes, warnings };
  }
  let approvals: LegacyPluginBindingApprovalEntry[];
  try {
    approvals = normalizeLegacyPluginBindingApprovalsFile(
      readLegacyJsonObject(params.detected.sourcePath),
    );
  } catch (err) {
    warnings.push(
      `Failed reading legacy plugin binding approvals ${params.detected.sourcePath}: ${String(err)}`,
    );
    return { changes, warnings };
  }

  let importedCount = 0;
  let shouldArchive = approvals.length === 0;
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<LegacyPluginBindingApprovalsImportDatabase>(db);
        const existing = executeSqliteQuerySync(
          db,
          stateDb
            .selectFrom("plugin_binding_approvals")
            .select([
              "plugin_root",
              "channel",
              "account_id",
              "plugin_id",
              "plugin_name",
              "approved_at",
            ]),
        ).rows;
        const existingByKey = new Map(
          existing.map(
            (row) =>
              [
                pluginBindingApprovalScopeKey({
                  pluginRoot: row.plugin_root,
                  channel: row.channel,
                  accountId: row.account_id,
                }),
                JSON.stringify({
                  plugin_root: row.plugin_root,
                  channel: row.channel,
                  account_id: row.account_id,
                  plugin_id: row.plugin_id,
                  plugin_name: row.plugin_name,
                  approved_at: row.approved_at,
                }),
              ] as const,
          ),
        );
        const approvalsToInsert: LegacyPluginBindingApprovalEntry[] = [];
        let conflictCount = 0;
        for (const approval of approvals) {
          const key = pluginBindingApprovalScopeKey(approval);
          const existingApprovalJson = existingByKey.get(key);
          if (existingApprovalJson === undefined) {
            approvalsToInsert.push(approval);
          } else if (existingApprovalJson !== pluginBindingApprovalComparable(approval)) {
            conflictCount += 1;
          }
        }
        if (approvalsToInsert.length > 0) {
          executeSqliteQuerySync(
            db,
            stateDb
              .insertInto("plugin_binding_approvals")
              .values(approvalsToInsert.map(pluginBindingApprovalRow)),
          );
          importedCount = approvalsToInsert.length;
        }
        shouldArchive = conflictCount === 0;
        if (conflictCount > 0) {
          warnings.push(
            `Left legacy plugin binding approvals in place because ${conflictCount} ${conflictCount === 1 ? "approval conflicts" : "approvals conflict"} with shared SQLite state: ${params.detected.sourcePath}`,
          );
        }
      },
      { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
    );
  } catch (err) {
    warnings.push(`Failed migrating legacy plugin binding approvals: ${String(err)}`);
  }
  if (importedCount > 0) {
    changes.push(
      `Migrated ${importedCount} plugin binding ${importedCount === 1 ? "approval" : "approvals"} → shared SQLite state`,
    );
  }
  if (shouldArchive) {
    archiveLegacyImportSource({
      sourcePath: params.detected.sourcePath,
      label: "plugin binding approvals",
      changes,
      warnings,
    });
  }
  return { changes, warnings };
}

const CURRENT_BINDING_CONVERSATION_KIND = "current";

type LegacyCurrentConversationBindingsFile = {
  version?: unknown;
  bindings?: unknown;
};

function resolveLegacyCurrentConversationBindingsPath(stateDir: string): string {
  return path.join(stateDir, "bindings", "current-conversations.json");
}

function currentConversationBindingKey(ref: SessionBindingRecord["conversation"]): string {
  const normalized = normalizeConversationRef(ref);
  return [
    normalized.channel,
    normalized.accountId,
    normalized.parentConversationId ?? "",
    normalized.conversationId,
  ].join("\u241f");
}

function normalizeLegacyCurrentConversationBindingRecord(
  input: unknown,
): SessionBindingRecord | null {
  const record = input && typeof input === "object" ? (input as Partial<SessionBindingRecord>) : {};
  if (!record.conversation?.conversationId) {
    return null;
  }
  const conversation = normalizeConversationRef(record.conversation);
  const targetSessionKey =
    typeof record.targetSessionKey === "string" ? record.targetSessionKey.trim() : "";
  if (!targetSessionKey) {
    return null;
  }
  const targetKind = record.targetKind === "subagent" ? "subagent" : "session";
  const status = record.status === "ending" || record.status === "ended" ? record.status : "active";
  const boundAt =
    typeof record.boundAt === "number" && Number.isFinite(record.boundAt)
      ? Math.floor(record.boundAt)
      : Date.now();
  const expiresAt =
    typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt)
      ? Math.floor(record.expiresAt)
      : undefined;
  return {
    bindingId: `generic:${currentConversationBindingKey(conversation)}`,
    targetSessionKey,
    targetKind,
    conversation,
    status,
    boundAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? { metadata: record.metadata }
      : {}),
  };
}

function normalizeLegacyCurrentConversationBindingFile(input: unknown): SessionBindingRecord[] {
  const file =
    input && typeof input === "object" ? (input as LegacyCurrentConversationBindingsFile) : {};
  if (file.version !== 1 || !Array.isArray(file.bindings)) {
    return [];
  }
  const records = new Map<string, SessionBindingRecord>();
  for (const item of file.bindings) {
    const record = normalizeLegacyCurrentConversationBindingRecord(item);
    if (!record) {
      continue;
    }
    records.set(currentConversationBindingKey(record.conversation), record);
  }
  return [...records.values()].toSorted((a, b) => a.bindingId.localeCompare(b.bindingId));
}

function currentConversationBindingRow(record: SessionBindingRecord): {
  binding_key: string;
  binding_id: string;
  target_agent_id: string;
  target_session_id: string | null;
  target_session_key: string;
  channel: string;
  account_id: string;
  conversation_kind: string;
  parent_conversation_id: string | null;
  conversation_id: string;
  target_kind: string;
  status: string;
  bound_at: number;
  expires_at: number | null;
  metadata_json: string | null;
  record_json: string;
  updated_at: number;
} {
  const conversation = normalizeConversationRef(record.conversation);
  return {
    binding_key: currentConversationBindingKey(conversation),
    binding_id: record.bindingId,
    target_agent_id: resolveAgentIdFromSessionKey(record.targetSessionKey),
    target_session_id: null,
    target_session_key: record.targetSessionKey,
    channel: conversation.channel,
    account_id: conversation.accountId,
    conversation_kind: CURRENT_BINDING_CONVERSATION_KIND,
    parent_conversation_id: conversation.parentConversationId ?? null,
    conversation_id: conversation.conversationId,
    target_kind: record.targetKind,
    status: record.status,
    bound_at: record.boundAt,
    expires_at: record.expiresAt ?? null,
    metadata_json: record.metadata ? JSON.stringify(record.metadata) : null,
    record_json: JSON.stringify(record),
    updated_at: Date.now(),
  };
}

function migrateLegacyCurrentConversationBindings(params: {
  detected: LegacyStateDetection["currentConversationBindings"];
  stateDir: string;
}): { changes: string[]; warnings: string[] } {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!fileExists(params.detected.sourcePath)) {
    return { changes, warnings };
  }
  let records: SessionBindingRecord[];
  try {
    records = normalizeLegacyCurrentConversationBindingFile(
      readLegacyJsonObject(params.detected.sourcePath),
    );
  } catch (err) {
    warnings.push(
      `Failed reading legacy current-conversation bindings ${params.detected.sourcePath}: ${String(err)}`,
    );
    return { changes, warnings };
  }

  let importedCount = 0;
  let shouldArchive = records.length === 0;
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const stateDb = getNodeSqliteKysely<LegacyCurrentConversationBindingsImportDatabase>(db);
        const existing = executeSqliteQuerySync(
          db,
          stateDb
            .selectFrom("current_conversation_bindings")
            .select(["binding_key", "record_json"]),
        ).rows;
        const existingByKey = new Map(
          existing.map((row) => [row.binding_key, row.record_json] as const),
        );
        const recordsToInsert: SessionBindingRecord[] = [];
        let conflictCount = 0;
        for (const record of records) {
          const key = currentConversationBindingKey(record.conversation);
          const existingRecordJson = existingByKey.get(key);
          if (existingRecordJson === undefined) {
            recordsToInsert.push(record);
          } else if (existingRecordJson !== JSON.stringify(record)) {
            conflictCount += 1;
          }
        }
        if (recordsToInsert.length === 0) {
          shouldArchive = conflictCount === 0;
          if (conflictCount > 0) {
            warnings.push(
              `Left legacy current-conversation bindings in place because ${conflictCount} ${conflictCount === 1 ? "binding conflicts" : "bindings conflict"} with shared SQLite state: ${params.detected.sourcePath}`,
            );
          }
          return;
        }
        executeSqliteQuerySync(
          db,
          stateDb
            .insertInto("current_conversation_bindings")
            .values(recordsToInsert.map(currentConversationBindingRow)),
        );
        importedCount = recordsToInsert.length;
        shouldArchive = conflictCount === 0;
        if (conflictCount > 0) {
          warnings.push(
            `Left legacy current-conversation bindings in place because ${conflictCount} ${conflictCount === 1 ? "binding conflicts" : "bindings conflict"} with shared SQLite state: ${params.detected.sourcePath}`,
          );
        }
      },
      { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
    );
  } catch (err) {
    warnings.push(`Failed migrating legacy current-conversation bindings: ${String(err)}`);
  }
  if (importedCount > 0) {
    changes.push(
      `Migrated ${importedCount} current-conversation ${importedCount === 1 ? "binding" : "bindings"} → shared SQLite state`,
    );
  }
  if (shouldArchive) {
    archiveLegacyImportSource({
      sourcePath: params.detected.sourcePath,
      label: "current-conversation bindings",
      changes,
      warnings,
    });
  }
  return { changes, warnings };
}

async function migrateLegacyPluginStateSidecar(params: {
  stateDir: string;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const sourcePath = resolveLegacyPluginStateSidecarPath(params.stateDir);
  if (!fileExists(sourcePath)) {
    const changes: string[] = [];
    const warnings: string[] = [];
    if (hasPendingSqliteSidecarArchive(sourcePath, PLUGIN_STATE_SQLITE_SIDECAR_SUFFIXES)) {
      archiveLegacyPluginStateSidecar({ sourcePath, changes, warnings });
    }
    return { changes, warnings };
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
    let skippedExpired = 0;
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
          const legacyExpired = isLegacyPluginStateRowExpired(row, now);
          if (existing) {
            if (!legacyPluginStateRowsMatch(existing, row)) {
              if (legacyExpired) {
                skippedExpired += 1;
              } else {
                conflictedKeys.push(`${row.plugin_id}/${row.namespace}/${row.entry_key}`);
              }
            }
            continue;
          }
          if (legacyExpired) {
            skippedExpired += 1;
            continue;
          }
          rowsToInsert.push(row);
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
    if (conflictedKeys.length > 0) {
      return {
        changes,
        warnings: [
          `Left plugin-state sidecar in place because ${conflictedKeys.length} ${conflictedKeys.length === 1 ? "row" : "rows"} already existed in shared state: ${conflictedKeys[0]}`,
        ],
      };
    }
    if (skippedExpired > 0) {
      changes.push(
        `Dropped ${skippedExpired} expired plugin-state sidecar ${skippedExpired === 1 ? "entry" : "entries"}`,
      );
    }
  } catch (err) {
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
          ...(plan.defaultTtlMs != null ? { defaultTtlMs: plan.defaultTtlMs } : {}),
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
        if (allEntriesCovered && plan.removeSource) {
          try {
            await plan.removeSource();
            changes.push(`Removed ${plan.label} legacy source (${plan.sourcePath})`);
          } catch (err) {
            warnings.push(`Failed removing ${plan.label} legacy source: ${String(err)}`);
          }
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

function isLegacyDefaultMainAliasKey(key: string, mainKey: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(key.trim());
  const canonicalMainKey = normalizeMainKey(mainKey);
  return (
    lower === `agent:${DEFAULT_AGENT_ID}:${DEFAULT_MAIN_KEY}` ||
    lower === `agent:${DEFAULT_AGENT_ID}:${canonicalMainKey}`
  );
}

function resolveCanonicalAgentSessionOwner(key: string): string | undefined {
  const parsed = parseAgentSessionKey(key);
  if (
    parsed === null ||
    !isValidAgentId(parsed.agentId) ||
    normalizeAgentId(parsed.agentId) !== parsed.agentId
  ) {
    return undefined;
  }
  return parsed.agentId;
}

function canonicalizeSessionKeyForAgent(params: {
  key: string;
  agentId: string;
  mainKey: string;
  scope?: SessionScope;
  skipCrossAgentRemap?: boolean;
  preserveCanonicalAgentOwner?: boolean;
  preserveAmbiguousKeys?: boolean;
  preserveForeignMainAliases?: boolean;
}): string {
  const raw = params.key.trim();
  if (!raw) {
    return raw;
  }
  const rawLower = normalizeLowercaseStringOrEmpty(raw);
  const legacyDefaultMainAlias = isLegacyDefaultMainAliasKey(rawLower, params.mainKey);
  const configuredAgentId = normalizeAgentId(params.agentId);
  const canonicalRowOwner = resolveCanonicalAgentSessionOwner(raw);
  // Shared stores may contain rows for several agents. Canonicalize a valid
  // wrapper within its declared owner so another agent pass cannot adopt it.
  // The default-agent main alias remains an orphan when a different single
  // owner is authoritative for this store.
  const candidateOwner = params.preserveCanonicalAgentOwner ? canonicalRowOwner : undefined;
  const parsedOwner =
    candidateOwner === DEFAULT_AGENT_ID &&
    configuredAgentId !== DEFAULT_AGENT_ID &&
    legacyDefaultMainAlias
      ? undefined
      : candidateOwner;
  const agentId = parsedOwner ?? configuredAgentId;
  const normalized = normalizeSessionKeyPreservingOpaquePeerIds(raw);
  if (rawLower === "global" || rawLower === "unknown") {
    return rawLower;
  }
  // Plugin-routed stores can contain either a core orphan or an opaque explicit
  // key with this shape. Without row provenance, never merge the two.
  if (params.preserveForeignMainAliases && legacyDefaultMainAlias) {
    return params.key;
  }
  const canonicalMain = canonicalizeMainSessionAlias({
    cfg: { session: { scope: params.scope, mainKey: params.mainKey } },
    agentId,
    sessionKey: normalized,
  });
  // Global scope has one owner, so recognized main aliases are never ambiguous.
  if (params.scope === "global" && canonicalMain === "global") {
    return canonicalMain;
  }
  // Unscoped and legacy default-main keys in a potentially shared store have no durable owner.
  // Keep it untouched instead of assigning another agent's history by iteration order.
  if (params.preserveAmbiguousKeys && (!canonicalRowOwner || legacyDefaultMainAlias)) {
    return params.key;
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

  if (canonicalMain !== normalized) {
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

  // A malformed agent-shaped key has no authoritative row owner. Once shared-store
  // preservation is ruled out, treat it as opaque input owned by the configured agent.
  if (rawLower.startsWith("agent:") && canonicalRowOwner) {
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
    const normalizedLower = normalizeLowercaseStringOrEmpty(normalized);
    if (normalizedLower === "global") {
      continue;
    }
    if (normalizedLower.startsWith("agent:")) {
      continue;
    }
    if (normalizedLower.startsWith("subagent:")) {
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
  const shaped = normalizePersistedSessionEntryShape(entry);
  if (!shaped) {
    return null;
  }
  const normalized = { ...shaped };
  if (typeof normalized.sessionId === "string") {
    normalized.updatedAt =
      typeof normalized.updatedAt === "number" && Number.isFinite(normalized.updatedAt)
        ? normalized.updatedAt
        : Date.now();
  }
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
  preserveCanonicalAgentOwner?: boolean;
  preserveAmbiguousKeys?: boolean;
  preserveForeignMainAliases?: boolean;
}): { store: Record<string, SessionEntryLike>; legacyKeys: string[] } {
  const canonical = Object.create(null) as Record<string, SessionEntryLike>;
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
      preserveCanonicalAgentOwner: params.preserveCanonicalAgentOwner,
      preserveAmbiguousKeys: params.preserveAmbiguousKeys,
      preserveForeignMainAliases: params.preserveForeignMainAliases,
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

function isAmbiguousSharedStoreKey(key: string, mainKey: string, scope?: SessionScope): boolean {
  const raw = key.trim();
  const lower = normalizeLowercaseStringOrEmpty(raw);
  if (!raw || lower === "global" || lower === "unknown") {
    return false;
  }
  if (
    scope === "global" &&
    canonicalizeMainSessionAlias({
      cfg: { session: { scope, mainKey } },
      agentId: DEFAULT_AGENT_ID,
      sessionKey: lower,
    }) === "global"
  ) {
    return false;
  }
  return !resolveCanonicalAgentSessionOwner(raw) || isLegacyDefaultMainAliasKey(lower, mainKey);
}

function aliasedSessionStoreMigrationWarning(params: {
  subject: "migration of" | "ACP metadata migration for";
  count: number;
  storePath: string;
}): string {
  return `Deferred ${params.subject} ${params.count} ambiguous session key(s) in aliased store ${params.storePath}; remove filesystem aliases or configure one canonical session.store path, then rerun openclaw doctor --fix`;
}

function unresolvedSessionStoreIdentityWarning(subject: string, storePath: string): string {
  return `Deferred ${subject} for ${storePath}; filesystem identity could not be established for every configured store path. Restore path access or configure one canonical session.store path, then rerun openclaw doctor --fix`;
}

function distinctSessionStoreAliasWarning(subject: string, storePath: string): string {
  return `Deferred ${subject} in aliased store ${storePath}; atomic replacement cannot update distinct filesystem aliases as one operation. Remove filesystem aliases or configure one canonical session.store path, then rerun openclaw doctor --fix`;
}

function resolveStaleLegacySessionFile(params: {
  entry: unknown;
  legacyDir: string;
  targetDir: string;
}): string | undefined {
  if (!params.entry || typeof params.entry !== "object" || Array.isArray(params.entry)) {
    return undefined;
  }
  const entry = params.entry as SessionEntryLike;
  const rawSessionFile = entry.sessionFile;
  if (typeof rawSessionFile !== "string") {
    return undefined;
  }
  const legacySessionFile = path.isAbsolute(rawSessionFile)
    ? path.resolve(rawSessionFile)
    : path.resolve(params.legacyDir, rawSessionFile);
  const relative = path.relative(path.resolve(params.legacyDir), legacySessionFile);
  if (relative.startsWith("..") || path.isAbsolute(relative) || fileExists(legacySessionFile)) {
    return undefined;
  }
  const legacyBackupHasTranscript = safeReadDir(path.dirname(params.legacyDir)).some(
    (dirent) =>
      dirent.isDirectory() &&
      dirent.name.startsWith(`${path.basename(params.legacyDir)}.legacy-`) &&
      fileExists(
        path.join(path.dirname(params.legacyDir), dirent.name, path.basename(legacySessionFile)),
      ),
  );
  if (legacyBackupHasTranscript) {
    return undefined;
  }
  const parsed = path.parse(path.basename(legacySessionFile));
  const hasCollisionRename = safeReadDir(params.targetDir).some(
    (dirent) =>
      dirent.isFile() &&
      dirent.name.startsWith(`${parsed.name}.legacy-`) &&
      dirent.name.endsWith(parsed.ext),
  );
  if (hasCollisionRename) {
    return undefined;
  }
  const targetSessionFile = path.join(params.targetDir, path.basename(legacySessionFile));
  if (!fileExists(targetSessionFile) || typeof entry.sessionId !== "string") {
    return undefined;
  }
  const readFirstLine = () => {
    const fd = fs.openSync(targetSessionFile, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (bytesRead <= 0) {
        return undefined;
      }
      const chunk = buffer.subarray(0, bytesRead).toString("utf8");
      const newline = chunk.indexOf("\n");
      return newline >= 0 ? chunk.slice(0, newline) : chunk;
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    const firstLine = readFirstLine();
    const header = firstLine ? (JSON.parse(firstLine) as unknown) : undefined;
    if (!header || typeof header !== "object" || Array.isArray(header)) {
      return undefined;
    }
    if ((header as { type?: unknown }).type === "session") {
      return (header as { id?: unknown }).id === entry.sessionId ? targetSessionFile : undefined;
    }
    const canonicalFileName =
      path.basename(entry.sessionId) === entry.sessionId ? `${entry.sessionId}.jsonl` : undefined;
    return canonicalFileName === path.basename(targetSessionFile) ? targetSessionFile : undefined;
  } catch {
    return undefined;
  }
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
  preserveForeignMainAliases?: boolean;
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
    if (
      params.preserveForeignMainAliases &&
      isLegacyDefaultMainAliasKey(lowerKey, params.mainKey)
    ) {
      return true;
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
    const rowOwner = resolveCanonicalAgentSessionOwner(rawKey);
    if (!rowOwner) {
      return true;
    }
    const agentMainAlias = `agent:${rowOwner}:${DEFAULT_MAIN_KEY}`;
    const agentMainKey = `agent:${rowOwner}:${params.mainKey}`;
    if (
      lowerKey === agentMainAlias &&
      (params.mainKey !== DEFAULT_MAIN_KEY || params.scope === "global")
    ) {
      return true;
    }
    if (lowerKey === agentMainKey && params.scope === "global") {
      return true;
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
  preserveAmbiguousKeys?: boolean;
  preserveForeignMainAliases?: boolean;
}): string[] {
  const legacy: string[] = [];
  for (const key of Object.keys(params.store)) {
    const canonical = canonicalizeSessionKeyForAgent({
      key,
      agentId: params.agentId,
      mainKey: params.mainKey,
      scope: params.scope,
      skipCrossAgentRemap: params.preserveAmbiguousKeys,
      preserveCanonicalAgentOwner: params.preserveAmbiguousKeys,
      preserveAmbiguousKeys: params.preserveAmbiguousKeys,
      preserveForeignMainAliases: params.preserveForeignMainAliases,
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
  notices?: string[];
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
  crossStateDirImports?: boolean;
}): Promise<{
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
}> {
  if (autoMigrateTaskStateSidecarsChecked) {
    return { migrated: false, skipped: true, changes: [], warnings: [] };
  }
  autoMigrateTaskStateSidecarsChecked = true;

  const stateDir = resolveStateDir(params.env ?? process.env, params.homedir);
  const result = await migrateLegacyTaskStateSidecars({ stateDir });
  const detectedExecApprovals = detectLegacyExecApprovalsMigration({
    env: params.env ?? process.env,
    homedir: params.homedir ?? os.homedir,
    stateDir,
  });
  // Cross-state-dir sources need the explicit doctor opt-in (see
  // detectLegacyStateMigrations); the implicit preflight must not archive
  // files that belong to the default state dir.
  const crossStateDirImports = params.crossStateDirImports === true;
  const execApprovals = migrateLegacyExecApprovals(
    crossStateDirImports ? detectedExecApprovals : { ...detectedExecApprovals, hasLegacy: false },
  );
  const notices: string[] = [];
  if (detectedExecApprovals.hasLegacy && !crossStateDirImports) {
    notices.push(
      `Exec approvals in the default state dir were not imported into OPENCLAW_STATE_DIR automatically (${detectedExecApprovals.sourcePath} -> ${detectedExecApprovals.targetPath}); run \`openclaw doctor --fix\` to import them.`,
    );
  }
  const changes = [...result.changes, ...execApprovals.changes];
  const warnings = [...result.warnings, ...execApprovals.warnings];
  const logger = params.log ?? createSubsystemLogger("state-migrations");
  if (changes.length > 0) {
    logger.info(`Auto-migrated legacy state:\n${changes.map((entry) => `- ${entry}`).join("\n")}`);
  }
  if (warnings.length > 0) {
    logger.warn(
      `Legacy state migration warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }
  if (notices.length > 0) {
    logger.info(
      `Legacy state migration notes:\n${notices.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }
  return {
    migrated: changes.length > 0,
    skipped: false,
    changes,
    warnings,
    ...(notices.length > 0 ? { notices } : {}),
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
  pluginDoctorConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  oauthDir: string;
  warnings?: string[];
}): Promise<DetectedPluginDoctorStateMigrationPlan[]> {
  const plans: DetectedPluginDoctorStateMigrationPlan[] = [];
  const config = params.pluginDoctorConfig ?? params.cfg;
  for (const entry of listPluginDoctorStateMigrationEntries({
    config,
    env: params.env,
  })) {
    let detected: PluginDoctorStateMigrationDetection | null;
    try {
      detected = await entry.migration.detectLegacyState({
        config,
        env: params.env,
        stateDir: params.stateDir,
        oauthDir: params.oauthDir,
        context: createPluginDoctorStateMigrationContext(entry.pluginId, params.env),
      });
    } catch (err) {
      params.warnings?.push(`Failed detecting ${entry.migration.label}: ${String(err)}`);
      continue;
    }
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
  pluginDoctorConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  pluginSessionStoreAgentIds?: readonly string[];
  sessionStoreOwnership?: SessionStoreOwnership;
  crossStateDirImports?: boolean;
}): Promise<LegacyStateDetection> {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  const stateDir = resolveStateDir(env, homedir);
  const oauthDir = resolveOAuthDir(env, stateDir);
  // Sources under the DEFAULT home state dir are foreign state when
  // OPENCLAW_STATE_DIR points elsewhere: an isolated/test gateway must never
  // import (and archive) another install's files. Only an explicit doctor run
  // opts into the cross-directory import.
  const crossStateDirImports = params.crossStateDirImports === true;
  const notices: string[] = [];
  const detectedExecApprovals = detectLegacyExecApprovalsMigration({ env, homedir, stateDir });
  const execApprovals = crossStateDirImports
    ? detectedExecApprovals
    : { ...detectedExecApprovals, hasLegacy: false };
  if (detectedExecApprovals.hasLegacy && !crossStateDirImports) {
    notices.push(
      `Exec approvals in the default state dir were not imported into OPENCLAW_STATE_DIR automatically (${detectedExecApprovals.sourcePath} -> ${detectedExecApprovals.targetPath}); run \`openclaw doctor --fix\` to import them.`,
    );
  }

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
  const pluginConfig = params.pluginDoctorConfig ?? params.cfg;
  const pluginSessionStoreAgentIds =
    params.pluginSessionStoreAgentIds ??
    listPluginDoctorSessionStoreAgentIds({
      config: pluginConfig,
      env,
      pluginIds: collectRelevantDoctorPluginIds(pluginConfig),
    });
  const currentSessionStoreOwnership = resolveSessionStoreOwnership({
    cfg: params.cfg,
    env,
    stateDir,
    targetAgentId,
    pluginSessionStoreAgentIds,
  });
  const sessionStoreOwnership: SessionStoreOwnership = {
    preserveAmbiguousKeys:
      params.sessionStoreOwnership?.preserveAmbiguousKeys === true ||
      currentSessionStoreOwnership.preserveAmbiguousKeys,
    preserveForeignMainAliases:
      params.sessionStoreOwnership?.preserveForeignMainAliases === true ||
      currentSessionStoreOwnership.preserveForeignMainAliases,
    targetStoreAliases: mergeSessionStoreAliasPlans(
      params.sessionStoreOwnership?.targetStoreAliases,
      currentSessionStoreOwnership.targetStoreAliases,
    ),
  };
  const { preserveForeignMainAliases } = sessionStoreOwnership;
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
        preserveAmbiguousKeys: sessionStoreOwnership.preserveAmbiguousKeys,
        preserveForeignMainAliases,
      })
    : [];
  const hasStaleSessionFiles =
    targetSessionParsed.ok &&
    Object.values(targetSessionParsed.store).some((entry) =>
      Boolean(
        resolveStaleLegacySessionFile({
          entry,
          legacyDir: sessionsLegacyDir,
          targetDir: sessionsTargetDir,
        }),
      ),
    );

  const legacyAgentDir = path.join(stateDir, "agent");
  const targetAgentDir = path.join(stateDir, "agents", targetAgentId, "agent");
  const hasLegacyAgentDir = existsDir(legacyAgentDir);
  const pluginStateSidecarPath = resolveLegacyPluginStateSidecarPath(stateDir);
  const hasPluginStateSidecar = fileExists(pluginStateSidecarPath);
  const hasPendingPluginStateSidecarArchive = hasPendingSqliteSidecarArchive(
    pluginStateSidecarPath,
    PLUGIN_STATE_SQLITE_SIDECAR_SUFFIXES,
  );
  const pluginInstallIndexPath = resolveLegacyInstalledPluginIndexStorePath({ stateDir });
  const hasPluginInstallIndex = fileExists(pluginInstallIndexPath);
  const debugProxyCaptureSidecar = detectLegacyDebugProxyCaptureSidecar(stateDir, env);
  const stateSchemaMigrations = detectOpenClawStateDatabaseSchemaMigrations({
    env: { ...env, OPENCLAW_STATE_DIR: stateDir },
  });
  const taskRunsSidecarPath = resolveLegacyTaskRunsSidecarPath(stateDir);
  const flowRunsSidecarPath = resolveLegacyFlowRunsSidecarPath(stateDir);
  const hasPendingTaskRunsSidecarArchive = hasPendingSqliteSidecarArchive(
    taskRunsSidecarPath,
    TASK_STATE_SQLITE_SIDECAR_SUFFIXES,
  );
  const hasPendingFlowRunsSidecarArchive = hasPendingSqliteSidecarArchive(
    flowRunsSidecarPath,
    TASK_STATE_SQLITE_SIDECAR_SUFFIXES,
  );
  const hasTaskStateSidecars =
    fileExists(taskRunsSidecarPath) ||
    fileExists(flowRunsSidecarPath) ||
    hasPendingTaskRunsSidecarArchive ||
    hasPendingFlowRunsSidecarArchive;
  const deliveryQueuePaths = {
    outboundPath: resolveLegacyDeliveryQueuePath(stateDir, "delivery-queue"),
    sessionPath: resolveLegacyDeliveryQueuePath(stateDir, "session-delivery-queue"),
  };
  const hasDeliveryQueues =
    listLegacyDeliveryQueueFiles(deliveryQueuePaths.outboundPath).length > 0 ||
    listLegacyDeliveryQueueDeliveredMarkers(deliveryQueuePaths.outboundPath).length > 0 ||
    listLegacyDeliveryQueueFiles(deliveryQueuePaths.sessionPath).length > 0 ||
    listLegacyDeliveryQueueDeliveredMarkers(deliveryQueuePaths.sessionPath).length > 0;
  const voiceWake = {
    triggersPath: resolveLegacyVoiceWakeTriggersPath(stateDir),
    routingPath: resolveLegacyVoiceWakeRoutingPath(stateDir),
  };
  const hasVoiceWake = fileExists(voiceWake.triggersPath) || fileExists(voiceWake.routingPath);
  const updateCheck = {
    sourcePath: resolveLegacyUpdateCheckPath(stateDir),
  };
  const hasUpdateCheck = fileExists(updateCheck.sourcePath);
  const configHealth = {
    sourcePath: resolveLegacyConfigHealthPath(stateDir),
  };
  const hasConfigHealth = fileExists(configHealth.sourcePath);
  const pluginBindingApprovals = {
    sourcePath: resolveLegacyPluginBindingApprovalsPath(env, homedir),
  };
  const pluginBindingApprovalsCrossDir =
    path.resolve(path.dirname(pluginBindingApprovals.sourcePath)) !== path.resolve(stateDir);
  const hasPluginBindingApprovals =
    !isNamedProfile(env) &&
    fileExists(pluginBindingApprovals.sourcePath) &&
    (crossStateDirImports || !pluginBindingApprovalsCrossDir);
  if (
    !isNamedProfile(env) &&
    fileExists(pluginBindingApprovals.sourcePath) &&
    pluginBindingApprovalsCrossDir &&
    !crossStateDirImports
  ) {
    notices.push(
      `Plugin binding approvals in the default state dir were not imported into OPENCLAW_STATE_DIR automatically (${pluginBindingApprovals.sourcePath}); run \`openclaw doctor --fix\` to import them.`,
    );
  }
  const currentConversationBindings = {
    sourcePath: resolveLegacyCurrentConversationBindingsPath(stateDir),
  };
  const hasCurrentConversationBindings = fileExists(currentConversationBindings.sourcePath);
  const channelPlans = await collectChannelLegacyStateMigrationPlans({
    cfg: params.cfg,
    env,
    stateDir,
    oauthDir,
  });
  const pluginPlanWarnings: string[] = [];
  const pluginPlans =
    stateSchemaMigrations.length > 0
      ? []
      : await collectPluginDoctorStateMigrationPlans({
          cfg: params.cfg,
          pluginDoctorConfig: params.pluginDoctorConfig,
          env,
          stateDir,
          oauthDir,
          warnings: pluginPlanWarnings,
        });

  const preview: string[] = [];
  if (hasLegacySessions) {
    preview.push(`- Sessions: ${sessionsLegacyDir} → ${sessionsTargetDir}`);
  }
  if (legacyKeys.length > 0) {
    preview.push(`- Sessions: canonicalize legacy keys in ${sessionsTargetStorePath}`);
  }
  if (hasStaleSessionFiles) {
    preview.push(`- Sessions: repair migrated transcript paths in ${sessionsTargetStorePath}`);
  }
  if (hasLegacyAgentDir) {
    preview.push(`- Agent dir: ${legacyAgentDir} → ${targetAgentDir}`);
  }
  if (hasPluginStateSidecar) {
    preview.push(`- Plugin state sidecar: ${pluginStateSidecarPath} → shared SQLite state`);
  } else if (hasPendingPluginStateSidecarArchive) {
    preview.push(`- Plugin state sidecar: finish archive cleanup for ${pluginStateSidecarPath}`);
  }
  if (hasPluginInstallIndex) {
    preview.push(`- Plugin install index: ${pluginInstallIndexPath} → shared SQLite state`);
  }
  if (debugProxyCaptureSidecar.hasLegacy) {
    preview.push(
      `- Debug proxy capture sidecar: ${debugProxyCaptureSidecar.sourcePath} → shared SQLite state`,
    );
  }
  if (stateSchemaMigrations.length > 0) {
    for (const migration of stateSchemaMigrations) {
      preview.push(
        migration.kind === "agent-databases-composite-primary-key"
          ? "- Shared SQLite schema: agent database registry primary key → agent_id,path"
          : "- Shared SQLite schema: audit event ledger → versioned message lifecycle schema",
      );
    }
    preview.push(
      "- Rerun doctor after shared SQLite schema repair to detect plugin state migrations",
    );
  }
  if (fileExists(taskRunsSidecarPath)) {
    preview.push(`- Task registry sidecar: ${taskRunsSidecarPath} → shared SQLite state`);
  } else if (hasPendingTaskRunsSidecarArchive) {
    preview.push(`- Task registry sidecar: finish archive cleanup for ${taskRunsSidecarPath}`);
  }
  if (fileExists(flowRunsSidecarPath)) {
    preview.push(`- Task flow sidecar: ${flowRunsSidecarPath} → shared SQLite state`);
  } else if (hasPendingFlowRunsSidecarArchive) {
    preview.push(`- Task flow sidecar: finish archive cleanup for ${flowRunsSidecarPath}`);
  }
  if (hasDeliveryQueues) {
    preview.push("- Delivery queues: legacy JSON queue files → shared SQLite state");
  }
  if (hasVoiceWake) {
    preview.push("- Voice Wake settings: legacy JSON files → shared SQLite state");
  }
  if (hasUpdateCheck) {
    preview.push("- Update-check state: legacy JSON file → shared SQLite state");
  }
  if (hasConfigHealth) {
    preview.push("- Config health state: legacy JSON file → shared SQLite state");
  }
  if (hasPluginBindingApprovals) {
    preview.push("- Plugin binding approvals: legacy JSON file → shared SQLite state");
  }
  if (hasCurrentConversationBindings) {
    preview.push("- Current-conversation bindings: legacy JSON file → shared SQLite state");
  }
  if (execApprovals.hasLegacy) {
    preview.push(`- Exec approvals: ${execApprovals.sourcePath} → ${execApprovals.targetPath}`);
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
      hasLegacy: hasLegacySessions || legacyKeys.length > 0 || hasStaleSessionFiles,
      legacyKeys,
      preserveAmbiguousKeys: sessionStoreOwnership.preserveAmbiguousKeys,
      preserveForeignMainAliases,
      targetStoreAliases: sessionStoreOwnership.targetStoreAliases,
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
      hasLegacy: hasPluginStateSidecar || hasPendingPluginStateSidecarArchive,
    },
    pluginInstallIndex: {
      sourcePath: pluginInstallIndexPath,
      hasLegacy: hasPluginInstallIndex,
    },
    debugProxyCaptureSidecar,
    stateSchema: {
      hasLegacy: stateSchemaMigrations.length > 0,
      preview: stateSchemaMigrations.map((migration) => migration.path),
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
    voiceWake: {
      ...voiceWake,
      hasLegacy: hasVoiceWake,
    },
    updateCheck: {
      ...updateCheck,
      hasLegacy: hasUpdateCheck,
    },
    configHealth: {
      ...configHealth,
      hasLegacy: hasConfigHealth,
    },
    pluginBindingApprovals: {
      ...pluginBindingApprovals,
      hasLegacy: hasPluginBindingApprovals,
    },
    currentConversationBindings: {
      ...currentConversationBindings,
      hasLegacy: hasCurrentConversationBindings,
    },
    execApprovals,
    warnings: pluginPlanWarnings,
    notices,
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
  if (detected.sessions.targetStoreAliases.hasUnresolvedIdentity) {
    warnings.push(
      unresolvedSessionStoreIdentityWarning(
        "legacy session migration",
        detected.sessions.targetStorePath,
      ),
    );
    return { changes, warnings };
  }
  if (detected.sessions.targetStoreAliases.hasFinalSymlink) {
    warnings.push(
      `Deferred legacy session migration in final-component symlink store ${detected.sessions.targetStorePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
    );
    return { changes, warnings };
  }

  const ambiguousAliasedKeys = new Set(
    [...Object.keys(targetStore), ...Object.keys(legacyStore)].filter(
      (key) =>
        isAmbiguousSharedStoreKey(key, detected.targetMainKey, detected.targetScope) ||
        (detected.sessions.preserveForeignMainAliases &&
          isLegacyDefaultMainAliasKey(key, detected.targetMainKey)),
    ),
  );
  // Atomic replacement separates filesystem aliases. Defer the whole merge so
  // a later startup cannot treat each pathname as a different session owner.
  if (detected.sessions.targetStoreAliases.hasDistinctAliases) {
    warnings.push(
      ambiguousAliasedKeys.size > 0
        ? aliasedSessionStoreMigrationWarning({
            subject: "migration of",
            count: ambiguousAliasedKeys.size,
            storePath: detected.sessions.targetStorePath,
          })
        : distinctSessionStoreAliasWarning(
            "legacy session migration",
            detected.sessions.targetStorePath,
          ),
    );
    return { changes, warnings };
  }

  const canonicalizedTarget = canonicalizeSessionStore({
    store: targetStore,
    agentId: detected.targetAgentId,
    mainKey: detected.targetMainKey,
    scope: detected.targetScope,
    skipCrossAgentRemap: detected.sessions.preserveAmbiguousKeys,
    preserveCanonicalAgentOwner: true,
    preserveAmbiguousKeys: detected.sessions.preserveAmbiguousKeys,
    preserveForeignMainAliases: detected.sessions.preserveForeignMainAliases,
  });
  const canonicalizedLegacy = canonicalizeSessionStore({
    store: legacyStore,
    agentId: detected.targetAgentId,
    mainKey: detected.targetMainKey,
    scope: detected.targetScope,
    preserveCanonicalAgentOwner: true,
    preserveForeignMainAliases: detected.sessions.preserveForeignMainAliases,
  });
  const preservedLegacyForeignMainAliasCount = detected.sessions.preserveForeignMainAliases
    ? Object.keys(legacyStore).filter((key) =>
        isLegacyDefaultMainAliasKey(key, detected.targetMainKey),
      ).length
    : 0;

  let repairedStaleSessionFiles = false;
  for (const entry of Object.values(canonicalizedTarget.store)) {
    const targetSessionFile = resolveStaleLegacySessionFile({
      entry,
      legacyDir: detected.sessions.legacyDir,
      targetDir: detected.sessions.targetDir,
    });
    if (targetSessionFile) {
      entry.sessionFile = targetSessionFile;
      repairedStaleSessionFiles = true;
    }
  }

  const merged = Object.create(null) as Record<string, SessionEntryLike>;
  for (const [key, entry] of Object.entries(canonicalizedTarget.store)) {
    merged[key] = entry;
  }
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
    const normalized = Object.create(null) as Record<string, SessionEntry>;
    for (const [key, entry] of Object.entries(merged)) {
      const normalizedEntry = normalizeSessionEntry(entry);
      if (!normalizedEntry) {
        continue;
      }
      normalized[key] = normalizedEntry;
    }
    await saveSessionStoreStrict(detected.sessions.targetStorePath, normalized);
    if (migratedDirectChatKey) {
      changes.push(`Migrated latest direct-chat session → ${migratedDirectChatKey}`);
    }
    changes.push(`Merged sessions store → ${detected.sessions.targetStorePath}`);
    if (preservedLegacyForeignMainAliasCount > 0) {
      warnings.push(
        `Preserved ${preservedLegacyForeignMainAliasCount} ambiguous session key(s) while importing legacy sessions into ${detected.sessions.targetStorePath}`,
      );
    }
    if (canonicalizedTarget.legacyKeys.length > 0) {
      changes.push(`Canonicalized ${canonicalizedTarget.legacyKeys.length} legacy session key(s)`);
    }
    if (repairedStaleSessionFiles) {
      changes.push("Repaired migrated session transcript paths");
    }
  }

  if (!targetReadable) {
    return { changes, warnings };
  }

  const movedSessionFiles = new Map<string, string>();
  const entries = safeReadDir(detected.sessions.legacyDir);
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name === "sessions.json") {
      continue;
    }
    const from = path.join(detected.sessions.legacyDir, entry.name);
    let to = path.join(detected.sessions.targetDir, entry.name);
    if (fileExists(to)) {
      const parsed = path.parse(entry.name);
      to = path.join(detected.sessions.targetDir, `${parsed.name}.legacy-${now()}${parsed.ext}`);
    }
    try {
      fs.renameSync(from, to);
      movedSessionFiles.set(path.resolve(from), to);
      changes.push(`Moved ${entry.name} → agents/${detected.targetAgentId}/sessions`);
    } catch (err) {
      warnings.push(`Failed moving ${from}: ${String(err)}`);
    }
  }

  if (movedSessionFiles.size > 0) {
    let rewroteSessionFiles = false;
    for (const entry of Object.values(merged)) {
      const rawSessionFile = entry.sessionFile;
      const legacySessionFile =
        typeof rawSessionFile === "string"
          ? path.resolve(detected.sessions.legacyDir, rawSessionFile)
          : typeof entry.sessionId === "string"
            ? path.join(detected.sessions.legacyDir, `${entry.sessionId}.jsonl`)
            : undefined;
      const movedSessionFile = legacySessionFile
        ? movedSessionFiles.get(path.resolve(legacySessionFile))
        : undefined;
      if (!movedSessionFile) {
        continue;
      }
      entry.sessionFile = movedSessionFile;
      rewroteSessionFiles = true;
    }
    if (rewroteSessionFiles) {
      const normalized = Object.create(null) as Record<string, SessionEntry>;
      for (const [key, entry] of Object.entries(merged)) {
        const normalizedEntry = normalizeSessionEntry(entry);
        if (normalizedEntry) {
          normalized[key] = normalizedEntry;
        }
      }
      await saveSessionStoreStrict(detected.sessions.targetStorePath, normalized);
      changes.push("Rewrote migrated session transcript paths");
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
  env: NodeJS.ProcessEnv;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  const refreshedPlans = await collectPluginDoctorStateMigrationPlans({
    cfg: params.config,
    env: params.env,
    stateDir: params.detected.stateDir,
    oauthDir: params.detected.oauthDir,
    warnings,
  });
  const hasDetectorFailure = warnings.length > 0;
  // Previously detected plans are only safe when refresh found no current work.
  // If any detector failed, skip stale plans instead of migrating on old assumptions.
  const plans =
    refreshedPlans.length > 0 || hasDetectorFailure
      ? refreshedPlans
      : (params.detected.pluginPlans?.plans ?? []);
  for (const plan of plans) {
    try {
      const result = await plan.migration.migrateLegacyState({
        config: params.config,
        env: params.env,
        stateDir: params.detected.stateDir,
        oauthDir: params.detected.oauthDir,
        context: createPluginDoctorStateMigrationContext(plan.pluginId, params.env),
      });
      changes.push(...result.changes);
      warnings.push(...result.warnings);
      notices.push(...(result.notices ?? []));
    } catch (err) {
      warnings.push(`Failed migrating ${plan.migration.label}: ${String(err)}`);
    }
  }
  return notices.length > 0 ? { changes, warnings, notices } : { changes, warnings };
}

export async function autoMigrateLegacyPluginDoctorState(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: MigrationLogger;
}): Promise<{
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
}> {
  const env = params.env ?? process.env;
  const stateDirResult = await autoMigrateLegacyStateDir({
    env,
    homedir: params.homedir,
    log: params.log,
  });
  const stateDir = resolveStateDir(env, params.homedir ?? os.homedir);
  const oauthDir = resolveOAuthDir(env, stateDir);
  const stateSchema = repairOpenClawStateDatabaseSchema({
    env: { ...env, OPENCLAW_STATE_DIR: stateDir },
  });
  const changes = [...stateDirResult.changes, ...stateSchema.changes];
  const warnings = [...stateDirResult.warnings, ...stateSchema.warnings];
  const notices = [...(stateDirResult.notices ?? [])];
  if (stateSchema.warnings.length > 0) {
    return {
      migrated: stateDirResult.migrated || stateSchema.changes.length > 0,
      skipped: false,
      changes,
      warnings,
      ...(notices.length > 0 ? { notices } : {}),
    };
  }
  const plans = await collectPluginDoctorStateMigrationPlans({
    cfg: params.config,
    env,
    stateDir,
    oauthDir,
    warnings,
  });
  for (const plan of plans) {
    try {
      const result = await plan.migration.migrateLegacyState({
        config: params.config,
        env,
        stateDir,
        oauthDir,
        context: createPluginDoctorStateMigrationContext(plan.pluginId, env),
      });
      changes.push(...result.changes);
      warnings.push(...result.warnings);
      notices.push(...(result.notices ?? []));
    } catch (err) {
      warnings.push(`Failed migrating ${plan.migration.label}: ${String(err)}`);
    }
  }
  return {
    migrated: stateDirResult.migrated || stateSchema.changes.length > 0 || plans.length > 0,
    skipped: false,
    changes,
    warnings,
    ...(notices.length > 0 ? { notices } : {}),
  };
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isDefaultLegacyExecApprovalsSocketPath(params: {
  socketPath: string;
  sourcePath: string;
}): boolean {
  const expanded = expandHomePrefix(params.socketPath);
  return (
    path.resolve(expanded) ===
    path.join(path.dirname(params.sourcePath), EXEC_APPROVALS_SOCKET_FILENAME)
  );
}

function prepareMigratedExecApprovalsFile(params: {
  raw: string;
  sourcePath: string;
  targetPath: string;
}): { raw: string; warning?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.raw) as unknown;
  } catch {
    return {
      raw: "",
      warning: `Legacy exec approvals file unreadable; left in place at ${params.sourcePath}`,
    };
  }
  if (!isPlainJsonObject(parsed) || parsed.version !== 1) {
    return {
      raw: "",
      warning: `Legacy exec approvals file has unsupported shape; left in place at ${params.sourcePath}`,
    };
  }

  const next: Record<string, unknown> = { ...parsed };
  const socket = isPlainJsonObject(next.socket) ? { ...next.socket } : {};
  const rawSocketPath = typeof socket.path === "string" ? socket.path.trim() : "";
  if (
    !rawSocketPath ||
    isDefaultLegacyExecApprovalsSocketPath({
      socketPath: rawSocketPath,
      sourcePath: params.sourcePath,
    })
  ) {
    socket.path = resolveExecApprovalsSocketPathForStateDir(path.dirname(params.targetPath));
  }
  next.socket = socket;
  return { raw: `${JSON.stringify(next, null, 2)}\n` };
}

function assertSafeExecApprovalsMigrationTarget(targetPath: string): void {
  const targetDir = path.dirname(targetPath);
  assertNoSymlinkParentsSync({
    rootDir: resolveRequiredHomeDir(),
    targetPath: targetDir,
    allowOutsideRoot: true,
    messagePrefix: "Refusing to traverse symlink in exec approvals migration path",
  });
  try {
    const targetStat = fs.lstatSync(targetPath);
    if (targetStat.isSymbolicLink()) {
      throw new Error(`Refusing to migrate exec approvals via symlink: ${targetPath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

function writeMigratedExecApprovalsFile(targetPath: string, raw: string): boolean {
  const targetDir = path.dirname(targetPath);
  assertSafeExecApprovalsMigrationTarget(targetPath);
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  assertSafeExecApprovalsMigrationTarget(targetPath);
  const dirStat = fs.lstatSync(targetDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error(`Refusing to migrate exec approvals into unsafe directory: ${targetDir}`);
  }
  try {
    fs.chmodSync(targetDir, 0o700);
  } catch {
    // best-effort on platforms without chmod
  }
  const tempPath = path.join(targetDir, `.exec-approvals.migration.${process.pid}.tmp`);
  fs.writeFileSync(tempPath, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    try {
      fs.copyFileSync(tempPath, targetPath, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      try {
        fs.rmSync(targetPath, { force: true });
      } catch {
        // best-effort cleanup for an incomplete exclusive copy target
      }
      throw err;
    }
    try {
      fs.chmodSync(targetPath, 0o600);
    } catch {
      // best-effort on platforms without chmod
    }
    return true;
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function archiveMigratedExecApprovalsSource(sourcePath: string): string {
  let archivePath = `${sourcePath}.migrated`;
  if (fileExists(archivePath)) {
    archivePath = `${archivePath}-${Date.now()}`;
  }
  fs.renameSync(sourcePath, archivePath);
  return archivePath;
}

function migrateLegacyExecApprovals(detected: LegacyExecApprovalsMigrationDetection): {
  changes: string[];
  warnings: string[];
} {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!detected.hasLegacy) {
    return { changes, warnings };
  }
  if (fileExists(detected.targetPath)) {
    return { changes, warnings };
  }
  try {
    const sourceStat = fs.lstatSync(detected.sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      warnings.push(
        `Legacy exec approvals file is not a regular file; left in place at ${detected.sourcePath}`,
      );
      return { changes, warnings };
    }
    try {
      const targetStat = fs.lstatSync(detected.targetPath);
      if (targetStat.isSymbolicLink()) {
        warnings.push(
          `Target exec approvals path is a symlink; skipped migration at ${detected.targetPath}`,
        );
        return { changes, warnings };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    const prepared = prepareMigratedExecApprovalsFile({
      raw: fs.readFileSync(detected.sourcePath, "utf8"),
      sourcePath: detected.sourcePath,
      targetPath: detected.targetPath,
    });
    if (prepared.warning) {
      warnings.push(prepared.warning);
      return { changes, warnings };
    }
    if (!writeMigratedExecApprovalsFile(detected.targetPath, prepared.raw)) {
      return { changes, warnings };
    }
    changes.push(`Migrated exec approvals → ${detected.targetPath}`);
    try {
      const archivePath = archiveMigratedExecApprovalsSource(detected.sourcePath);
      changes.push(`Archived legacy exec approvals → ${archivePath}`);
    } catch (err) {
      warnings.push(
        `Failed archiving legacy exec approvals at ${detected.sourcePath}: ${String(err)}`,
      );
    }
  } catch (err) {
    warnings.push(
      `Failed migrating exec approvals (${detected.sourcePath} → ${detected.targetPath}): ${String(
        err,
      )}`,
    );
  }
  return { changes, warnings };
}

function migrateLegacyStateSchema(
  detected: LegacyStateDetection,
  env: NodeJS.ProcessEnv,
): {
  changes: string[];
  warnings: string[];
} {
  return repairOpenClawStateDatabaseSchema({
    env: { ...env, OPENCLAW_STATE_DIR: detected.stateDir },
  });
}

export async function runLegacyStateMigrations(params: {
  detected: LegacyStateDetection;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  recoverCorruptTargetStore?: boolean;
}): Promise<MigrationMessages> {
  const now = params.now ?? (() => Date.now());
  const detected = params.detected;
  const env = params.env ?? process.env;
  const stateSchema = migrateLegacyStateSchema(detected, env);
  if (detected.stateSchema.hasLegacy && stateSchema.warnings.length > 0) {
    return stateSchema;
  }
  const pluginStateSidecar = await migrateLegacyPluginStateSidecar({
    stateDir: detected.stateDir,
  });
  const pluginInstallIndex = await migrateLegacyInstalledPluginIndex({
    stateDir: detected.stateDir,
  });
  const debugProxyCaptureSidecar = migrateLegacyDebugProxyCaptureSidecar({
    stateDir: detected.stateDir,
    detected: detected.debugProxyCaptureSidecar,
  });
  const taskStateSidecars = await migrateLegacyTaskStateSidecars({
    stateDir: detected.stateDir,
  });
  const deliveryQueues = await migrateLegacyDeliveryQueues({
    stateDir: detected.stateDir,
  });
  const voiceWake = migrateLegacyVoiceWakeSettings({
    detected: detected.voiceWake,
    stateDir: detected.stateDir,
  });
  const updateCheck = migrateLegacyUpdateCheckState({
    detected: detected.updateCheck,
    stateDir: detected.stateDir,
  });
  const configHealth = migrateLegacyConfigHealth({
    detected: detected.configHealth,
    stateDir: detected.stateDir,
  });
  const pluginBindingApprovals = migrateLegacyPluginBindingApprovals({
    detected: detected.pluginBindingApprovals,
    stateDir: detected.stateDir,
  });
  const currentConversationBindings = migrateLegacyCurrentConversationBindings({
    detected: detected.currentConversationBindings,
    stateDir: detected.stateDir,
  });
  const execApprovals = migrateLegacyExecApprovals(detected.execApprovals);
  const preSessionChannelPlans = await runLegacyMigrationPlans(
    detected.channelPlans.plans.filter((plan) => plan.kind === "plugin-state-import"),
  );
  const pluginPlans = detected.stateSchema.hasLegacy
    ? { changes: [], warnings: [] }
    : await runPluginDoctorStateMigrationPlans({
        detected,
        config: params.config ?? ({} as OpenClawConfig),
        env,
      });
  const sessions = await migrateLegacySessions(detected, now, {
    recoverCorruptTargetStore: params.recoverCorruptTargetStore,
  });
  const acpSessionMetadata = await migrateLegacyAcpSessionMetadata({
    cfg: params.config ?? ({} as OpenClawConfig),
    env: { ...env, OPENCLAW_STATE_DIR: detected.stateDir },
    now,
  });
  const agentDir = await migrateLegacyAgentDir(detected, now);
  const channelPlans = await runLegacyMigrationPlans(
    detected.channelPlans.plans.filter((plan) => plan.kind !== "plugin-state-import"),
  );
  return {
    changes: [
      ...stateSchema.changes,
      ...pluginStateSidecar.changes,
      ...pluginInstallIndex.changes,
      ...debugProxyCaptureSidecar.changes,
      ...taskStateSidecars.changes,
      ...deliveryQueues.changes,
      ...voiceWake.changes,
      ...updateCheck.changes,
      ...configHealth.changes,
      ...pluginBindingApprovals.changes,
      ...currentConversationBindings.changes,
      ...execApprovals.changes,
      ...preSessionChannelPlans.changes,
      ...pluginPlans.changes,
      ...sessions.changes,
      ...acpSessionMetadata.changes,
      ...agentDir.changes,
      ...channelPlans.changes,
    ],
    warnings: [
      ...stateSchema.warnings,
      ...detected.warnings,
      ...pluginStateSidecar.warnings,
      ...pluginInstallIndex.warnings,
      ...debugProxyCaptureSidecar.warnings,
      ...taskStateSidecars.warnings,
      ...deliveryQueues.warnings,
      ...voiceWake.warnings,
      ...updateCheck.warnings,
      ...configHealth.warnings,
      ...pluginBindingApprovals.warnings,
      ...currentConversationBindings.warnings,
      ...execApprovals.warnings,
      ...preSessionChannelPlans.warnings,
      ...pluginPlans.warnings,
      ...sessions.warnings,
      ...acpSessionMetadata.warnings,
      ...agentDir.warnings,
      ...channelPlans.warnings,
    ],
    ...(pluginPlans.notices && pluginPlans.notices.length > 0
      ? { notices: [...pluginPlans.notices] }
      : {}),
  };
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
  additionalAgentIds?: readonly string[];
}): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
  const scope = params.cfg.session?.scope as SessionScope | undefined;
  const storeConfig = params.cfg.session?.store;
  const pluginAgentIds =
    params.additionalAgentIds ??
    listPluginDoctorSessionStoreAgentIds({
      config: params.cfg,
      env,
      pluginIds: collectRelevantDoctorPluginIds(params.cfg),
    });
  const pluginAgentIdSet = new Set(pluginAgentIds.map((id) => normalizeAgentId(id)));

  // Collect all known agent store paths with their owning agentIds.
  // A single path may be shared by multiple agents when session.store
  // does not contain {agentId}.
  const storeMap = new Map<string, Set<string>>();
  const storeAliasCandidates = new Map<string, Set<string>>();
  const addToStoreMap = (p: string, id: string) => {
    // Existing aliases are one ownership surface. Group them before any atomic
    // rewrite can replace one pathname and hide their original identity.
    const storePath =
      [...storeMap.keys()].find((candidate) => sessionStorePathsMatch(candidate, p)) ?? p;
    const aliasCandidates = storeAliasCandidates.get(storePath) ?? new Set([storePath]);
    aliasCandidates.add(p);
    storeAliasCandidates.set(storePath, aliasCandidates);
    const existing = storeMap.get(storePath);
    if (existing) {
      existing.add(id);
    } else {
      storeMap.set(storePath, new Set([id]));
    }
  };
  // Configured ownership includes normal agents plus ACP runtime/default hints.
  for (const configuredAgentId of listConfiguredSessionStoreAgentIds(params.cfg)) {
    const id = normalizeAgentId(configuredAgentId);
    const p = storeConfig
      ? resolveStorePathFromTemplate(storeConfig, id, env)
      : path.join(stateDir, "agents", id, "sessions", "sessions.json");
    addToStoreMap(p, id);
  }
  // Plugins can route core sessions to agents that are not declared in
  // agents.list. A templated path proves ownership for those stores too.
  for (const pluginAgentId of pluginAgentIds) {
    const id = normalizeAgentId(pluginAgentId);
    const p = storeConfig
      ? resolveStorePathFromTemplate(storeConfig, id, env)
      : path.join(stateDir, "agents", id, "sessions", "sessions.json");
    addToStoreMap(p, id);
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

  for (const [mappedStorePath, storeAgentIds] of storeMap) {
    const storePaths = storeAliasCandidates.get(mappedStorePath) ?? new Set([mappedStorePath]);
    // An unknown relationship may have grouped a readable store behind an
    // inaccessible pathname. Read from a usable alias so the group still gets
    // the unresolved-identity warning before any rewrite is attempted.
    const storePath = [...storePaths].find((candidate) => fileExists(candidate));
    if (!storePath) {
      continue;
    }
    const pluginForeignMainAliasRisk = [...storeAgentIds].some(
      (id) => pluginAgentIdSet.has(id) && id !== DEFAULT_AGENT_ID,
    );
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
        preserveForeignMainAliases: pluginForeignMainAliasRisk,
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

    // A physical store can have several owners. Canonicalize valid scoped rows
    // within their declared owner on every pass so iteration order cannot move
    // one agent's history into another namespace.
    let working = parsed.store;
    let totalLegacy = 0;
    const storeAliases = resolveSessionStoreAliasPlan(storePath, storePaths);
    const hasDistinctAliases = storeAliases.hasDistinctAliases;
    const preserveAmbiguousKeys = storeAgentIds.size > 1;
    const preservedAmbiguousKeyCount = Object.keys(working).filter(
      (key) =>
        (preserveAmbiguousKeys && isAmbiguousSharedStoreKey(key, mainKey, scope)) ||
        (pluginForeignMainAliasRisk && isLegacyDefaultMainAliasKey(key, mainKey)),
    ).length;
    if (storeAliases.hasUnresolvedIdentity) {
      warnings.push(unresolvedSessionStoreIdentityWarning("session key migration", storePath));
      continue;
    }
    if (hasDistinctAliases && preservedAmbiguousKeyCount > 0) {
      warnings.push(
        aliasedSessionStoreMigrationWarning({
          subject: "migration of",
          count: preservedAmbiguousKeyCount,
          storePath,
        }),
      );
      continue;
    }
    if (storeAliases.hasFinalSymlink) {
      warnings.push(
        `Deferred session key migration in final-component symlink store ${storePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
      );
      continue;
    }
    if (hasDistinctAliases) {
      warnings.push(distinctSessionStoreAliasWarning("session key migration", storePath));
      continue;
    }
    for (const storeAgentId of storeAgentIds) {
      const { store: canonicalized, legacyKeys } = canonicalizeSessionStore({
        store: working,
        agentId: storeAgentId,
        mainKey,
        scope,
        skipCrossAgentRemap: preserveAmbiguousKeys,
        preserveCanonicalAgentOwner: true,
        preserveAmbiguousKeys,
        preserveForeignMainAliases: pluginForeignMainAliasRisk,
      });
      working = canonicalized;
      // Each pass only counts keys it changed from the current working store, so
      // once a key is canonicalized it is not counted again by later agent passes.
      totalLegacy += legacyKeys.length;
    }
    if (preservedAmbiguousKeyCount > 0) {
      warnings.push(
        `Preserved ${preservedAmbiguousKeyCount} ambiguous session key(s) in potentially shared store ${storePath}`,
      );
    }
    if (totalLegacy === 0) {
      continue;
    }
    const normalized = Object.create(null) as Record<string, SessionEntry>;
    for (const [key, entry] of Object.entries(working)) {
      const ne = normalizeSessionEntry(entry);
      if (ne) {
        normalized[key] = ne;
      }
    }
    try {
      await saveSessionStoreStrict(storePath, normalized);
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
  pluginSessionStoreAgentIds?: readonly string[];
}): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const env = params.env ?? process.env;
  const now = params.now ?? (() => Date.now());
  const stateDir = resolveStateDir(env);
  const storeConfig = params.cfg.session?.store;
  const pluginAgentIds =
    params.pluginSessionStoreAgentIds ??
    listPluginDoctorSessionStoreAgentIds({
      config: params.cfg,
      env,
      pluginIds: collectRelevantDoctorPluginIds(params.cfg),
    });
  const normalizedPluginAgentIds = new Set(pluginAgentIds.map((id) => normalizeAgentId(id)));
  const declaredAgentIds = new Set([
    ...listConfiguredSessionStoreAgentIds(params.cfg).map((id) => normalizeAgentId(id)),
    ...normalizedPluginAgentIds,
  ]);
  const declaredTargets = [...declaredAgentIds].map((agentId) => ({
    agentId,
    storePath: storeConfig
      ? resolveStorePathFromTemplate(storeConfig, agentId, env)
      : path.join(stateDir, "agents", agentId, "sessions", "sessions.json"),
  }));
  const pluginTargets = declaredTargets.filter(
    ({ agentId }) => agentId !== DEFAULT_AGENT_ID && normalizedPluginAgentIds.has(agentId),
  );
  const configuredAgents = Array.isArray(params.cfg.agents?.list) ? params.cfg.agents.list : [];
  const configuredAgentIds = new Set(
    configuredAgents.flatMap((entry) => (entry?.id ? [normalizeAgentId(entry.id)] : [])),
  );
  const discoveryCfg = [...declaredAgentIds].some((agentId) => !configuredAgentIds.has(agentId))
    ? ({
        ...params.cfg,
        agents: {
          ...params.cfg.agents,
          list: [
            ...configuredAgents,
            ...[...declaredAgentIds]
              .filter((agentId) => !configuredAgentIds.has(agentId))
              .map((id) => ({ id })),
          ],
        },
      } as OpenClawConfig)
    : params.cfg;
  // Reuse the validated resolver for every declared owner. Owner multiplicity
  // is restored below as metadata without re-adding rejected raw paths.
  const targets = resolveAllAgentSessionStoreTargetsSync(discoveryCfg, { env });
  const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
  const scope = params.cfg.session?.scope as SessionScope | undefined;
  const storeGroups: Array<{
    target: (typeof targets)[number];
    agentIds: Set<string>;
    aliasCandidates: Set<string>;
  }> = [];

  for (const target of targets) {
    if (!fileExists(target.storePath)) {
      continue;
    }
    const group = storeGroups.find(({ target: existing }) =>
      sessionStorePathsMatch(existing.storePath, target.storePath),
    );
    const matchingDeclaredTargets = declaredTargets.filter((declaredTarget) =>
      sessionStorePathsMatch(target.storePath, declaredTarget.storePath),
    );
    if (group) {
      group.agentIds.add(normalizeAgentId(target.agentId));
      group.aliasCandidates.add(target.storePath);
      for (const declaredTarget of matchingDeclaredTargets) {
        group.agentIds.add(declaredTarget.agentId);
        group.aliasCandidates.add(declaredTarget.storePath);
      }
      continue;
    }
    storeGroups.push({
      target,
      agentIds: new Set([
        normalizeAgentId(target.agentId),
        ...matchingDeclaredTargets.map((declaredTarget) => declaredTarget.agentId),
      ]),
      aliasCandidates: new Set([
        target.storePath,
        ...matchingDeclaredTargets.map((declaredTarget) => declaredTarget.storePath),
      ]),
    });
  }

  for (const { target, agentIds, aliasCandidates } of storeGroups) {
    const storePath = target.storePath;
    const storeAliases = resolveSessionStoreAliasPlan(storePath, aliasCandidates);
    const pluginForeignMainAliasRisk = pluginTargets.some((pluginTarget) =>
      sessionStorePathsMatch(storePath, pluginTarget.storePath),
    );
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
    const ambiguousKeyCount = Object.keys(parsed.store).filter(
      (key) =>
        isAmbiguousSharedStoreKey(key, mainKey, scope) ||
        (pluginForeignMainAliasRisk && isLegacyDefaultMainAliasKey(key, mainKey)),
    ).length;
    const hasLegacyAcpMetadata = Object.values(parsed.store).some(
      (entry) => normalizeSessionEntry(entry)?.acp !== undefined,
    );
    if (hasLegacyAcpMetadata && storeAliases.hasUnresolvedIdentity) {
      warnings.push(unresolvedSessionStoreIdentityWarning("ACP metadata migration", storePath));
      continue;
    }
    if (hasLegacyAcpMetadata && storeAliases.hasFinalSymlink) {
      warnings.push(
        `Deferred ACP metadata migration in final-component symlink store ${storePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
      );
      continue;
    }
    if (hasLegacyAcpMetadata && storeAliases.hasDistinctAliases) {
      // Removing ACP metadata rewrites the store and would split its aliases.
      warnings.push(
        ambiguousKeyCount > 0
          ? aliasedSessionStoreMigrationWarning({
              subject: "ACP metadata migration for",
              count: ambiguousKeyCount,
              storePath,
            })
          : distinctSessionStoreAliasWarning("ACP metadata migration", storePath),
      );
      continue;
    }

    const normalized = Object.create(null) as Record<string, SessionEntry>;
    let migrated = 0;
    let preserved = 0;
    for (const [sessionKey, entry] of Object.entries(parsed.store)) {
      const normalizedEntry = normalizeSessionEntry(entry);
      if (!normalizedEntry) {
        continue;
      }
      if (normalizedEntry.acp) {
        const ambiguousSharedStoreKey = isAmbiguousSharedStoreKey(sessionKey, mainKey, scope);
        const ambiguousMultiOwnerKey = agentIds.size > 1 && ambiguousSharedStoreKey;
        const foreignMainAlias =
          pluginForeignMainAliasRisk && isLegacyDefaultMainAliasKey(sessionKey, mainKey);
        if (ambiguousMultiOwnerKey || foreignMainAlias) {
          preserved++;
          normalized[sessionKey] = normalizedEntry;
          continue;
        }
        const rowAgentId = resolveCanonicalAgentSessionOwner(sessionKey) ?? target.agentId;
        const canonicalSessionKey = canonicalizeSessionKeyForAgent({
          key: sessionKey,
          agentId: rowAgentId,
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
    if (preserved > 0) {
      warnings.push(
        `Preserved ACP metadata for ${preserved} ambiguous session key(s) in potentially shared store ${storePath}`,
      );
    }
    if (migrated === 0) {
      continue;
    }
    try {
      await saveSessionStoreStrict(storePath, normalized);
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

type SessionStorePathRelationship = "same" | "different" | "unknown";

function resolveSessionStorePathRelationship(
  left: string,
  right: string,
): SessionStorePathRelationship {
  if (left === right) {
    return "same";
  }
  try {
    return sameFileIdentity(fs.statSync(left), fs.statSync(right)) ? "same" : "different";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      return "unknown";
    }
    const resolvedLeft = resolvePathThroughExistingParents(left);
    const resolvedRight = resolvePathThroughExistingParents(right);
    if (resolvedLeft === undefined || resolvedRight === undefined) {
      return "unknown";
    }
    return resolvedLeft === resolvedRight ? "same" : "different";
  }
}

function sessionStorePathsMatch(left: string, right: string): boolean {
  // Ownership checks must fail closed: an inaccessible path may still alias the
  // readable store, so preserve shared-owner policy until identity is known.
  return resolveSessionStorePathRelationship(left, right) !== "different";
}

function resolvePathThroughExistingParents(filePath: string): string | undefined {
  const resolvedPath = path.resolve(filePath);
  const suffix = [path.basename(resolvedPath)];
  let parentPath = path.dirname(resolvedPath);
  while (true) {
    try {
      return path.join(fs.realpathSync.native(parentPath), ...suffix);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return undefined;
      }
      const nextParent = path.dirname(parentPath);
      if (nextParent === parentPath) {
        return undefined;
      }
      suffix.unshift(path.basename(parentPath));
      parentPath = nextParent;
    }
  }
}

function sessionStorePathIsFinalSymlink(storePath: string): boolean {
  try {
    return fs.lstatSync(storePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function sessionStorePathsHaveDistinctEntries(left: string, right: string): boolean {
  if (left === right) {
    return false;
  }
  try {
    // Replacing a final-component symlink splits it from its target. Parent
    // symlink spellings are safe because both names still address one entry.
    if (fs.lstatSync(left).isSymbolicLink() || fs.lstatSync(right).isSymbolicLink()) {
      return true;
    }
    // Hard links resolve to distinct pathnames and split on replacement.
    return fs.realpathSync.native(left) !== fs.realpathSync.native(right);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      return true;
    }
    const resolvedLeft = resolvePathThroughExistingParents(left);
    const resolvedRight = resolvePathThroughExistingParents(right);
    return resolvedLeft === undefined || resolvedLeft !== resolvedRight;
  }
}

function resolveSessionStoreAliasPlan(
  storePath: string,
  candidatePaths: Iterable<string>,
): SessionStoreAliasPlan {
  let hasDistinctEntries = false;
  let hasFinalSymlink = sessionStorePathIsFinalSymlink(storePath);
  let hasUnresolvedIdentity = false;
  for (const candidatePath of candidatePaths) {
    const relationship = resolveSessionStorePathRelationship(storePath, candidatePath);
    if (relationship === "different") {
      continue;
    }
    if (relationship === "unknown") {
      hasUnresolvedIdentity = true;
      continue;
    }
    hasFinalSymlink ||= sessionStorePathIsFinalSymlink(candidatePath);
    if (sessionStorePathsHaveDistinctEntries(storePath, candidatePath)) {
      hasDistinctEntries = true;
    }
  }
  return {
    hasDistinctAliases: hasFinalSymlink || hasDistinctEntries || hasUnresolvedIdentity,
    hasFinalSymlink,
    hasUnresolvedIdentity,
  };
}

function mergeSessionStoreAliasPlans(
  left: SessionStoreAliasPlan | undefined,
  right: SessionStoreAliasPlan,
): SessionStoreAliasPlan {
  if (!left) {
    return right;
  }
  return {
    hasDistinctAliases: left.hasDistinctAliases || right.hasDistinctAliases,
    hasFinalSymlink: left.hasFinalSymlink || right.hasFinalSymlink,
    hasUnresolvedIdentity: left.hasUnresolvedIdentity || right.hasUnresolvedIdentity,
  };
}

async function saveSessionStoreStrict(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  await saveSessionStore(storePath, store, {
    skipMaintenance: true,
    requireWriteSuccess: true,
  });
}

type SessionStoreOwnership = {
  preserveAmbiguousKeys: boolean;
  preserveForeignMainAliases: boolean;
  targetStoreAliases: SessionStoreAliasPlan;
};

function resolveSessionStoreOwnership(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  targetAgentId: string;
  pluginSessionStoreAgentIds: readonly string[];
}): SessionStoreOwnership {
  const targetStorePath = path.join(
    params.stateDir,
    "agents",
    params.targetAgentId,
    "sessions",
    "sessions.json",
  );
  const configuredStore = params.cfg.session?.store;
  const resolveAgentStorePath = (agentId: string) =>
    configuredStore
      ? resolveStorePathFromTemplate(configuredStore, agentId, params.env)
      : path.join(params.stateDir, "agents", agentId, "sessions", "sessions.json");
  const preserveForeignMainAliases = params.pluginSessionStoreAgentIds.some((pluginAgentId) => {
    const id = normalizeAgentId(pluginAgentId);
    if (id === DEFAULT_AGENT_ID) {
      return false;
    }
    return sessionStorePathsMatch(resolveAgentStorePath(id), targetStorePath);
  });
  const candidateAgentIds = new Set([
    ...listConfiguredSessionStoreAgentIds(params.cfg).map((id) => normalizeAgentId(id)),
    ...params.pluginSessionStoreAgentIds.map((id) => normalizeAgentId(id)),
  ]);
  const configuredOwnerStorePaths = [...candidateAgentIds].map(resolveAgentStorePath);
  const targetStoreOwnerCount = configuredOwnerStorePaths.filter((storePath) =>
    sessionStorePathsMatch(storePath, targetStorePath),
  ).length;
  const preserveAmbiguousKeys = targetStoreOwnerCount > 1;
  const candidateStorePaths = [...configuredOwnerStorePaths];
  const agentsDir = path.join(params.stateDir, "agents");
  for (const entry of safeReadDir(agentsDir)) {
    if (entry.isDirectory()) {
      candidateStorePaths.push(path.join(agentsDir, entry.name, "sessions", "sessions.json"));
    }
  }
  const targetStoreAliases = resolveSessionStoreAliasPlan(targetStorePath, candidateStorePaths);
  return { preserveAmbiguousKeys, preserveForeignMainAliases, targetStoreAliases };
}

export async function autoMigrateLegacyState(params: {
  cfg: OpenClawConfig;
  pluginDoctorConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: MigrationLogger;
  now?: () => number;
  recoverCorruptTargetStore?: boolean;
  crossStateDirImports?: boolean;
}): Promise<{
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
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
  const stateDir = resolveStateDir(env, params.homedir ?? os.homedir);
  const stateSchema = repairOpenClawStateDatabaseSchema({
    env: { ...env, OPENCLAW_STATE_DIR: stateDir },
  });
  if (stateSchema.warnings.length > 0) {
    return {
      migrated: stateDirResult.migrated || stateSchema.changes.length > 0,
      skipped: false,
      changes: [...stateDirResult.changes, ...stateSchema.changes],
      warnings: [...stateDirResult.warnings, ...stateSchema.warnings],
      ...(stateDirResult.notices?.length ? { notices: stateDirResult.notices } : {}),
    };
  }
  const pluginDoctorConfig = params.pluginDoctorConfig ?? params.cfg;
  const pluginSessionStoreAgentIds = listPluginDoctorSessionStoreAgentIds({
    config: pluginDoctorConfig,
    env,
    pluginIds: collectRelevantDoctorPluginIds(pluginDoctorConfig),
  });
  // Capture ownership before orphan-key rewrites. Atomic replacement can split
  // a configured filesystem alias from the standard target pathname.
  const sessionStoreOwnership = resolveSessionStoreOwnership({
    cfg: params.cfg,
    env,
    stateDir,
    targetAgentId: normalizeAgentId(resolveDefaultAgentId(params.cfg)),
    pluginSessionStoreAgentIds,
  });
  // Canonicalize orphaned session keys regardless of whether legacy migration
  // is needed — the orphan-key bug (#29683) affects all installs with
  // non-default agent IDs or mainKey configuration.
  const orphanKeys = await migrateOrphanedSessionKeys({
    cfg: params.cfg,
    env,
    additionalAgentIds: pluginSessionStoreAgentIds,
  });
  const acpSessionMetadata = await migrateLegacyAcpSessionMetadata({
    cfg: params.cfg,
    env,
    now: params.now,
    pluginSessionStoreAgentIds,
  });

  const logMigrationResults = (changes: string[], warnings: string[], notices: string[]) => {
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
    if (notices.length > 0) {
      logger.info(
        `Legacy state migration notes:\n${notices.map((entry) => `- ${entry}`).join("\n")}`,
      );
    }
  };

  const detected = await detectLegacyStateMigrations({
    cfg: params.cfg,
    pluginDoctorConfig: params.pluginDoctorConfig,
    pluginSessionStoreAgentIds,
    sessionStoreOwnership,
    env,
    homedir: params.homedir,
    crossStateDirImports: params.crossStateDirImports,
  });
  const hasCustomAgentDir = env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim();
  if (hasCustomAgentDir) {
    const pluginStateSidecar = await migrateLegacyPluginStateSidecar({
      stateDir: detected.stateDir,
    });
    const pluginInstallIndex = await migrateLegacyInstalledPluginIndex({
      stateDir: detected.stateDir,
    });
    const debugProxyCaptureSidecar = migrateLegacyDebugProxyCaptureSidecar({
      stateDir: detected.stateDir,
      detected: detected.debugProxyCaptureSidecar,
    });
    const taskStateSidecars = await migrateLegacyTaskStateSidecars({
      stateDir: detected.stateDir,
    });
    const deliveryQueues = await migrateLegacyDeliveryQueues({
      stateDir: detected.stateDir,
    });
    const voiceWake = migrateLegacyVoiceWakeSettings({
      detected: detected.voiceWake,
      stateDir: detected.stateDir,
    });
    const updateCheck = migrateLegacyUpdateCheckState({
      detected: detected.updateCheck,
      stateDir: detected.stateDir,
    });
    const configHealth = migrateLegacyConfigHealth({
      detected: detected.configHealth,
      stateDir: detected.stateDir,
    });
    const pluginBindingApprovals = migrateLegacyPluginBindingApprovals({
      detected: detected.pluginBindingApprovals,
      stateDir: detected.stateDir,
    });
    const currentConversationBindings = migrateLegacyCurrentConversationBindings({
      detected: detected.currentConversationBindings,
      stateDir: detected.stateDir,
    });
    const execApprovals = migrateLegacyExecApprovals(detected.execApprovals);
    const preSessionChannelPlans = await runLegacyMigrationPlans(
      detected.channelPlans.plans.filter((plan) => plan.kind === "plugin-state-import"),
    );
    const pluginPlans = await runPluginDoctorStateMigrationPlans({
      detected,
      config: params.pluginDoctorConfig ?? params.cfg,
      env,
    });
    const changes = [
      ...stateDirResult.changes,
      ...stateSchema.changes,
      ...orphanKeys.changes,
      ...acpSessionMetadata.changes,
      ...pluginStateSidecar.changes,
      ...pluginInstallIndex.changes,
      ...debugProxyCaptureSidecar.changes,
      ...taskStateSidecars.changes,
      ...deliveryQueues.changes,
      ...voiceWake.changes,
      ...updateCheck.changes,
      ...configHealth.changes,
      ...pluginBindingApprovals.changes,
      ...currentConversationBindings.changes,
      ...execApprovals.changes,
      ...preSessionChannelPlans.changes,
      ...pluginPlans.changes,
    ];
    const warnings = [
      ...stateDirResult.warnings,
      ...stateSchema.warnings,
      ...detected.warnings,
      ...orphanKeys.warnings,
      ...acpSessionMetadata.warnings,
      ...pluginStateSidecar.warnings,
      ...pluginInstallIndex.warnings,
      ...debugProxyCaptureSidecar.warnings,
      ...taskStateSidecars.warnings,
      ...deliveryQueues.warnings,
      ...voiceWake.warnings,
      ...updateCheck.warnings,
      ...configHealth.warnings,
      ...pluginBindingApprovals.warnings,
      ...currentConversationBindings.warnings,
      ...execApprovals.warnings,
      ...preSessionChannelPlans.warnings,
      ...pluginPlans.warnings,
    ];
    const notices = [
      ...(stateDirResult.notices ?? []),
      ...detected.notices,
      ...(pluginPlans.notices ?? []),
    ];
    logMigrationResults(changes, warnings, notices);
    return {
      migrated:
        stateDirResult.migrated ||
        stateSchema.changes.length > 0 ||
        orphanKeys.changes.length > 0 ||
        acpSessionMetadata.changes.length > 0 ||
        pluginStateSidecar.changes.length > 0 ||
        pluginInstallIndex.changes.length > 0 ||
        debugProxyCaptureSidecar.changes.length > 0 ||
        taskStateSidecars.changes.length > 0 ||
        deliveryQueues.changes.length > 0 ||
        voiceWake.changes.length > 0 ||
        updateCheck.changes.length > 0 ||
        configHealth.changes.length > 0 ||
        pluginBindingApprovals.changes.length > 0 ||
        currentConversationBindings.changes.length > 0 ||
        execApprovals.changes.length > 0 ||
        preSessionChannelPlans.changes.length > 0 ||
        pluginPlans.changes.length > 0,
      skipped: true,
      changes,
      warnings,
      ...(notices.length > 0 ? { notices } : {}),
    };
  }
  if (
    !detected.sessions.hasLegacy &&
    !detected.agentDir.hasLegacy &&
    !detected.channelPlans.hasLegacy &&
    !detected.pluginPlans?.hasLegacy &&
    !detected.pluginStateSidecar.hasLegacy &&
    !detected.pluginInstallIndex.hasLegacy &&
    !detected.debugProxyCaptureSidecar.hasLegacy &&
    !detected.stateSchema.hasLegacy &&
    !detected.taskStateSidecars.hasLegacy &&
    !detected.deliveryQueues.hasLegacy &&
    !detected.voiceWake.hasLegacy &&
    !detected.updateCheck.hasLegacy &&
    !detected.configHealth.hasLegacy &&
    !detected.pluginBindingApprovals.hasLegacy &&
    !detected.currentConversationBindings.hasLegacy &&
    !detected.execApprovals.hasLegacy
  ) {
    const changes = [
      ...stateDirResult.changes,
      ...stateSchema.changes,
      ...orphanKeys.changes,
      ...acpSessionMetadata.changes,
    ];
    const warnings = [
      ...stateDirResult.warnings,
      ...stateSchema.warnings,
      ...detected.warnings,
      ...orphanKeys.warnings,
      ...acpSessionMetadata.warnings,
    ];
    const notices = [...(stateDirResult.notices ?? []), ...detected.notices];
    logMigrationResults(changes, warnings, notices);
    return {
      migrated:
        stateDirResult.migrated ||
        stateSchema.changes.length > 0 ||
        orphanKeys.changes.length > 0 ||
        acpSessionMetadata.changes.length > 0,
      skipped: false,
      changes,
      warnings,
      ...(notices.length > 0 ? { notices } : {}),
    };
  }

  const now = params.now ?? (() => Date.now());
  const pluginStateSidecar = await migrateLegacyPluginStateSidecar({
    stateDir: detected.stateDir,
  });
  const pluginInstallIndex = await migrateLegacyInstalledPluginIndex({
    stateDir: detected.stateDir,
  });
  const debugProxyCaptureSidecar = migrateLegacyDebugProxyCaptureSidecar({
    stateDir: detected.stateDir,
    detected: detected.debugProxyCaptureSidecar,
  });
  const taskStateSidecars = await migrateLegacyTaskStateSidecars({
    stateDir: detected.stateDir,
  });
  const deliveryQueues = await migrateLegacyDeliveryQueues({
    stateDir: detected.stateDir,
  });
  const voiceWake = migrateLegacyVoiceWakeSettings({
    detected: detected.voiceWake,
    stateDir: detected.stateDir,
  });
  const updateCheck = migrateLegacyUpdateCheckState({
    detected: detected.updateCheck,
    stateDir: detected.stateDir,
  });
  const configHealth = migrateLegacyConfigHealth({
    detected: detected.configHealth,
    stateDir: detected.stateDir,
  });
  const pluginBindingApprovals = migrateLegacyPluginBindingApprovals({
    detected: detected.pluginBindingApprovals,
    stateDir: detected.stateDir,
  });
  const currentConversationBindings = migrateLegacyCurrentConversationBindings({
    detected: detected.currentConversationBindings,
    stateDir: detected.stateDir,
  });
  const execApprovals = migrateLegacyExecApprovals(detected.execApprovals);
  const preSessionChannelPlans = await runLegacyMigrationPlans(
    detected.channelPlans.plans.filter((plan) => plan.kind === "plugin-state-import"),
  );
  const pluginPlans = await runPluginDoctorStateMigrationPlans({
    detected,
    config: params.pluginDoctorConfig ?? params.cfg,
    env,
  });
  const sessions = await migrateLegacySessions(detected, now, {
    recoverCorruptTargetStore: params.recoverCorruptTargetStore,
  });
  const postSessionAcpMetadata = await migrateLegacyAcpSessionMetadata({
    cfg: params.cfg,
    env,
    now,
    pluginSessionStoreAgentIds,
  });
  const agentDir = await migrateLegacyAgentDir(detected, now);
  const channelPlans = await runLegacyMigrationPlans(
    detected.channelPlans.plans.filter((plan) => plan.kind !== "plugin-state-import"),
  );
  const changes = [
    ...stateDirResult.changes,
    ...stateSchema.changes,
    ...orphanKeys.changes,
    ...acpSessionMetadata.changes,
    ...pluginStateSidecar.changes,
    ...pluginInstallIndex.changes,
    ...debugProxyCaptureSidecar.changes,
    ...taskStateSidecars.changes,
    ...deliveryQueues.changes,
    ...voiceWake.changes,
    ...updateCheck.changes,
    ...configHealth.changes,
    ...pluginBindingApprovals.changes,
    ...currentConversationBindings.changes,
    ...execApprovals.changes,
    ...preSessionChannelPlans.changes,
    ...pluginPlans.changes,
    ...sessions.changes,
    ...postSessionAcpMetadata.changes,
    ...agentDir.changes,
    ...channelPlans.changes,
  ];
  const warnings = [
    ...stateDirResult.warnings,
    ...stateSchema.warnings,
    ...detected.warnings,
    ...orphanKeys.warnings,
    ...acpSessionMetadata.warnings,
    ...pluginStateSidecar.warnings,
    ...pluginInstallIndex.warnings,
    ...debugProxyCaptureSidecar.warnings,
    ...taskStateSidecars.warnings,
    ...deliveryQueues.warnings,
    ...voiceWake.warnings,
    ...updateCheck.warnings,
    ...configHealth.warnings,
    ...pluginBindingApprovals.warnings,
    ...currentConversationBindings.warnings,
    ...execApprovals.warnings,
    ...preSessionChannelPlans.warnings,
    ...pluginPlans.warnings,
    ...sessions.warnings,
    ...postSessionAcpMetadata.warnings,
    ...agentDir.warnings,
    ...channelPlans.warnings,
  ];
  const notices = [
    ...(stateDirResult.notices ?? []),
    ...detected.notices,
    ...(pluginPlans.notices ?? []),
  ];

  logMigrationResults(changes, warnings, notices);

  return {
    migrated: changes.length > 0,
    skipped: false,
    changes,
    warnings,
    ...(notices.length > 0 ? { notices } : {}),
  };
}
