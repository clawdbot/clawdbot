import fs from "node:fs";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveRequiredHomeDir } from "./home-dir.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { normalizeConversationRef } from "./outbound/session-binding-normalization.js";
import type { SessionBindingRecord } from "./outbound/session-binding.types.js";
import { fileExists } from "./state-migrations.fs.js";
import { archiveLegacyImportSource } from "./state-migrations.storage.js";
import type { LegacyStateDetection } from "./state-migrations.types.js";
import { normalizeVoiceWakeRoutingConfig } from "./voicewake-routing.js";

type LegacyVoiceWakeImportDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "voicewake_routing_config" | "voicewake_routing_routes" | "voicewake_triggers"
>;
type LegacyConfigHealthImportDatabase = Pick<OpenClawStateKyselyDatabase, "config_health_entries">;
type LegacyPluginBindingApprovalsImportDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "plugin_binding_approvals"
>;
type LegacyCurrentConversationBindingsImportDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "current_conversation_bindings"
>;

const VOICEWAKE_CONFIG_KEY = "default";
const DEFAULT_VOICEWAKE_TRIGGERS = ["openclaw", "claude", "computer"];

export function resolveLegacyVoiceWakeTriggersPath(stateDir: string): string {
  return path.join(stateDir, "settings", "voicewake.json");
}

export function resolveLegacyVoiceWakeRoutingPath(stateDir: string): string {
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

export function migrateLegacyVoiceWakeSettings(params: {
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

type LegacyConfigHealthFile = {
  entries?: unknown;
};

type LegacyConfigHealthEntry = {
  configPath: string;
  lastKnownGoodJson: string | null;
  lastPromotedGoodJson: string | null;
  lastObservedSuspiciousSignature: string | null;
};

export function resolveLegacyConfigHealthPath(stateDir: string): string {
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

export function migrateLegacyConfigHealth(params: {
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

export function resolveLegacyPluginBindingApprovalsPath(
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

export function migrateLegacyPluginBindingApprovals(params: {
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

export function resolveLegacyCurrentConversationBindingsPath(stateDir: string): string {
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

export function migrateLegacyCurrentConversationBindings(params: {
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
