// Covers legacy state migration detection and repair behavior.
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readAcpSessionMetaForEntry } from "../acp/runtime/session-meta.js";
import { AgentSelectionRequiredError, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import * as channelRegistry from "../channels/plugins/registry.js";
import type { OpenClawConfig } from "../config/config.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { readExactSessionEntryRowForCanonicalRepair } from "../config/sessions/session-accessor.sqlite-canonical-repair.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { readMemoryHostEventRecords } from "../memory-host-sdk/events.js";
import { loadNodeHostConfig } from "../node-host/config.js";
import { readChannelPairingStateSnapshot } from "../pairing/pairing-store-sqlite.test-helpers.js";
import { definePluginDoctorMigrationFromPlans } from "../plugin-sdk/runtime-doctor-migrations.js";
import type {
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationContext,
} from "../plugins/doctor-contract-module.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { proposeCreateSkill } from "../skills/workshop/service.js";
import { readConfigMachineState, writeConfigMachineState } from "../state/config-machine-state.js";
import { listOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  ensureOpenClawAgentDatabaseSchema,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { loadApnsRegistration } from "./push-apns.js";
import {
  createWebPushVapidKeyPair,
  hashWebPushEndpoint,
  listWebPushSubscriptions,
  readPersistedVapidKeyPair,
} from "./push-web-store.js";
import { readRestartSentinel } from "./restart-sentinel.js";
import { acquireStartupMigrationLease } from "./startup-migration-checkpoint.js";
import {
  autoMigrateLegacyState as autoMigrateLegacyStateWithSurfaces,
  detectLegacyStateMigrations as detectLegacyStateMigrationsWithSurfaces,
  runLegacyStateMigrations as runLegacyStateMigrationsWithSurfaces,
} from "./state-migrations.doctor.js";
import * as sessionStore from "./state-migrations.legacy-session-store.js";
import { autoMigrateLegacyPluginDoctorState } from "./state-migrations.plugin-doctor.js";
import {
  migrateLegacyCurrentConversationBindings,
  migrateLegacyPluginBindingApprovals,
} from "./state-migrations.runtime-state.js";
import {
  resetAutoMigrateLegacyStateDirForTest,
  resetAutoMigrateLegacyTaskStateSidecarsForTest,
} from "./state-migrations.state-dir.js";
import { loadVoiceWakeRoutingConfig } from "./voicewake-routing.js";
import { loadVoiceWakeConfig, setVoiceWakeTriggers } from "./voicewake.js";

type DetectLegacyStateParams = Parameters<typeof detectLegacyStateMigrationsWithSurfaces>[0];
type RunLegacyStateParams = Parameters<typeof runLegacyStateMigrationsWithSurfaces>[0];
type AutoMigrateLegacyStateParams = Parameters<typeof autoMigrateLegacyStateWithSurfaces>[0];

// This broad core suite intentionally exercises migration mechanics without plugin-owned keys.
// Package-shaped coverage owns configured plugin resolution and setup-sidecar loading.
function detectLegacyStateMigrations(
  params: Omit<DetectLegacyStateParams, "legacySessionSurfaces"> & {
    legacySessionSurfaces?: DetectLegacyStateParams["legacySessionSurfaces"];
  },
) {
  return detectLegacyStateMigrationsWithSurfaces({
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    ...params,
  });
}

function runLegacyStateMigrations(
  params: Omit<RunLegacyStateParams, "legacySessionSurfaces"> & {
    legacySessionSurfaces?: RunLegacyStateParams["legacySessionSurfaces"];
  },
) {
  return runLegacyStateMigrationsWithSurfaces({
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    ...params,
  });
}

function autoMigrateLegacyState(
  params: Omit<AutoMigrateLegacyStateParams, "legacySessionSurfaces"> & {
    legacySessionSurfaces?: AutoMigrateLegacyStateParams["legacySessionSurfaces"];
  },
) {
  return autoMigrateLegacyStateWithSurfaces({
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    ...params,
  });
}

// Static helpers can retain earlier cohorts after resetModules; close every cohort at teardown.
const migrationDatabaseClosers = new Set([
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
]);

function closeMigrationDatabases() {
  for (const close of migrationDatabaseClosers) {
    close();
  }
}

async function rerunAutomaticMigrationAfterRestart(params: AutoMigrateLegacyStateParams) {
  closeMigrationDatabases();
  vi.resetModules();
  const [agentDb, stateDb] = await Promise.all([
    import("../state/openclaw-agent-db.js"),
    import("../state/openclaw-state-db.js"),
  ]);
  migrationDatabaseClosers.add(agentDb.closeOpenClawAgentDatabasesForTest);
  migrationDatabaseClosers.add(stateDb.closeOpenClawStateDatabaseForTest);
  try {
    const migrationOwner = await import("./state-migrations.doctor.js");
    return await migrationOwner.autoMigrateLegacyState({
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      ...params,
    });
  } finally {
    closeMigrationDatabases();
    expect(agentDb.listOpenClawAgentDatabasesForTest()).toEqual([]);
    expect(stateDb.isOpenClawStateDatabaseOpen()).toBe(false);
  }
}

const pluginDoctorStateMigrationEntries = vi.hoisted(
  () =>
    ({
      entries: [] as Array<{
        pluginId: string;
        channelIds?: string[];
        trustedForDurableStores?: boolean;
        migration: {
          id: string;
          label: string;
          doctorOnly?: boolean;
          phase?: "after-session-repair";
          detectLegacyState: (params: {
            config: OpenClawConfig;
            env: NodeJS.ProcessEnv;
            stateDir: string;
            oauthDir: string;
            context: PluginDoctorStateMigrationContext;
          }) => Promise<{ preview: string[] } | null> | { preview: string[] } | null;
          migrateLegacyState: (params: {
            config: OpenClawConfig;
            env: NodeJS.ProcessEnv;
            stateDir: string;
            oauthDir: string;
            context: PluginDoctorStateMigrationContext;
          }) =>
            | Promise<{ changes: string[]; warnings: string[] }>
            | {
                changes: string[];
                warnings: string[];
              };
        };
      }>,
    }) satisfies {
      entries: Array<{
        pluginId: string;
        channelIds?: string[];
        trustedForDurableStores?: boolean;
        migration: {
          id: string;
          label: string;
          detectLegacyState: (params: {
            config: OpenClawConfig;
            env: NodeJS.ProcessEnv;
            stateDir: string;
            oauthDir: string;
            context: PluginDoctorStateMigrationContext;
          }) => Promise<{ preview: string[] } | null> | { preview: string[] } | null;
          migrateLegacyState: (params: {
            config: OpenClawConfig;
            env: NodeJS.ProcessEnv;
            stateDir: string;
            oauthDir: string;
            context: PluginDoctorStateMigrationContext;
          }) =>
            | Promise<{ changes: string[]; warnings: string[] }>
            | {
                changes: string[];
                warnings: string[];
              };
        };
      }>;
    },
);

const legacyChannelStateMigrationEntries = vi.hoisted(() => ({
  entries: [] as Array<{ pluginId: string; migration: PluginDoctorStateMigration }>,
}));

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  return {
    ...actual,
    listPluginDoctorStateMigrationEntries: vi.fn(() => [
      ...pluginDoctorStateMigrationEntries.entries,
      ...legacyChannelStateMigrationEntries.entries,
    ]),
  };
});

const tempDirs = createTrackedTempDirs();
const APNS_DEVICE_FIELD = "token";

type ConfigHealthDatabase = Pick<OpenClawStateKyselyDatabase, "config_health_entries">;
type PluginBindingApprovalsDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_binding_approvals">;
type CurrentConversationBindingsDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "current_conversation_bindings"
>;

async function expectMissingPath(targetPath: string): Promise<void> {
  let statError: NodeJS.ErrnoException | undefined;
  try {
    await fs.stat(targetPath);
  } catch (error) {
    statError = error as NodeJS.ErrnoException;
  }
  expect(statError).toBeInstanceOf(Error);
  expect(statError?.code).toBe("ENOENT");
  expect(statError?.path).toBe(targetPath);
  expect(statError?.syscall).toBe("stat");
}

function failArchiveRenameOnce(sourcePath: string) {
  const actualRenameSync = fsSync.renameSync.bind(fsSync);
  let failed = false;
  return vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
    if (!failed && String(from) === sourcePath) {
      failed = true;
      throw new Error("forced archive failure");
    }
    actualRenameSync(from, to);
  });
}

legacyChannelStateMigrationEntries.entries = [
  {
    pluginId: "mobileauth",
    migration: definePluginDoctorMigrationFromPlans({
      id: "mobileauth-legacy-state",
      label: "MobileAuth legacy state",
      resolvePlans: ({ oauthDir }) => {
        let entries: fsSync.Dirent[];
        try {
          entries = fsSync.readdirSync(oauthDir, { withFileTypes: true });
        } catch {
          return [];
        }
        return entries.flatMap((entry) => {
          if (!entry.isFile() || !/^(creds|pre-key-1)\.json$/u.test(entry.name)) {
            return [];
          }
          const sourcePath = path.join(oauthDir, entry.name);
          const targetPath = path.join(oauthDir, "mobileauth", "default", entry.name);
          return fsSync.existsSync(targetPath)
            ? []
            : [
                {
                  kind: "move" as const,
                  label: `MobileAuth auth ${entry.name}`,
                  sourcePath,
                  targetPath,
                },
              ];
        });
      },
    }),
  },
];

function failNextStateDbCommit(env: NodeJS.ProcessEnv) {
  const { db } = openOpenClawStateDatabase({ env });
  const actualExec = db.exec.bind(db);
  let failed = false;
  return vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (!failed && sql.trim() === "COMMIT") {
      failed = true;
      throw new Error("forced commit failure");
    }
    actualExec(sql);
  });
}

const createTempDir = () => tempDirs.make("openclaw-state-migrations-test-");

function readUpdateCheckState(env: NodeJS.ProcessEnv):
  | {
      lastCheckedAt?: string;
      lastAvailableVersion?: string;
      lastAvailableTag?: string;
      autoInstallId?: string;
    }
  | undefined {
  return readConfigMachineState("update.checkState", { env });
}

function readConfigHealthRows(env: NodeJS.ProcessEnv): Array<{
  config_path: string;
  last_known_good_json: string | null;
  last_promoted_good_json: string | null;
  last_observed_suspicious_signature: string | null;
}> {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<ConfigHealthDatabase>(db);
  return executeSqliteQuerySync(
    db,
    stateDb
      .selectFrom("config_health_entries")
      .select([
        "config_path",
        "last_known_good_json",
        "last_promoted_good_json",
        "last_observed_suspicious_signature",
      ])
      .orderBy("config_path", "asc"),
  ).rows;
}

function insertConfigHealthRow(
  env: NodeJS.ProcessEnv,
  row: {
    config_path: string;
    last_known_good_json: string | null;
    last_promoted_good_json: string | null;
    last_observed_suspicious_signature: string | null;
  },
): void {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<ConfigHealthDatabase>(db);
  executeSqliteQuerySync(
    db,
    stateDb.insertInto("config_health_entries").values({
      ...row,
      updated_at_ms: Date.now(),
    }),
  );
}

function readCurrentConversationBindingRows(env: NodeJS.ProcessEnv): Array<{
  binding_key: string;
  binding_id: string;
  target_session_key: string;
  channel: string;
  account_id: string;
  conversation_id: string;
  record_json: string;
}> {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<CurrentConversationBindingsDatabase>(db);
  return executeSqliteQuerySync(
    db,
    stateDb
      .selectFrom("current_conversation_bindings")
      .select([
        "binding_key",
        "binding_id",
        "target_session_key",
        "channel",
        "account_id",
        "conversation_id",
        "record_json",
      ])
      .orderBy("binding_id", "asc"),
  ).rows;
}

function readPluginBindingApprovalRows(env: NodeJS.ProcessEnv): Array<{
  plugin_root: string;
  channel: string;
  account_id: string;
  plugin_id: string;
  plugin_name: string | null;
  approved_at: number;
}> {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<PluginBindingApprovalsDatabase>(db);
  return executeSqliteQuerySync(
    db,
    stateDb
      .selectFrom("plugin_binding_approvals")
      .select(["plugin_root", "channel", "account_id", "plugin_id", "plugin_name", "approved_at"])
      .orderBy("plugin_root", "asc"),
  ).rows;
}

function insertPluginBindingApprovalRow(
  env: NodeJS.ProcessEnv,
  row: {
    plugin_root: string;
    channel: string;
    account_id: string;
    plugin_id: string;
    plugin_name: string | null;
    approved_at: number;
  },
): void {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<PluginBindingApprovalsDatabase>(db);
  executeSqliteQuerySync(db, stateDb.insertInto("plugin_binding_approvals").values(row));
}

function insertCurrentConversationBindingRow(
  env: NodeJS.ProcessEnv,
  params: {
    bindingKey: string;
    bindingId: string;
    targetSessionKey: string;
    channel: string;
    accountId: string;
    conversationId: string;
    recordJson: string;
  },
): void {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<CurrentConversationBindingsDatabase>(db);
  executeSqliteQuerySync(
    db,
    stateDb.insertInto("current_conversation_bindings").values({
      binding_key: params.bindingKey,
      binding_id: params.bindingId,
      target_session_key: params.targetSessionKey,
      channel: params.channel,
      account_id: params.accountId,
      conversation_kind: "current",
      parent_conversation_id: null,
      conversation_id: params.conversationId,
      target_kind: "session",
      status: "active",
      bound_at: 1,
      expires_at: null,
      metadata_json: null,
      record_json: params.recordJson,
      updated_at: 1,
    }),
  );
}

function createConfig(): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "worker-1", default: true }],
    },
    session: {
      mainKey: "desk",
    },
    channels: {
      chatapp: {
        defaultAccount: "alpha",
        accounts: {
          beta: {},
          alpha: {},
        },
      },
    },
  } as OpenClawConfig;
}

function createEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: path.dirname(stateDir),
    OPENCLAW_STATE_DIR: stateDir,
  };
}

function seedSchemaOnlyLegacyAgentDatabase(
  stateDir: string,
  options: { agentId?: string | null } = {},
): string {
  const databasePath = path.join(stateDir, "agent", "openclaw-agent.sqlite");
  fsSync.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    ensureOpenClawAgentDatabaseSchema(database, {
      agentId: "openclaw",
      env: createEnv(stateDir),
      path: databasePath,
      register: false,
    });
    if (options.agentId !== undefined) {
      database
        .prepare("UPDATE schema_meta SET agent_id = ? WHERE meta_key = 'primary'")
        .run(options.agentId);
    }
  } finally {
    database.close();
  }
  return databasePath;
}

function seedCanonicalVoiceWakeRouting(stateDir: string, trigger: string): void {
  writeConfigMachineState(
    "voicewake.routing",
    {
      version: 1,
      defaultTarget: { mode: "current" },
      routes: [{ trigger, target: { agentId: "main" } }],
      updatedAtMs: Date.now(),
    },
    { env: createEnv(stateDir) },
  );
}

type MixedCommitFailureFixture = {
  env: NodeJS.ProcessEnv;
  expectedWarning: string;
  migrate: () => { notices?: string[]; warnings: string[] };
  readRowCount: () => number;
  sourceFragment: string;
  sourcePath: string;
};

async function createMixedPluginBindingCommitFailureFixture(): Promise<MixedCommitFailureFixture> {
  const root = await createTempDir();
  const stateDir = path.join(root, ".openclaw");
  const env = createEnv(stateDir);
  const sourcePath = path.join(stateDir, "plugin-binding-approvals.json");
  insertPluginBindingApprovalRow(env, {
    plugin_root: "/plugins/conflict",
    channel: "discord",
    account_id: "default",
    plugin_id: "sqlite-plugin",
    plugin_name: "SQLite Plugin",
    approved_at: 1,
  });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    sourcePath,
    JSON.stringify({
      version: 1,
      approvals: [
        {
          pluginRoot: "/plugins/conflict",
          pluginId: "legacy-plugin",
          pluginName: "Legacy Plugin",
          channel: "discord",
          accountId: "default",
          approvedAt: 2,
        },
        {
          pluginRoot: "/plugins/import",
          pluginId: "imported-plugin",
          pluginName: "Imported Plugin",
          channel: "telegram",
          accountId: "default",
          approvedAt: 3,
        },
      ],
    }),
    "utf8",
  );
  return {
    env,
    expectedWarning:
      "Failed migrating legacy plugin binding approvals: Error: forced commit failure",
    migrate: () =>
      migrateLegacyPluginBindingApprovals({
        detected: { sourcePath, hasLegacy: true },
        stateDir,
      }),
    readRowCount: () => readPluginBindingApprovalRows(env).length,
    sourceFragment: "Imported Plugin",
    sourcePath,
  };
}

async function createMixedCurrentConversationCommitFailureFixture(): Promise<MixedCommitFailureFixture> {
  const root = await createTempDir();
  const stateDir = path.join(root, ".openclaw");
  const env = createEnv(stateDir);
  const bindingsDir = path.join(stateDir, "bindings");
  const sourcePath = path.join(bindingsDir, "current-conversations.json");
  const conflictingKey = "workspace\u241fdefault\u241f\u241fuser:U123";
  insertCurrentConversationBindingRow(env, {
    bindingKey: conflictingKey,
    bindingId: `generic:${conflictingKey}`,
    targetSessionKey: "agent:codex:acp:existing",
    channel: "workspace",
    accountId: "default",
    conversationId: "user:U123",
    recordJson: JSON.stringify({
      bindingId: `generic:${conflictingKey}`,
      targetSessionKey: "agent:codex:acp:existing",
      targetKind: "session",
      conversation: {
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
      },
      status: "active",
      boundAt: 1,
    }),
  });
  await fs.mkdir(bindingsDir, { recursive: true });
  await fs.writeFile(
    sourcePath,
    JSON.stringify({
      version: 1,
      bindings: [
        {
          targetSessionKey: "agent:codex:acp:legacy-conflict",
          conversation: {
            channel: "workspace",
            accountId: "default",
            conversationId: "user:U123",
          },
          boundAt: 2,
        },
        {
          targetSessionKey: "agent:codex:acp:legacy-missing",
          conversation: {
            channel: "workspace",
            accountId: "default",
            conversationId: "user:U456",
          },
          boundAt: 3,
        },
      ],
    }),
    "utf8",
  );
  return {
    env,
    expectedWarning:
      "Failed migrating legacy current-conversation bindings: Error: forced commit failure",
    migrate: () =>
      migrateLegacyCurrentConversationBindings({
        detected: { sourcePath, hasLegacy: true },
        stateDir,
      }),
    readRowCount: () => readCurrentConversationBindingRows(env).length,
    sourceFragment: "legacy-missing",
    sourcePath,
  };
}

async function createLegacyAuditLedger(stateDir: string): Promise<string> {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL UNIQUE,
        source_sequence INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_key TEXT,
        session_id TEXT,
        run_id TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT
      );
      INSERT INTO audit_events (
        sequence,
        event_id,
        source_id,
        source_sequence,
        occurred_at,
        kind,
        action,
        status,
        actor_type,
        actor_id,
        agent_id,
        run_id
      ) VALUES (
        3,
        'event-before-v2',
        'run-before-v2:1:100:agent.run.started',
        1,
        100,
        'agent_run',
        'agent.run.started',
        'started',
        'agent',
        'main',
        'main',
        'run-before-v2'
      );
    `);
  } finally {
    db.close();
  }
  return databasePath;
}

async function createLegacyStateFixture(params?: { includePreKey?: boolean }) {
  const root = await createTempDir();
  const stateDir = path.join(root, ".openclaw");
  const env = createEnv(stateDir);
  const cfg = createConfig();

  await fs.mkdir(path.join(stateDir, "sessions"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "agents", "worker-1", "sessions"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "agent"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true });

  await fs.writeFile(
    path.join(stateDir, "sessions", "sessions.json"),
    `${JSON.stringify({ legacyDirect: { sessionId: "legacy-direct", updatedAt: 10 } }, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(stateDir, "sessions", "trace.jsonl"), "{}\n", "utf8");
  await fs.writeFile(
    path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json"),
    `${JSON.stringify(
      {
        "group:mobile-room": { sessionId: "group-session", updatedAt: 5 },
        "group:legacy-room": { sessionId: "generic-group-session", updatedAt: 4 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(stateDir, "agent", "settings.json"), '{"ok":true}\n', "utf8");
  await fs.writeFile(path.join(stateDir, "credentials", "creds.json"), '{"auth":true}\n', "utf8");
  if (params?.includePreKey) {
    await fs.writeFile(
      path.join(stateDir, "credentials", "pre-key-1.json"),
      '{"preKey":true}\n',
      "utf8",
    );
  }
  await fs.writeFile(path.join(stateDir, "credentials", "oauth.json"), '{"oauth":true}\n', "utf8");
  await fs.writeFile(
    path.join(stateDir, "credentials", "chatapp-allowFrom.json"),
    '["123","456"]\n',
    "utf8",
  );

  return {
    root,
    stateDir,
    env,
    cfg,
  };
}

afterEach(() => {
  vi.useRealTimers();
  pluginDoctorStateMigrationEntries.entries = [];
  resetAutoMigrateLegacyTaskStateSidecarsForTest();
  resetAutoMigrateLegacyStateDirForTest();
  closeMigrationDatabases();
  resetPluginRuntimeStateForTest();
});

afterAll(async () => {
  await tempDirs.cleanup();
});

describe("state migrations", () => {
  let detectionCase: Awaited<ReturnType<typeof detectLegacyStateMigrations>> & {
    stateDir: string;
    env: NodeJS.ProcessEnv;
  };

  beforeAll(async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    detectionCase = { ...detected, stateDir, env };
  });

  describe.each(["automatic", "doctor"] as const)("%s pairing detection", (mode) => {
    it.each(["missing", "empty", "irrelevant", "pairing-only"])(
      "does not request channel runtime for %s credentials",
      async (input) => {
        const root = await createTempDir();
        const stateDir = path.join(root, ".openclaw");
        const sourceDir = path.join(stateDir, "credentials");
        if (input !== "missing") {
          await fs.mkdir(sourceDir, { recursive: true });
        }
        if (input === "irrelevant") {
          await fs.writeFile(path.join(sourceDir, "oauth.json"), "{}");
          await fs.mkdir(path.join(sourceDir, "chatapp-allowFrom.json"));
        }
        if (input === "pairing-only") {
          await fs.writeFile(path.join(sourceDir, "chatapp-pairing.json"), '{"requests":[]}');
        }
        const getChannelPlugin = vi.spyOn(channelRegistry, "getChannelPlugin");
        try {
          const detected = await detectLegacyStateMigrations({
            cfg: createConfig(),
            mode,
            env: createEnv(stateDir),
            homedir: () => root,
          });
          expect(detected.channelPairing.files).toEqual(
            input === "pairing-only" ? ["chatapp-pairing.json"] : [],
          );
          expect(getChannelPlugin).not.toHaveBeenCalled();
        } finally {
          getChannelPlugin.mockRestore();
        }
      },
    );
  });

  it("does not treat wildcard route bindings as pairing account ids", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    cfg.bindings = [
      {
        agentId: "worker-1",
        match: { channel: "chatapp", accountId: "*" },
      },
    ];
    const credentialsDir = path.join(stateDir, "credentials");
    await fs.mkdir(credentialsDir, { recursive: true });
    await fs.writeFile(
      path.join(credentialsDir, "chatapp-allowFrom.json"),
      '["default-user"]\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(credentialsDir, "chatapp-alpha-allowFrom.json"),
      '["scoped-user"]\n',
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({ detected, config: cfg, now: () => 1234 });

    expect(result.warnings).toEqual([]);
    expect(readChannelPairingStateSnapshot("chatapp", env).allowFrom).toEqual({
      alpha: ["default-user", "scoped-user"],
    });
    await expectMissingPath(path.join(credentialsDir, "chatapp-allowFrom.json"));
    await expectMissingPath(path.join(credentialsDir, "chatapp-alpha-allowFrom.json"));
  });

  it("uses the retained migration owner for channel pairing account selection", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = retainLegacyDefaultAgentId(
      {
        agents: {
          ownership: "explicit",
          defaults: { pdfMaxPages: 42 },
          entries: { main: { name: "Main" }, ops: { name: "Ops" } },
        },
        channels: { chatapp: {} },
      },
      "main",
    );
    const credentialsDir = path.join(stateDir, "credentials");
    await fs.mkdir(credentialsDir, { recursive: true });
    await fs.writeFile(
      path.join(credentialsDir, "chatapp-allowFrom.json"),
      '["123456789"]\n',
      "utf8",
    );
    const plugin = createChannelTestPluginBase({
      id: "chatapp",
      config: {
        defaultAccountId: (config) => {
          const ownerAgentId = resolveDefaultAgentId(config);
          const owner = config.agents?.entries?.[ownerAgentId];
          return owner?.name === "Main" && config.agents?.defaults?.pdfMaxPages === 42
            ? "default"
            : "lost-owner-config";
        },
      },
    });
    setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]));

    const authoredConfig = structuredClone(cfg);
    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    expect(cfg).toEqual(authoredConfig);
    const result = await runLegacyStateMigrations({ detected, config: cfg, env });

    expect(result.warnings).toEqual([]);
    expect(readChannelPairingStateSnapshot("chatapp", env).allowFrom).toEqual({
      default: ["123456789"],
    });
  });

  it.each([
    { bound: "Bound.Acct", explicit: "alpha", expected: "bound.acct", entries: ["unscoped"] },
    { bound: undefined, explicit: "alpha", expected: "alpha", entries: ["unscoped", "scoped"] },
    { bound: undefined, explicit: undefined, expected: "plugin.default", entries: ["unscoped"] },
  ])("preserves loaded plugin accounts with $expected as the default", async (selection) => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    cfg.channels = {
      chatapp: { accounts: { beta: {}, alpha: {} }, defaultAccount: selection.explicit },
    };
    if (selection.bound) {
      cfg.bindings = [
        { agentId: "worker-1", match: { channel: "chatapp", accountId: selection.bound } },
      ];
    }
    const plugin = createChannelTestPluginBase({
      id: "chatapp",
      config: {
        listAccountIds: (config) => {
          expect(config).toBe(cfg);
          return ["Plugin.Acct"];
        },
        defaultAccountId: () => "Plugin.Default",
      },
    });
    setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]));
    const sourceDir = path.join(stateDir, "credentials");
    await fs.mkdir(sourceDir, { recursive: true });
    for (const suffix of ["", "-plugin.acct", "-alpha", "-beta"]) {
      await fs.writeFile(
        path.join(sourceDir, `chatapp${suffix}-allowFrom.json`),
        suffix ? '["scoped"]' : '["unscoped"]',
      );
    }
    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    // Import uses captured detection facts even if the caller replaces its config later.
    const result = await runLegacyStateMigrations({ detected, config: {}, env });

    expect(result.warnings).toEqual([]);
    expect(readChannelPairingStateSnapshot("chatapp", env).allowFrom).toEqual({
      "plugin.acct": ["scoped"],
      alpha: ["scoped"],
      beta: ["scoped"],
      [selection.expected]: selection.entries,
    });
    expect(await fs.readdir(sourceDir)).toEqual([]);
  });

  it("preserves ambiguous pairing ownership when only the session fallback exists", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
      channels: { chatapp: {} },
    };
    const credentialsDir = path.join(stateDir, "credentials");
    await fs.mkdir(credentialsDir, { recursive: true });
    await fs.writeFile(
      path.join(credentialsDir, "chatapp-allowFrom.json"),
      '["123456789"]\n',
      "utf8",
    );
    const plugin = createChannelTestPluginBase({
      id: "chatapp",
      config: { defaultAccountId: (config) => resolveDefaultAgentId(config) },
    });
    setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]));

    await expect(
      detectLegacyStateMigrations({ cfg, env, homedir: () => root }),
    ).rejects.toBeInstanceOf(AgentSelectionRequiredError);
  });

  it.each(["present", "absent", "present with a retained bundle"] as const)(
    "keeps automatic migration read-only with a current schema and Workshop tables %s",
    async (workshopTables) => {
      const root = await createTempDir();
      const stateDir = path.join(root, ".openclaw");
      const env = createEnv(stateDir);
      const cfg = createConfig();
      cfg.agents = { list: [{ id: "main" }] };
      const databasePath = openOpenClawStateDatabase({ env }).path;
      let bundle: { path: string; content: string } | undefined;
      if (workshopTables === "present with a retained bundle") {
        const proposal = await proposeCreateSkill({
          workspaceDir: path.join(root, "workspace"),
          config: cfg,
          agentId: "main",
          env,
          name: "retained-procedure",
          description: "Keep a current proposal through no-op migration",
          content: "# Retained procedure\n\nKeep this modern draft intact.\n",
        });
        const proposalDir = path.join(stateDir, "skill-workshop", "proposals", proposal.record.id);
        bundle = {
          path: path.join(proposalDir, proposal.record.draftFile),
          content: proposal.content,
        };
        await expect(fs.access(path.join(proposalDir, "proposal.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      closeOpenClawStateDatabaseForTest();

      const writer = new DatabaseSync(databasePath);
      if (workshopTables === "absent") {
        writer.exec(`
        DROP TABLE skill_workshop_proposal_events;
        DROP TABLE skill_workshop_proposal_rollbacks;
        DROP TABLE skill_workshop_collection_reviews;
        DROP TABLE skill_workshop_proposals;
      `);
      }
      writer.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
      try {
        await expect(
          autoMigrateLegacyState({ cfg, env, homedir: () => root }),
        ).resolves.toMatchObject({ changes: [], warnings: [] });
        if (bundle) {
          await expect(fs.readFile(bundle.path, "utf8")).resolves.toBe(bundle.content);
        }
      } finally {
        writer.exec("ROLLBACK;");
        writer.close();
      }
    },
  );

  it("runs legacy-main session migration when the other automatic detectors are empty", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    runOpenClawAgentWriteTransaction(
      (database) => {
        writeSessionEntry(
          database,
          "agent:main:chat",
          { sessionId: "legacy-main-session", updatedAt: 100 },
          { allowStoredAliases: true, previousEntry: null },
        );
      },
      { agentId: "main", env },
    );

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });
    const source = runOpenClawAgentWriteTransaction(
      (database) => readExactSessionEntryRowForCanonicalRepair(database, "agent:main:chat"),
      { agentId: "main", env },
    );
    const destination = runOpenClawAgentWriteTransaction(
      (database) => readExactSessionEntryRowForCanonicalRepair(database, "agent:worker-1:chat"),
      { agentId: "worker-1", env },
    );

    expect(result.changes).toContain("Migrated legacy main session claim agent:worker-1:chat.");
    expect(source).toBeUndefined();
    expect(destination?.entry.sessionId).toBe("legacy-main-session");
  });

  it.each([
    { location: "inside", doctorOnlyStateMigrations: false },
    { location: "outside", doctorOnlyStateMigrations: false },
    { location: "inside", doctorOnlyStateMigrations: true },
    { location: "outside", doctorOnlyStateMigrations: true },
  ])(
    "preserves the retired physical owner of a shared store $location state (Doctor: $doctorOnlyStateMigrations)",
    async ({ location, doctorOnlyStateMigrations }) => {
      const root = fsSync.realpathSync.native(await createTempDir());
      const stateDir = path.join(root, ".openclaw");
      const env = createEnv(stateDir);
      const storePath = path.join(location === "inside" ? stateDir : root, "shared.sqlite");
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { qa: {} } },
        session: { store: storePath },
      };
      const scope = {
        agentId: "qa",
        defaultAgentId: "main",
        env,
        sessionKey: "agent:qa:proof",
        storePath,
      };
      await upsertSessionEntryCore(scope, { sessionId: "qa-source", updatedAt: 1000 });
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const originalEntry = loadSessionEntryReadOnly(scope);
      expect(originalEntry).toMatchObject({
        sessionId: "qa-source",
        updatedAt: expect.any(Number),
      });

      const readFile = vi.spyOn(fsSync, "readFileSync");
      try {
        const result = await autoMigrateLegacyState({
          cfg,
          env,
          homedir: () => root,
          doctorOnlyStateMigrations,
        });
        expect(result.warnings).toEqual([]);
        expect(readFile.mock.calls.map(([pathname]) => pathname)).not.toContain(storePath);
      } finally {
        readFile.mockRestore();
      }
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([
        expect.objectContaining({ agentId: "main", path: storePath }),
      ]);
      expect(loadSessionEntryReadOnly(scope)).toStrictEqual(originalEntry);
      const database = new DatabaseSync(storePath, { readOnly: true });
      try {
        expect(
          database
            .prepare("SELECT agent_id, app_version FROM schema_meta WHERE meta_key = ?")
            .get("historical-transcript-directives-v1"),
        ).toEqual({ agent_id: "main", app_version: JSON.stringify({ phase: "complete" }) });
        expect(
          database.prepare("SELECT session_key FROM session_nodes ORDER BY session_key").all(),
        ).toEqual([{ session_key: "agent:qa:proof" }]);
      } finally {
        database.close();
      }
    },
  );

  it("reports unresolved legacy-main ownership as a nonblocking automatic notice", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
    };
    runOpenClawAgentWriteTransaction(
      (database) =>
        writeSessionEntry(
          database,
          "agent:main:chat",
          { sessionId: "legacy-main-session", updatedAt: 100 },
          { allowStoredAliases: true, previousEntry: null },
        ),
      { agentId: "main", env },
    );

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

    expect(result.warnings).toEqual([]);
    expect(result.notices).toEqual([
      expect.stringContaining("legacy main rows have no unambiguous configured owner"),
    ]);
  });

  it("starts a new explicit-ownership fleet without a legacy-main owner notice", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
    };

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

    expect(result.warnings).toEqual([]);
    expect(result.notices ?? []).not.toContainEqual(
      expect.stringContaining("legacy main rows have no unambiguous configured owner"),
    );
  });

  it("preserves retired config locators before an advisory transcript migration return", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const databasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    fsSync.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
      ensureOpenClawAgentDatabaseSchema(database, {
        agentId: "main",
        env,
        path: databasePath,
        register: false,
      });
      database
        .prepare(
          "INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,app_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run("historical-transcript-directives-v1", "agent", 1, "main", "invalid-json", 1, 1);
    } finally {
      database.close();
    }
    const store = path.join(root, "legacy-jobs.json");
    const cfg: OpenClawConfig & { cron: { store: string } } = {
      agents: { ownership: "explicit", entries: { main: {} } },
      cron: { store },
    };
    const result = await autoMigrateLegacyState({ cfg, env });
    expect(result.warnings).toContainEqual(
      expect.stringContaining("invalid historical transcript migration cursor"),
    );
    expect(readConfigMachineState("cron.store", { env })).toBe(store);
    expect(result.changes).toContain("Migrated cron.store → shared SQLite state");
  });

  it("ignores a schema-only legacy agent database without selecting an owner", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, blocker: {}, digest: {} } },
    };
    const databasePath = seedSchemaOnlyLegacyAgentDatabase(stateDir);

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

    expect(result.warnings).toEqual([]);
    expect(result.notices ?? []).not.toContain(
      "Deferred legacy agent/session migration: select an agent owner",
    );
    expect(fsSync.existsSync(databasePath)).toBe(true);
    expect(fsSync.existsSync(path.join(stateDir, "agents", "main", "agent"))).toBe(false);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM session_nodes").get()).toEqual({
        count: 0,
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM auth_profile_store").get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  });

  it.each([null, "", "   "])(
    "preserves a schema-only legacy agent database with invalid owner %j as advisory",
    async (agentId) => {
      const root = await createTempDir();
      const stateDir = path.join(root, ".openclaw");
      const env = createEnv(stateDir);
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {}, blocker: {}, digest: {} } },
      };
      const databasePath = seedSchemaOnlyLegacyAgentDatabase(stateDir, { agentId });

      const automatic = await autoMigrateLegacyState({ cfg, env, homedir: () => root });
      expect(automatic.warnings).toContainEqual(
        expect.stringContaining("agent schema owner is missing or blank"),
      );
      expect(fsSync.existsSync(databasePath)).toBe(true);
      expect(fsSync.existsSync(path.join(stateDir, "agents", "main", "agent"))).toBe(false);

      const doctor = await autoMigrateLegacyState({
        cfg,
        env,
        homedir: () => root,
        doctorOnlyStateMigrations: true,
      });
      expect(doctor.skipped).toBe(false);
      expect(doctor.warnings).toContainEqual(
        expect.stringContaining("agent schema owner is missing or blank"),
      );
      expect(doctor.notices ?? []).not.toContain(
        "Deferred legacy agent/session migration: select an agent owner",
      );
    },
  );

  it.each([
    ["without a system agent", undefined],
    ["with a missing system agent", { systemAgent: { agentId: "missing" } }],
  ] as const)(
    "keeps unresolved legacy agent files advisory at startup and actionable in Doctor %s",
    async (_label, defaults) => {
      const root = await createTempDir();
      const stateDir = path.join(root, ".openclaw");
      const env = createEnv(stateDir);
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults,
          entries: { main: {}, blocker: {}, digest: {} },
        },
      };
      const legacyAgentPath = path.join(stateDir, "agent", "settings.json");
      fsSync.mkdirSync(path.dirname(legacyAgentPath), { recursive: true });
      fsSync.writeFileSync(legacyAgentPath, '{"legacy":true}\n');

      const automatic = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

      expect(automatic.skipped).toBe(false);
      expect(automatic.warnings).toEqual([]);
      expect(automatic.notices).toContain(
        "Deferred legacy agent/session migration: select an agent owner",
      );
      expect(fsSync.readFileSync(legacyAgentPath, "utf8")).toBe('{"legacy":true}\n');

      const doctor = await autoMigrateLegacyState({
        cfg,
        env,
        homedir: () => root,
        doctorOnlyStateMigrations: true,
      });
      expect(doctor.skipped).toBe(false);
      expect(doctor.warnings).toContain(
        "Deferred legacy agent/session migration: select an agent owner",
      );
      expect(doctor.notices ?? []).not.toContain(
        "Deferred legacy agent/session migration: select an agent owner",
      );
      expect(fsSync.readFileSync(legacyAgentPath, "utf8")).toBe('{"legacy":true}\n');
    },
  );

  it("leaves legacy session files for Doctor repair with the configured system agent", async () => {
    const targetAgentId = "main";
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: targetAgentId } },
        entries: { main: {}, blocker: {}, digest: {} },
      },
    } satisfies OpenClawConfig;
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const legacySessionsDir = path.join(stateDir, "sessions");
    const legacyAgentDir = path.join(stateDir, "agent");
    await fs.mkdir(legacySessionsDir, { recursive: true });
    await fs.mkdir(legacyAgentDir, { recursive: true });
    await fs.writeFile(
      path.join(legacySessionsDir, "sessions.json"),
      JSON.stringify({ legacy: { sessionId: "legacy-session", updatedAt: 1 } }),
      "utf8",
    );
    await fs.writeFile(path.join(legacySessionsDir, "legacy-session.jsonl"), "{}\n", "utf8");
    await fs.writeFile(path.join(legacyAgentDir, "settings.json"), '{"legacy":true}\n', "utf8");
    const legacyStorePath = path.join(legacySessionsDir, "sessions.json");
    const legacyBytes = await fs.readFile(legacyStorePath);
    await autoMigrateLegacyState({ cfg, env, homedir: () => root });
    await expect(fs.readFile(legacyStorePath)).resolves.toEqual(legacyBytes);
    await expect(
      fs.readFile(path.join(legacySessionsDir, "legacy-session.jsonl"), "utf8"),
    ).resolves.toBe("{}\n");

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      now: () => 1234,
      doctorOnlyStateMigrations: true,
    });

    expect(result.warnings).not.toContain(
      "Deferred legacy agent/session migration: select an agent owner",
    );
    expect(result.notices ?? []).not.toContain(
      "Deferred legacy agent/session migration: select an agent owner",
    );
    await expect(
      fs.readFile(
        path.join(stateDir, "agents", targetAgentId, "sessions", "legacy-session.jsonl"),
        "utf8",
      ),
    ).resolves.toBe("{}\n");
    await expect(
      fs.readFile(path.join(stateDir, "agents", targetAgentId, "agent", "settings.json"), "utf8"),
    ).resolves.toContain('"legacy":true');
    await expectMissingPath(path.join(legacySessionsDir, "sessions.json"));
    await expectMissingPath(legacyAgentDir);
  });

  it("keeps unreadable legacy agent databases blocking", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, blocker: {}, digest: {} } },
    };
    const databasePath = path.join(stateDir, "agent", "openclaw-agent.sqlite");
    fsSync.mkdirSync(path.dirname(databasePath), { recursive: true });
    fsSync.writeFileSync(databasePath, "not a SQLite database");
    const settingsPath = path.join(stateDir, "agent", "settings.json");
    fsSync.writeFileSync(settingsPath, '{"legacy":true}\n');

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

    expect(result.warnings).toContainEqual(
      expect.stringContaining("Failed inspecting legacy agent database"),
    );
    expect(result.notices ?? []).not.toContain(
      "Deferred legacy agent/session migration: select an agent owner",
    );
    expect(fsSync.readFileSync(databasePath, "utf8")).toBe("not a SQLite database");
    expect(fsSync.readFileSync(settingsPath, "utf8")).toBe('{"legacy":true}\n');
  });

  it("detects no plugin-state migration warnings after the startup lease creates fresh state", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const detectLegacyState = vi.fn(async ({ context }: { context: unknown }) => {
      const pluginState = (context as PluginDoctorStateMigrationContext).openPluginStateKeyedStore({
        namespace: "fresh-start-detection",
        maxEntries: 10,
      });
      await expect(pluginState.lookup("legacy")).resolves.toBeUndefined();
      await expect(pluginState.entries()).resolves.toEqual([]);
      return null;
    });
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "fixture",
        migration: {
          id: "fixture-fresh-start-plugin-state",
          label: "Fixture fresh-start plugin state",
          detectLegacyState,
          migrateLegacyState: vi.fn(() => ({ changes: [], warnings: [] })),
        },
      },
    ];

    const lease = acquireStartupMigrationLease({ env, owner: "fresh-start-test" });
    try {
      const databasePath = resolveOpenClawStateSqlitePath(env);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        database.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
      database.close();

      const detected = await detectLegacyStateMigrations({
        cfg: createConfig(),
        env,
        homedir: () => root,
      });

      expect(detectLegacyState).toHaveBeenCalledOnce();
      expect(detected.warnings).toEqual([]);
    } finally {
      lease.release();
    }
  });

  it("uses the requested environment for plugin migration refresh and writes", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, "custom-state");
    const customHome = path.join(root, "custom-home");
    const env = { ...process.env, HOME: customHome, OPENCLAW_STATE_DIR: stateDir };
    const observed: string[] = [];
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "fixture",
        migration: {
          id: "fixture-env",
          label: "Fixture environment",
          detectLegacyState(params) {
            observed.push(`detect:${params.env.HOME}`);
            return { preview: ["- Fixture environment"] };
          },
          migrateLegacyState(params) {
            observed.push(`migrate:${params.env.HOME}`);
            return { changes: ["Migrated fixture environment"], warnings: [] };
          },
        },
      },
    ];

    const config = createConfig();
    const detected = await detectLegacyStateMigrations({ cfg: config, env, homedir: () => root });
    const result = await runLegacyStateMigrations({ detected, config, env });

    expect(observed).toEqual([
      `detect:${customHome}`,
      `detect:${customHome}`,
      `migrate:${customHome}`,
    ]);
    expect(result.changes).toContain("Migrated fixture environment");
  });

  it("scopes doctor channel ingress queue access to the plugin's own channels", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const discovered: string[] = [];
    const offeredChannelIds: string[][] = [];
    const detectionMutableLanes: unknown[] = [];
    const detectionPending: number[] = [];
    const detectionMutatorsReachable: string[] = [];
    const detectionWriteOutcomes: string[] = [];
    // Detection is now read-only, so the account has to already exist. Seeding it
    // directly is also what makes the inspection assertion meaningful.
    await createChannelIngressQueue<{ note: string }>({
      channelId: "line",
      accountId: "default",
      stateDir,
    }).enqueue("ingress-scope-seed", { note: "seeded" });
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "line",
        channelIds: ["line"],
        migration: {
          id: "line-ingress-scope-test",
          label: "LINE ingress scope test",
          async detectLegacyState({ context }) {
            const queues = context.channelIngressQueues ?? [];
            // The host hands out only owner-bound lanes; a foreign channel has no entry.
            offeredChannelIds.push(queues.map((entry) => entry.channelId));
            const line = queues.find((entry) => entry.channelId === "line");
            // Detection runs before exclusive state ownership, so the mutable lane is
            // absent entirely - there is no handle to write through, not merely a
            // handle that refuses.
            detectionMutableLanes.push(line?.openChannelIngressQueue);
            const inspection = line?.openChannelIngressQueueForInspection<{ note: string }>({
              accountId: "default",
            });
            // A narrowed return type still hands over every method at runtime, so the
            // projection is checked as a value: detection must not be able to reach a
            // mutator even by casting the type away.
            for (const method of [
              "enqueue",
              "claimNext",
              "claim",
              "complete",
              "release",
              "fail",
              "delete",
              "recoverStaleClaims",
              "prune",
              "resubmit",
              "refreshClaim",
            ]) {
              detectionMutatorsReachable.push(
                typeof (inspection as Record<string, unknown> | undefined)?.[method],
              );
            }
            detectionPending.push((await inspection?.listPending({ limit: "all" }))?.length ?? -1);
            // Direct mutation attempt: cast the projection back and actually call a
            // writer. There is no method to call, so the attempt cannot reach SQLite.
            try {
              const forced = inspection as unknown as {
                enqueue?: (id: string, payload: unknown) => Promise<unknown>;
              };
              await forced.enqueue?.("detection-write", { note: "leaked" });
              detectionWriteOutcomes.push("no-throw");
            } catch (error) {
              detectionWriteOutcomes.push(
                error instanceof TypeError ? "type-error" : `other:${String(error)}`,
              );
            }
            discovered.push(...((await line?.listChannelIngressQueueAccountIds()) ?? []));
            return null;
          },
          migrateLegacyState: () => ({ changes: [], warnings: [] }),
        },
      },
    ];

    const detected = await detectLegacyStateMigrations({
      cfg: createConfig(),
      env,
      homedir: () => root,
    });

    expect(
      detected.warnings.filter((warning) => warning.includes("LINE ingress scope test")),
    ).toStrictEqual([]);
    // Detection can run more than once per pass; every run must see the same
    // owner-bound lane set and the seeded account.
    expect(offeredChannelIds.length).toBeGreaterThan(0);
    for (const channelIds of offeredChannelIds) {
      expect(channelIds).toStrictEqual(["line"]);
    }
    expect(discovered.length).toBeGreaterThan(0);
    expect([...new Set(discovered)]).toStrictEqual(["default"]);
    // The authority chain: no detection run was ever handed a mutable lane, while the
    // inspection projection still answered on the same access entry.
    expect(detectionMutableLanes.length).toBeGreaterThan(0);
    expect(detectionMutableLanes.every((lane) => lane === undefined)).toBe(true);
    expect(detectionPending.every((count) => count >= 0)).toBe(true);
    // Not one mutating method is present on the inspection object at runtime.
    expect(detectionMutatorsReachable.length).toBeGreaterThan(0);
    expect([...new Set(detectionMutatorsReachable)]).toStrictEqual(["undefined"]);
    // The forced call is optional-chained past a missing method, so it never runs.
    expect([...new Set(detectionWriteOutcomes)]).toStrictEqual(["no-throw"]);
    // And nothing detection did reached durable state: the seeded row is still the
    // only row, so no detection-time write landed.
    const afterDetection = await createChannelIngressQueue<{ note: string }>({
      channelId: "line",
      accountId: "default",
      stateDir,
    }).listPending({ limit: "all", orderBy: "received" });
    expect(afterDetection.map((row) => row.id)).toStrictEqual(["ingress-scope-seed"]);
  });

  it("revokes migration ingress queue access once the repair section returns", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    let retainedOpen:
      | ((options?: { accountId?: string }) => { enqueue: (...args: never[]) => unknown })
      | undefined;
    let retainedQueue: { enqueue: (id: string, payload: unknown) => Promise<unknown> } | undefined;
    let mutableLanePresentDuringMigration = false;
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "line",
        channelIds: ["line"],
        migration: {
          id: "line-ingress-revocation-test",
          label: "LINE ingress revocation test",
          detectLegacyState: () => ({ preview: ["ingress revocation preview"] }),
          async migrateLegacyState({ context }) {
            const line = (context.channelIngressQueues ?? []).find(
              (entry) => entry.channelId === "line",
            );
            const open = line?.openChannelIngressQueue;
            mutableLanePresentDuringMigration = open !== undefined;
            if (open) {
              // Inside the locked section the lane works, and both handles are kept so
              // the same objects can be driven again after the section returns.
              const queue = open<{ note: string }>({ accountId: "default" });
              await queue.enqueue("inside-section", { note: "owned" });
              retainedOpen = open as unknown as typeof retainedOpen;
              retainedQueue = queue as unknown as typeof retainedQueue;
            }
            return { changes: ["ingress revocation test migrated"], warnings: [] };
          },
        },
      },
    ];

    const detected = await detectLegacyStateMigrations({
      cfg: createConfig(),
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({ detected, config: createConfig(), env });

    expect(mutableLanePresentDuringMigration).toBe(true);
    expect(result.changes).toContain("ingress revocation test migrated");

    // Durable-state evidence: the throw alone does not prove the write never reached
    // SQLite. Hash the real database file and re-read the rows through a fresh queue,
    // so a post-section mutation would have to surface as a changed digest.
    const sqlitePath = resolveOpenClawStateSqlitePath(env);
    // Hash the write-ahead log alongside the main file: committed rows can sit in the
    // WAL, so hashing only the .sqlite file would be vacuously stable and prove nothing.
    const digest = () => {
      const hash = createHash("sha256");
      for (const suffix of ["", "-wal", "-shm"]) {
        const file = `${sqlitePath}${suffix}`;
        hash.update(suffix);
        hash.update(fsSync.existsSync(file) ? fsSync.readFileSync(file) : Buffer.alloc(0));
      }
      return hash.digest("hex");
    };
    const readPendingIds = async () =>
      (
        await createChannelIngressQueue<{ note: string }>({
          channelId: "line",
          accountId: "default",
          stateDir,
        }).listPending({ limit: "all", orderBy: "received" })
      ).map((row) => row.id);

    const beforeDigest = digest();
    const beforeIds = await readPendingIds();
    // The write the locked section DID make is on disk, so the file is a live witness.
    expect(beforeIds).toContain("inside-section");

    // Both retained handles are now outside the section that owned the state, and the
    // guard refuses before any promise is created, so no write ever starts.
    expect(() => retainedOpen?.({ accountId: "default" })).toThrow(
      /ingress queue access has expired/i,
    );
    expect(() => retainedQueue?.enqueue("after-section", { note: "leaked" })).toThrow(
      /ingress queue access has expired/i,
    );

    expect(digest()).toBe(beforeDigest);
    expect(await readPendingIds()).toStrictEqual(beforeIds);
  });

  it("withholds ingress queue access from an untrusted plugin owner", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const detectionLanes: unknown[] = [];
    const migrationLanes: unknown[] = [];
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "line",
        channelIds: ["line"],
        // Same decision the runtime proxy makes for openChannelIngressQueue: an
        // activated workspace plugin is neither bundled nor a trusted official install.
        trustedForDurableStores: false,
        migration: {
          id: "line-ingress-trust-test",
          label: "LINE ingress trust test",
          detectLegacyState({ context }) {
            detectionLanes.push(context.channelIngressQueues);
            return { preview: ["ingress trust preview"] };
          },
          migrateLegacyState({ context }) {
            migrationLanes.push(context.channelIngressQueues);
            return { changes: ["ingress trust test ran"], warnings: [] };
          },
        },
      },
    ];

    const detected = await detectLegacyStateMigrations({
      cfg: createConfig(),
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({ detected, config: createConfig(), env });

    expect(result.changes).toContain("ingress trust test ran");
    // Neither phase is handed a lane at all - not an empty list, and not a lane that
    // refuses on use. There is nothing to reach the durable queue through.
    expect(detectionLanes.length).toBeGreaterThan(0);
    expect(migrationLanes.length).toBeGreaterThan(0);
    expect(detectionLanes.every((lanes) => lanes === undefined)).toBe(true);
    expect(migrationLanes.every((lanes) => lanes === undefined)).toBe(true);
  });

  it("rejects a recovery predicate that resolves after the repair section returns", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    // The latch keeps the predicate pending until the migration has returned and the
    // section has closed, which is the exact window the guard has to cover.
    let releasePredicate!: () => void;
    const predicateGate = new Promise<void>((resolve) => {
      releasePredicate = resolve;
    });
    let recoveryOutcome: string | undefined;
    let recoverySettled!: () => void;
    const recoveryDone = new Promise<void>((resolve) => {
      recoverySettled = resolve;
    });

    const seeded = createChannelIngressQueue<{ note: string }>({
      channelId: "line",
      accountId: "default",
      stateDir,
    });
    await seeded.enqueue("latch-evt", { note: "seeded" });
    const claimed = await seeded.claimNext({ ownerId: "retired-owner" });
    expect(claimed?.id).toBe("latch-evt");

    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "line",
        channelIds: ["line"],
        migration: {
          id: "line-ingress-latch-test",
          label: "LINE ingress latch test",
          detectLegacyState: () => ({ preview: ["ingress latch preview"] }),
          migrateLegacyState({ context }) {
            const line = (context.channelIngressQueues ?? []).find(
              (entry) => entry.channelId === "line",
            );
            const open = line?.openChannelIngressQueue;
            if (open) {
              const queue = open<{ note: string }>({ accountId: "default" });
              // Started but deliberately not awaited: the migration returns first.
              void queue
                .recoverStaleClaims({
                  staleMs: 0,
                  shouldRecover: async () => {
                    await predicateGate;
                    return true;
                  },
                })
                .then(() => {
                  recoveryOutcome = "completed";
                })
                .catch((error: unknown) => {
                  recoveryOutcome = String(error);
                })
                .finally(() => recoverySettled());
            }
            return { changes: ["ingress latch test migrated"], warnings: [] };
          },
        },
      },
    ];

    const detected = await detectLegacyStateMigrations({
      cfg: createConfig(),
      env,
      homedir: () => root,
    });
    await runLegacyStateMigrations({ detected, config: createConfig(), env });

    // Only now, with the section closed, does the predicate resolve.
    releasePredicate();
    await recoveryDone;

    expect(recoveryOutcome).toMatch(/ingress queue access has expired/i);
    // The claim is still held: the post-await write never reached SQLite.
    const claims = await createChannelIngressQueue<{ note: string }>({
      channelId: "line",
      accountId: "default",
      stateDir,
    }).listClaims();
    expect(claims.map((claim) => claim.id)).toStrictEqual(["latch-evt"]);
  });

  it("runs doctor-only plugin file imports only during explicit Doctor repair", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const detectLegacyState = vi.fn(() => ({ preview: ["doctor-only plugin state"] }));
    const migrateLegacyState = vi.fn(() => ({
      changes: ["doctor-only plugin state migrated"],
      warnings: [],
    }));
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-doctor-only-test",
          label: "Memory Core doctor-only test migration",
          doctorOnly: true,
          detectLegacyState,
          migrateLegacyState,
        },
      },
    ];

    const automatic = await autoMigrateLegacyPluginDoctorState({
      config: cfg,
      env,
      homedir: () => root,
    });
    expect(automatic.changes).not.toContain("doctor-only plugin state migrated");
    expect(detectLegacyState).not.toHaveBeenCalled();
    expect(migrateLegacyState).not.toHaveBeenCalled();

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(detected.pluginPlans).toMatchObject({ hasLegacy: true });
    expect(detected.preview).toContain("doctor-only plugin state");

    const repaired = await runLegacyStateMigrations({ detected, config: cfg, env });
    expect(repaired.warnings).toStrictEqual([]);
    expect(repaired.changes).toContain("doctor-only plugin state migrated");
    expect(detectLegacyState).toHaveBeenCalledTimes(2);
    expect(migrateLegacyState).toHaveBeenCalledOnce();
  });

  it("excludes post-session plugin repair from legacy migration detection and execution", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {} },
      },
    };
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    await fs.mkdir(path.dirname(legacyStorePath), { recursive: true });
    await fs.writeFile(
      legacyStorePath,
      JSON.stringify({ legacy: { sessionId: "imported-session", updatedAt: 1 } }),
      "utf8",
    );
    const detect = vi.fn(({ context }: { context: unknown }) => {
      expect(
        (context as PluginDoctorStateMigrationContext).deletePluginStateEntriesIfUnchanged,
      ).toBeUndefined();
      return { preview: ["fixture plugin migration"] };
    });
    const postSessionDetect = vi.fn(() => ({ preview: ["post-session repair"] }));
    const postSessionMigrate = vi.fn(() => ({ changes: ["post-session phase"], warnings: [] }));
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "fixture",
        migration: {
          id: "fixture-legacy",
          label: "Fixture legacy plugin migration",
          doctorOnly: true,
          detectLegacyState: detect,
          migrateLegacyState({ context }) {
            expect(fsSync.existsSync(legacyStorePath)).toBe(true);
            expect(
              (context as PluginDoctorStateMigrationContext).deletePluginStateEntriesIfUnchanged,
            ).toBeUndefined();
            return { changes: ["legacy phase"], warnings: [] };
          },
        },
      },
      {
        pluginId: "fixture",
        migration: {
          id: "fixture-after-session-repair",
          label: "Fixture post-session plugin migration",
          doctorOnly: true,
          phase: "after-session-repair",
          detectLegacyState: postSessionDetect,
          migrateLegacyState: postSessionMigrate,
        },
      },
    ];

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    const result = await runLegacyStateMigrations({ detected, config: cfg, env });

    expect(result.warnings).toEqual([]);
    expect(detect).toHaveBeenCalledTimes(2);
    expect(postSessionDetect).not.toHaveBeenCalled();
    expect(postSessionMigrate).not.toHaveBeenCalled();
    expect(result.changes).toContain("legacy phase");
    expect(result.changes).not.toContain("post-session phase");
  });

  it("restores retained Memory Core host events only for explicit plugin-only Doctor repair", async () => {
    const root = await fs.realpath(await createTempDir());
    const stateDir = path.join(root, ".openclaw");
    const workspaceDir = path.join(root, "workspace");
    const eventPath = path.join(workspaceDir, "memory", ".dreams", "events.jsonl");
    const env = createEnv(stateDir);
    const cfg = {
      agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
    } as OpenClawConfig;
    const event = {
      type: "memory.recall.recorded",
      timestamp: "2026-07-01T00:00:00.000Z",
      query: "retained before upgrade",
      resultCount: 0,
      results: [],
    } as const;
    await fs.mkdir(path.dirname(eventPath), { recursive: true });
    await fs.writeFile(eventPath, `${JSON.stringify(event)}\n`, "utf8");

    const { stateMigrations } = (await import(
      /* @vite-ignore */ new URL(
        "../../extensions/memory-core/doctor-contract-api.ts",
        import.meta.url,
      ).href
    )) as { stateMigrations: PluginDoctorStateMigration[] };
    const migration = stateMigrations.find(
      (candidate) => candidate.id === "memory-core-host-events-jsonl-to-sqlite",
    );
    expect(migration).toBeDefined();
    if (!migration) {
      throw new Error("Expected the bundled Memory Core host-event Doctor migration");
    }
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: migration.id,
          label: migration.label,
          doctorOnly: migration.doctorOnly,
          detectLegacyState: (params) =>
            migration.detectLegacyState({
              ...params,
              context: params.context as PluginDoctorStateMigrationContext,
            }),
          migrateLegacyState: async (params) => {
            const result = await migration.migrateLegacyState({
              ...params,
              context: params.context as PluginDoctorStateMigrationContext,
            });
            return { changes: result.changes, warnings: result.warnings };
          },
        },
      },
    ];

    const automatic = await autoMigrateLegacyPluginDoctorState({
      config: cfg,
      env,
      homedir: () => root,
    });
    expect(automatic.warnings).toEqual([]);
    expect(automatic.changes).not.toContain(
      "Migrated Memory Core host events -> SQLite plugin state (1 new row(s))",
    );
    await expect(readMemoryHostEventRecords({ workspaceDir, env })).resolves.toEqual([]);
    await expect(fs.stat(eventPath)).resolves.toBeDefined();

    const repaired = await autoMigrateLegacyPluginDoctorState({
      config: cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(repaired.warnings).toEqual([]);
    expect(repaired.changes).toContain(
      "Migrated Memory Core host events -> SQLite plugin state (1 new row(s))",
    );
    await expect(readMemoryHostEventRecords({ workspaceDir, env })).resolves.toEqual([event]);
    await expectMissingPath(eventPath);
    await expect(fs.stat(`${eventPath}.migrated`)).resolves.toBeDefined();
  });

  it("runs doctor-only repairs after the automatic migration check", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const detectLegacyState = vi.fn(() => ({ preview: ["doctor-only repair"] }));
    const migrateLegacyState = vi.fn(() => ({
      changes: ["doctor-only repair migrated"],
      warnings: [],
    }));
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-doctor-only-latch-test",
          label: "Memory Core doctor-only latch test",
          doctorOnly: true,
          detectLegacyState,
          migrateLegacyState,
        },
      },
    ];

    const automatic = await autoMigrateLegacyState({ cfg, env, homedir: () => root });
    expect(automatic.changes).not.toContain("doctor-only repair migrated");
    expect(detectLegacyState).not.toHaveBeenCalled();

    const repaired = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(repaired.changes).toContain("doctor-only repair migrated");
    expect(detectLegacyState).toHaveBeenCalledTimes(2);
    expect(migrateLegacyState).toHaveBeenCalledOnce();
  });

  it("checks automatic migrations independently for each state directory", async () => {
    const root = await createTempDir();
    const stateDirs = [path.join(root, "state-a"), path.join(root, "state-b")];
    const detectedStateDirs: string[] = [];
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-state-dir-latch-test",
          label: "Memory Core state-dir latch test",
          detectLegacyState: ({ stateDir }) => {
            detectedStateDirs.push(stateDir);
            return null;
          },
          migrateLegacyState: () => ({ changes: [], warnings: [] }),
        },
      },
    ];

    for (const stateDir of stateDirs) {
      await autoMigrateLegacyState({
        cfg: createConfig(),
        env: createEnv(stateDir),
        homedir: () => root,
      });
    }

    expect(new Set(detectedStateDirs)).toStrictEqual(new Set(stateDirs));
  });

  it("detects legacy sessions, agent files, channel auth, and pairing state", () => {
    expect(detectionCase.targetAgentId).toBe("worker-1");
    expect(detectionCase.targetMainKey).toBe("desk");
    expect(detectionCase.sessions.hasLegacy).toBe(true);
    expect(detectionCase.sessions.legacyKeys).toEqual(["group:mobile-room", "group:legacy-room"]);
    expect(detectionCase.agentDir.hasLegacy).toBe(true);
    expect(detectionCase.pluginPlans?.hasLegacy).toBe(true);
    expect(detectionCase.pluginPlans?.plans.map((plan) => plan.migration.id)).toContain(
      "mobileauth-legacy-state",
    );
    expect(detectionCase.channelPairing.hasLegacy).toBe(true);
    expect(detectionCase.preview).toEqual([
      `- Sessions: ${path.join(detectionCase.stateDir, "sessions")} → ${path.join(detectionCase.stateDir, "agents", "worker-1", "sessions")}`,
      `- Sessions: canonicalize legacy keys in ${path.join(detectionCase.stateDir, "agents", "worker-1", "sessions", "sessions.json")}`,
      `- Agent dir: ${path.join(detectionCase.stateDir, "agent")} → ${path.join(detectionCase.stateDir, "agents", "worker-1", "agent")}`,
      "- Channel pairing state: legacy JSON files → shared SQLite state",
      `- MobileAuth auth creds.json: ${path.join(detectionCase.stateDir, "credentials", "creds.json")} → ${path.join(detectionCase.stateDir, "credentials", "mobileauth", "default", "creds.json")}`,
    ]);
  });

  it("runs legacy state migrations and canonicalizes the merged session store", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture({ includePreKey: true });
    cfg.session = { ...cfg.session, mainKey: "Desk" };
    const targetStorePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
    const targetStore = JSON.parse(await fs.readFile(targetStorePath, "utf8")) as Record<
      string,
      unknown
    >;
    targetStore["agent:main:desk"] = { sessionId: "explicit-foreign", updatedAt: 30 };
    targetStore["voice:15550001111"] = {
      sessionId: "shared-voice",
      updatedAt: 20,
      acp: {
        backend: "test",
        agent: "worker-1",
        runtimeSessionName: "shared-runtime",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 20,
      },
    };
    targetStore["agent:worker-1:acp:task"] = {
      sessionId: "canonical-acp",
      updatedAt: 15,
      acp: {
        backend: "test",
        agent: "worker-1",
        runtimeSessionName: "canonical-runtime",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 15,
      },
    };
    await fs.writeFile(targetStorePath, `${JSON.stringify(targetStore, null, 2)}\n`, "utf8");
    cfg.session = { ...cfg.session, store: targetStorePath };
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    const legacyStore = JSON.parse(await fs.readFile(legacyStorePath, "utf8")) as Record<
      string,
      unknown
    >;
    legacyStore["Agent:main:desk"] = { sessionId: "mixed-case-foreign", updatedAt: 40 };
    legacyStore["legacy-prototype"] = {
      sessionId: "prototype-row",
      updatedAt: 10,
      sessionFile: "trace.jsonl",
    };
    await fs.writeFile(legacyStorePath, `${JSON.stringify(legacyStore, null, 2)}\n`, "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
      pluginSessionStoreAgentIds: ["worker-1"],
    });
    expect(detected.sessions.preserveAmbiguousKeys).toBe(false);
    expect(detected.sessions.preserveForeignMainAliases).toBe(true);
    expect(detected.sessions.targetStoreAliases.hasDistinctAliases).toBe(false);
    const result = await runLegacyStateMigrations({
      detected,
      config: cfg,
      now: () => 1234,
    });
    expect(result.warnings).toStrictEqual([
      `Preserved 1 ambiguous session key(s) while importing legacy sessions into ${targetStorePath}`,
    ]);
    expect(result.changes).toEqual([
      "Migrated 2 chatapp/alpha allowFrom entries → shared SQLite state",
      `Moved MobileAuth auth creds.json → ${path.join(stateDir, "credentials", "mobileauth", "default", "creds.json")}`,
      `Moved MobileAuth auth pre-key-1.json → ${path.join(stateDir, "credentials", "mobileauth", "default", "pre-key-1.json")}`,
      `Migrated latest direct-chat session → agent:worker-1:desk`,
      `Merged sessions store → ${path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json")}`,
      "Canonicalized 3 legacy session key(s)",
      "Moved trace.jsonl → agents/worker-1/sessions",
      "Migrated 2 ACP session metadata rows → shared SQLite state",
      "Moved agent file settings.json → agents/worker-1/agent",
    ]);

    const mergedStore = JSON.parse(
      await fs.readFile(
        path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json"),
        "utf8",
      ),
    ) as Record<string, { sessionId: string; sessionFile?: string; acp?: unknown }>;
    expect(mergedStore["agent:worker-1:desk"]?.sessionId).toBe("legacy-direct");
    expect(mergedStore["group:mobile-room"]).toBeUndefined();
    expect(mergedStore["group:legacy-room"]).toBeUndefined();
    expect(mergedStore["agent:worker-1:unknown:group:mobile-room"]?.sessionId).toBe(
      "group-session",
    );
    expect(mergedStore["agent:worker-1:unknown:group:legacy-room"]?.sessionId).toBe(
      "generic-group-session",
    );
    expect(mergedStore["agent:main:desk"]?.sessionId).toBe("explicit-foreign");
    expect(mergedStore["Agent:main:desk"]?.sessionId).toBe("mixed-case-foreign");
    expect(mergedStore["voice:15550001111"]).toBeUndefined();
    expect(mergedStore["agent:worker-1:voice:15550001111"]?.sessionId).toBe("shared-voice");
    expect(mergedStore["agent:worker-1:voice:15550001111"]?.acp).toBeUndefined();
    expect(mergedStore["agent:worker-1:legacy-prototype"]?.sessionId).toBe("prototype-row");
    expect(mergedStore["agent:worker-1:legacy-prototype"]).not.toHaveProperty("sessionFile");
    expect(mergedStore["agent:worker-1:acp:task"]?.acp).toBeUndefined();

    await expect(
      fs.readFile(path.join(stateDir, "agents", "worker-1", "sessions", "trace.jsonl"), "utf8"),
    ).resolves.toBe("{}\n");
    await expectMissingPath(path.join(stateDir, "sessions", "sessions.json"));
    await expectMissingPath(path.join(stateDir, "sessions", "trace.jsonl"));

    await expect(
      fs.readFile(path.join(stateDir, "agents", "worker-1", "agent", "settings.json"), "utf8"),
    ).resolves.toContain('"ok":true');
    await expect(
      fs.readFile(
        path.join(stateDir, "credentials", "mobileauth", "default", "creds.json"),
        "utf8",
      ),
    ).resolves.toContain('"auth":true');
    await expect(
      fs.readFile(
        path.join(stateDir, "credentials", "mobileauth", "default", "pre-key-1.json"),
        "utf8",
      ),
    ).resolves.toContain('"preKey":true');
    await expect(
      fs.readFile(path.join(stateDir, "credentials", "oauth.json"), "utf8"),
    ).resolves.toContain('"oauth":true');
    expect(readChannelPairingStateSnapshot("chatapp", env).allowFrom).toEqual({
      alpha: ["123", "456"],
    });
    await expectMissingPath(path.join(stateDir, "credentials", "chatapp-allowFrom.json"));
  });

  it("canonicalizes parsed owners before removing the legacy store", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    await fs.mkdir(path.dirname(legacyStorePath), { recursive: true });
    await fs.writeFile(
      legacyStorePath,
      JSON.stringify({
        "agent:archive:main": { sessionId: "archive-session", updatedAt: 20 },
      }),
      "utf8",
    );
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });

    await runLegacyStateMigrations({ detected, config: cfg, now: () => 1234 });

    const targetStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const store = JSON.parse(await fs.readFile(targetStorePath, "utf8")) as Record<
      string,
      { sessionId: string }
    >;
    expect(store["agent:archive:work"]?.sessionId).toBe("archive-session");
    expect(store["agent:archive:main"]).toBeUndefined();
    await expectMissingPath(legacyStorePath);
  });

  it("defers non-main owner merges across hard-linked stores", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const targetStorePath = path.join(stateDir, "agents", "ops", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(targetStorePath), { recursive: true });
    await fs.writeFile(
      targetStorePath,
      JSON.stringify({
        "agent:ops:main": { sessionId: "ops-session", updatedAt: 10 },
      }),
      "utf8",
    );
    const configuredStorePath = path.join(root, "configured-sessions.json");
    await fs.link(targetStorePath, configuredStorePath);
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    await fs.mkdir(path.dirname(legacyStorePath), { recursive: true });
    await fs.writeFile(
      legacyStorePath,
      JSON.stringify({
        "agent:research:main": { sessionId: "research-session", updatedAt: 20 },
      }),
      "utf8",
    );
    const cfg = {
      session: { mainKey: "work", store: configuredStorePath },
      agents: { list: [{ id: "ops", default: true }, { id: "research" }] },
    } as OpenClawConfig;
    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.sessions.preserveAmbiguousKeys).toBe(true);

    const result = await runLegacyStateMigrations({ detected, config: cfg, now: () => 1234 });

    for (const storePath of [targetStorePath, configuredStorePath]) {
      const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
        string,
        { sessionId: string }
      >;
      expect(store["agent:ops:main"]?.sessionId).toBe("ops-session");
      expect(store["agent:ops:work"]).toBeUndefined();
      expect(store["agent:research:main"]).toBeUndefined();
    }
    await expect(fs.readFile(legacyStorePath, "utf8")).resolves.toContain("research-session");
    expect(result.warnings).toContainEqual(
      expect.stringContaining("atomic replacement cannot update distinct filesystem aliases"),
    );
  });

  it("defers an unambiguous legacy merge through a final store symlink", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const outsideStorePath = path.join(root, "outside-sessions.json");
    await fs.writeFile(outsideStorePath, "{}\n", "utf8");
    const targetStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(targetStorePath), { recursive: true });
    await fs.symlink(outsideStorePath, targetStorePath);
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    await fs.mkdir(path.dirname(legacyStorePath), { recursive: true });
    await fs.writeFile(
      legacyStorePath,
      JSON.stringify({
        "agent:main:task": { sessionId: "legacy-task", updatedAt: 10 },
      }),
      "utf8",
    );
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;
    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });

    const result = await runLegacyStateMigrations({ detected, config: cfg, now: () => 1234 });

    expect((await fs.lstat(targetStorePath)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(outsideStorePath, "utf8")).resolves.toBe("{}\n");
    await expect(fs.readFile(legacyStorePath, "utf8")).resolves.toContain("legacy-task");
    expect(result.warnings).toContain(
      `Deferred legacy session migration in final-component symlink store ${targetStorePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
    );
  });

  it("defers legacy migration when configured store identity is inaccessible", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const targetStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(targetStorePath), { recursive: true });
    await fs.writeFile(targetStorePath, "{}\n", "utf8");
    const configuredStorePath = path.join(root, "configured-sessions.json");
    await fs.writeFile(configuredStorePath, "{}\n", "utf8");
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    await fs.mkdir(path.dirname(legacyStorePath), { recursive: true });
    await fs.writeFile(
      legacyStorePath,
      JSON.stringify({ "agent:main:task": { sessionId: "legacy", updatedAt: 10 } }),
      "utf8",
    );
    const cfg = {
      session: { store: configuredStorePath },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    const realStatSync = fsSync.statSync.bind(fsSync);
    const statSpy = vi.spyOn(fsSync, "statSync").mockImplementation((candidate) => {
      if (path.resolve(candidate.toString()) === configuredStorePath) {
        throw Object.assign(new Error("inaccessible store"), { code: "EACCES" });
      }
      return realStatSync(candidate);
    });
    let detected: Awaited<ReturnType<typeof detectLegacyStateMigrations>>;
    try {
      detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    } finally {
      statSpy.mockRestore();
    }

    expect(detected.sessions.targetStoreAliases.hasUnresolvedIdentity).toBe(true);
    const result = await runLegacyStateMigrations({ detected, config: cfg, now: () => 1234 });

    expect(result.warnings).toContainEqual(
      expect.stringContaining("filesystem identity could not be established"),
    );
    await expect(fs.readFile(legacyStorePath, "utf8")).resolves.toContain("legacy");
    await expect(fs.readFile(targetStorePath, "utf8")).resolves.toBe("{}\n");
  });

  it("keeps the legacy source when its store write fails", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const targetStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(targetStorePath), { recursive: true });
    await fs.writeFile(targetStorePath, "{}\n", "utf8");
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    await fs.mkdir(path.dirname(legacyStorePath), { recursive: true });
    await fs.writeFile(
      legacyStorePath,
      JSON.stringify({ "agent:main:task": { sessionId: "legacy", updatedAt: 10 } }),
      "utf8",
    );
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const realSaveSessionStore = sessionStore.saveLegacySessionStore;
    let sawRequiredWrite = false;
    const saveSpy = vi
      .spyOn(sessionStore, "saveLegacySessionStore")
      .mockImplementation(async (storePath, store, options) => {
        sawRequiredWrite ||= options?.requireWriteSuccess === true;
        if (storePath === targetStorePath) {
          throw new Error("simulated alias write failure");
        }
        await realSaveSessionStore(storePath, store, options);
      });
    try {
      await expect(
        runLegacyStateMigrations({ detected, config: cfg, now: () => 1234 }),
      ).rejects.toThrow("simulated alias write failure");
    } finally {
      saveSpy.mockRestore();
    }

    expect(sawRequiredWrite).toBe(true);
    await expect(fs.readFile(legacyStorePath, "utf8")).resolves.toContain("legacy");
  });

  it("preserves shared ownership through missing parent-symlink store paths", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const agentsDir = path.join(stateDir, "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    const aliasAgentsDir = path.join(root, "agents-alias");
    await fs.symlink(agentsDir, aliasAgentsDir, "dir");
    const configuredStorePath = path.join(aliasAgentsDir, "ops", "sessions", "sessions.json");
    const targetStorePath = path.join(agentsDir, "ops", "sessions", "sessions.json");
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    await fs.mkdir(path.dirname(legacyStorePath), { recursive: true });
    await fs.writeFile(
      legacyStorePath,
      JSON.stringify({
        "agent:main:work": { sessionId: "foreign-main", updatedAt: 10 },
      }),
      "utf8",
    );
    const cfg = {
      session: { mainKey: "work", store: configuredStorePath },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
      pluginSessionStoreAgentIds: ["voice"],
    });
    expect(detected.sessions.preserveAmbiguousKeys).toBe(true);
    expect(detected.sessions.preserveForeignMainAliases).toBe(true);

    await runLegacyStateMigrations({ detected, config: cfg, now: () => 1234 });

    const store = JSON.parse(await fs.readFile(targetStorePath, "utf8")) as Record<
      string,
      { sessionId: string }
    >;
    expect(store["agent:main:work"]?.sessionId).toBe("foreign-main");
    expect(store["agent:ops:work"]).toBeUndefined();
    await expect(fs.readFile(configuredStorePath, "utf8")).resolves.toBe(
      await fs.readFile(targetStorePath, "utf8"),
    );
  });

  describe("aliased store ownership", () => {
    let configuredStorePath: string;
    let targetStorePath: string;
    let targetStore: Record<string, { sessionId: string }>;
    let result: Awaited<ReturnType<typeof autoMigrateLegacyState>>;

    beforeAll(async () => {
      const root = await createTempDir();
      const stateDir = path.join(root, ".openclaw");
      const env = createEnv(stateDir);
      targetStorePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
      await fs.mkdir(path.dirname(targetStorePath), { recursive: true });
      await fs.writeFile(
        targetStorePath,
        JSON.stringify({
          "agent:main:desk": { sessionId: "foreign-main", updatedAt: 30 },
          "agent:worker-1:main": {
            sessionId: "worker-main",
            updatedAt: 20,
            acp: {
              backend: "test",
              agent: "worker-1",
              runtimeSessionName: "legacy-runtime",
              mode: "persistent",
              state: "idle",
              lastActivityAt: 20,
            },
          },
          "voice:15550001111": { sessionId: "legacy-voice", updatedAt: 10 },
        }),
        "utf8",
      );
      configuredStorePath = path.join(root, "configured-sessions.json");
      await fs.link(targetStorePath, configuredStorePath);
      const cfg = {
        agents: { list: [{ id: "worker-1", default: true }] },
        session: { mainKey: "desk", store: configuredStorePath },
        plugins: {
          entries: {
            "voice-call": { config: { agentId: "worker-1" } },
          },
        },
      } as OpenClawConfig;

      result = await autoMigrateLegacyState({
        cfg,
        env,
        homedir: () => root,
        doctorOnlyStateMigrations: true,
      });
      targetStore = JSON.parse(await fs.readFile(targetStorePath, "utf8")) as Record<
        string,
        { sessionId: string }
      >;
    });

    it("preserves plugin ownership captured before an aliased store rewrite", () => {
      expect(targetStore["agent:main:desk"]?.sessionId).toBe("foreign-main");
      expect(targetStore["agent:worker-1:main"]?.sessionId).toBe("worker-main");
      expect(targetStore["agent:worker-1:desk"]).toBeUndefined();
      expect(targetStore["agent:worker-1:main"]).toHaveProperty("acp");
      expect(fsSync.statSync(configuredStorePath).ino).toBe(fsSync.statSync(targetStorePath).ino);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`aliased store ${configuredStorePath}`),
          expect.stringContaining(`aliased store ${targetStorePath}`),
          expect.stringContaining("Deferred ACP metadata migration"),
        ]),
      );
    });
  });

  it("preserves a singleton final symlink through all session migration phases", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const outsideStorePath = path.join(root, "outside-sessions.json");
    await fs.writeFile(
      outsideStorePath,
      JSON.stringify({
        "voice:15550001111": { sessionId: "outside-voice", updatedAt: 10 },
      }),
      "utf8",
    );
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.symlink(outsideStorePath, storePath);
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    expect((await fs.lstat(storePath)).isSymbolicLink()).toBe(true);
    const outsideStore = JSON.parse(await fs.readFile(outsideStorePath, "utf8")) as Record<
      string,
      { sessionId: string }
    >;
    expect(outsideStore["voice:15550001111"]?.sessionId).toBe("outside-voice");
    expect(result.warnings).toEqual([
      `Deferred session key migration in final-component symlink store ${storePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
      `Deferred legacy session migration in final-component symlink store ${storePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
    ]);
  });

  it("preserves ACP metadata through a singleton fixed-store symlink", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const outsideStorePath = path.join(root, "outside-sessions.json");
    const pendingKey = "agent:main:task";
    await fs.writeFile(
      outsideStorePath,
      JSON.stringify({
        [pendingKey]: {
          sessionId: pendingKey,
          updatedAt: 10,
          acp: {
            backend: "test",
            agent: "main",
            runtimeSessionName: "outside-runtime",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 10,
          },
        },
      }),
      "utf8",
    );
    const configuredStorePath = path.join(root, "configured-sessions.json");
    await fs.symlink(outsideStorePath, configuredStorePath);
    const cfg = {
      session: { store: configuredStorePath },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    expect((await fs.lstat(configuredStorePath)).isSymbolicLink()).toBe(true);
    const outsideStore = JSON.parse(await fs.readFile(outsideStorePath, "utf8")) as Record<
      string,
      { sessionId?: string; acp?: unknown }
    >;
    expect(outsideStore[pendingKey]?.sessionId).toBe(pendingKey);
    expect(outsideStore[pendingKey]?.acp).toBeDefined();
    expect(
      readAcpSessionMetaForEntry({
        sessionKey: pendingKey,
        entry: { sessionId: pendingKey, lifecycleRevision: undefined },
        env,
      }),
    ).toBeUndefined();
    expect(result.warnings).toContain(
      `Deferred ACP metadata migration in final-component symlink store ${configuredStorePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
    );
    expect(result.changes).not.toContain(
      "Migrated 1 ACP session metadata row → shared SQLite state",
    );
  });

  it("defers ACP metadata migration across hard-linked store paths", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const targetStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(targetStorePath), { recursive: true });
    await fs.writeFile(
      targetStorePath,
      JSON.stringify({
        "agent:main:task": {
          sessionId: "canonical-acp",
          updatedAt: 10,
          acp: {
            backend: "test",
            agent: "main",
            runtimeSessionName: "hardlink-runtime",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 10,
          },
        },
      }),
      "utf8",
    );
    const configuredStorePath = path.join(root, "configured-sessions.json");
    await fs.link(targetStorePath, configuredStorePath);
    const cfg = {
      session: { store: configuredStorePath },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    for (const storePath of [targetStorePath, configuredStorePath]) {
      const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
        string,
        { acp?: unknown }
      >;
      expect(store["agent:main:task"]?.acp).toBeDefined();
    }
    expect(result.changes).not.toContain(
      "Migrated 1 ACP session metadata row → shared SQLite state",
    );
    expect(result.warnings).toContainEqual(
      expect.stringContaining("atomic replacement cannot update distinct filesystem aliases"),
    );
  });

  it("defers global main aliases across hard-linked store paths", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const targetStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(targetStorePath), { recursive: true });
    await fs.writeFile(
      targetStorePath,
      JSON.stringify({
        "agent:main:main": {
          sessionId: "legacy-global",
          updatedAt: 20,
          acp: {
            backend: "test",
            agent: "main",
            runtimeSessionName: "global-runtime",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 20,
          },
        },
      }),
      "utf8",
    );
    const configuredStorePath = path.join(root, "configured-sessions.json");
    await fs.link(targetStorePath, configuredStorePath);
    const cfg = {
      session: { scope: "global", store: configuredStorePath },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    for (const storePath of [configuredStorePath, targetStorePath]) {
      const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
        string,
        { sessionId: string; acp?: unknown }
      >;
      expect(store["agent:main:main"]?.sessionId).toBe("legacy-global");
      expect(store["agent:main:main"]?.acp).toBeDefined();
      expect(store.global).toBeUndefined();
    }
    expect(result.warnings).toContainEqual(
      expect.stringContaining("atomic replacement cannot update distinct filesystem aliases"),
    );
    expect(result.changes).not.toContain(
      "Migrated 1 ACP session metadata row → shared SQLite state",
    );
  });

  it.each([
    { name: "default", templated: false },
    { name: "templated plugin", templated: true },
  ])("preserves foreign ACP aliases in $name stores", async ({ templated }) => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const storeTemplate = path.join(root, "stores", "{agentId}", "sessions.json");
    const storePath = templated
      ? path.join(root, "stores", "voice", "sessions.json")
      : path.join(stateDir, "agents", "voice", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify({
        "agent:main:main": {
          sessionId: "foreign-main",
          updatedAt: 20,
          acp: {
            backend: "test",
            agent: "voice",
            runtimeSessionName: "foreign-runtime",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 20,
          },
        },
      }),
      "utf8",
    );
    const cfg = {
      session: { scope: "global", ...(templated ? { store: storeTemplate } : {}) },
      agents: { list: [{ id: templated ? "main" : "voice", default: true }] },
      plugins: {
        entries: {
          "voice-call": { config: { agentId: "voice" } },
        },
      },
    } as OpenClawConfig;

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
      string,
      { sessionId: string; acp?: unknown }
    >;
    expect(store["agent:main:main"]?.sessionId).toBe("foreign-main");
    expect(store["agent:main:main"]?.acp).toBeDefined();
    expect(store.global).toBeUndefined();
    expect(result.changes).not.toContain(
      "Migrated 1 ACP session metadata row → shared SQLite state",
    );
    const acpWarningPrefix =
      "Preserved ACP metadata for 1 ambiguous session key(s) in potentially shared store ";
    expect(result.warnings.filter((warning) => warning.startsWith(acpWarningPrefix))).toHaveLength(
      1,
    );
  });

  it("migrates malformed agent-shaped rows in single-owner plugin stores", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const storeTemplate = path.join(root, "stores", "{agentId}", "sessions.json");
    const storePath = path.join(root, "stores", "voice", "sessions.json");
    const cases = [
      {
        legacyKey: "agent::matrix:channel:!RoomAbC:example.org",
        canonicalKey: "agent:voice:agent::matrix:channel:!RoomAbC:example.org",
        sessionId: "malformed-owner",
        runtimeSessionName: "malformed-runtime",
      },
      {
        legacyKey: "agent:_bad:opaque",
        canonicalKey: "agent:voice:agent:_bad:opaque",
        sessionId: "invalid-owner",
        runtimeSessionName: "invalid-runtime",
      },
    ];
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        Object.fromEntries(
          cases.map(({ legacyKey, sessionId, runtimeSessionName }) => [
            legacyKey,
            {
              sessionId,
              updatedAt: 10,
              acp: {
                backend: "test",
                agent: "voice",
                runtimeSessionName,
                mode: "persistent",
                state: "idle",
                lastActivityAt: 10,
              },
            },
          ]),
        ),
      ),
      "utf8",
    );
    const cfg = {
      session: { store: storeTemplate },
      agents: { list: [{ id: "main", default: true }] },
      plugins: {
        entries: {
          "voice-call": { config: { agentId: "voice" } },
        },
      },
    } as OpenClawConfig;

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
      string,
      { sessionId: string; acp?: unknown }
    >;
    for (const { legacyKey, canonicalKey, sessionId, runtimeSessionName } of cases) {
      expect(store[legacyKey]).toBeUndefined();
      expect(store[canonicalKey]).toEqual({
        sessionId,
        updatedAt: 10,
        delivery: { kind: "none" },
      });
      expect(
        readAcpSessionMetaForEntry({
          sessionKey: canonicalKey,
          entry: { sessionId, lifecycleRevision: undefined },
          env,
        })?.runtimeSessionName,
      ).toBe(runtimeSessionName);
      expect(
        readAcpSessionMetaForEntry({
          sessionKey: legacyKey,
          entry: { sessionId, lifecycleRevision: undefined },
          env,
        }),
      ).toBeUndefined();
    }
    expect(result.changes).toContain("Migrated 2 ACP session metadata rows → shared SQLite state");
    expect(result.warnings).toHaveLength(0);
  });

  it("preserves multi-owner rows through coalesced templated-store migration", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const storeTemplate = path.join(
      stateDir,
      "agents",
      "{agentId}",
      "..",
      "main",
      "sessions",
      "sessions.json",
    );
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify({
        "voice:15550001111": {
          sessionId: "shared-voice",
          updatedAt: 20,
          acp: {
            backend: "test",
            agent: "voice",
            runtimeSessionName: "shared-runtime",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 20,
          },
        },
        "agent:voice::matrix:channel:!room:example.org": {
          sessionId: "malformed-owner",
          updatedAt: 10,
          acp: {
            backend: "test",
            agent: "voice",
            runtimeSessionName: "malformed-runtime",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 10,
          },
        },
        "agent:_bad:opaque": {
          sessionId: "invalid-owner",
          updatedAt: 5,
          acp: {
            backend: "test",
            agent: "voice",
            runtimeSessionName: "invalid-runtime",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 5,
          },
        },
      }),
      "utf8",
    );
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    await fs.mkdir(path.dirname(legacyStorePath), { recursive: true });
    await fs.writeFile(legacyStorePath, "{}\n", "utf8");
    const cfg = {
      session: { store: storeTemplate },
      agents: { list: [{ id: "main", default: true }] },
      acp: { allowedAgents: ["voice"] },
    } as OpenClawConfig;

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
      string,
      { sessionId: string; acp?: unknown }
    >;
    expect(store["voice:15550001111"]?.sessionId).toBe("shared-voice");
    expect(store["voice:15550001111"]?.acp).toBeDefined();
    expect(store["agent:voice::matrix:channel:!room:example.org"]?.sessionId).toBe(
      "malformed-owner",
    );
    expect(store["agent:voice::matrix:channel:!room:example.org"]?.acp).toBeDefined();
    expect(store["agent:_bad:opaque"]?.sessionId).toBe("invalid-owner");
    expect(store["agent:_bad:opaque"]?.acp).toBeDefined();
    expect(store["agent:main:voice:15550001111"]).toBeUndefined();
    expect(store["agent:voice:voice:15550001111"]).toBeUndefined();
    expect(store["agent:main:agent:voice::matrix:channel:!room:example.org"]).toBeUndefined();
    expect(result.changes).not.toContain(
      "Migrated 1 ACP session metadata row → shared SQLite state",
    );
    const acpWarningPrefix =
      "Preserved ACP metadata for 3 ambiguous session key(s) in potentially shared store ";
    expect(result.warnings.filter((warning) => warning.startsWith(acpWarningPrefix))).toHaveLength(
      1,
    );
  });

  it("does not process ACP stores rejected by target validation", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const outsideStorePath = path.join(root, "outside-sessions.json");
    await fs.writeFile(
      outsideStorePath,
      JSON.stringify({
        "agent:main:opaque": {
          sessionId: "outside-session",
          updatedAt: 10,
          acp: {
            backend: "test",
            agent: "main",
            runtimeSessionName: "outside-runtime",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 10,
          },
        },
      }),
      "utf8",
    );
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.symlink(outsideStorePath, storePath);
    const cfg = { agents: { list: [{ id: "main", default: true }] } } as OpenClawConfig;

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    expect((await fs.lstat(storePath)).isSymbolicLink()).toBe(true);
    const outsideStore = JSON.parse(await fs.readFile(outsideStorePath, "utf8")) as Record<
      string,
      { acp?: unknown }
    >;
    expect(outsideStore["agent:main:opaque"]?.acp).toBeDefined();
    expect(result.changes).not.toContain(
      "Migrated 1 ACP session metadata row → shared SQLite state",
    );
  });

  it("leaves standalone ACP session metadata unchanged until Doctor repair", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const pendingKey = "agent:main:existing";
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [pendingKey]: {
          sessionId: pendingKey,
          updatedAt: 20,
          displayName: "Pending ACP session",
          providerOverride: "test-provider",
          modelOverride: "test-model",
          modelOverrideSource: "user",
          acp: {
            backend: "test",
            agent: "main",
            runtimeSessionName: "existing-runtime",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 20,
          },
        },
      }),
      "utf8",
    );

    const cfg: OpenClawConfig = { agents: { list: [{ id: "main", default: true }] } };
    const originalBytes = await fs.readFile(storePath);
    const readFile = vi.spyOn(fsSync, "readFileSync");
    try {
      const automatic = await autoMigrateLegacyState({ cfg, env, homedir: () => root });
      expect(readFile.mock.calls.map(([pathname]) => pathname)).not.toContain(storePath);
      expect(automatic.changes).toEqual([]);
    } finally {
      readFile.mockRestore();
    }
    await expect(fs.readFile(storePath)).resolves.toEqual(originalBytes);
    expect(
      readAcpSessionMetaForEntry({
        sessionKey: pendingKey,
        entry: { lifecycleRevision: undefined },
        env,
      }),
    ).toBeUndefined();

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    expect(result.changes).toContain("Migrated 1 ACP session metadata row → shared SQLite state");
    const afterStore = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
      string,
      {
        sessionId?: string;
        initializationPending?: boolean;
        acp?: unknown;
        displayName?: string;
        providerOverride?: string;
        modelOverride?: string;
        modelOverrideSource?: string;
      }
    >;
    expect(afterStore[pendingKey]).toMatchObject({
      initializationPending: true,
      displayName: "Pending ACP session",
      providerOverride: "test-provider",
      modelOverride: "test-model",
      modelOverrideSource: "user",
    });
    expect(afterStore[pendingKey]?.sessionId).toBeUndefined();
    expect(afterStore[pendingKey]?.acp).toBeUndefined();
    expect(
      readAcpSessionMetaForEntry({
        sessionKey: pendingKey,
        entry: { lifecycleRevision: undefined },
        env,
      })?.runtimeSessionName,
    ).toBe("existing-runtime");

    const firstBytes = await fs.readFile(storePath, "utf8");
    const rerun = await rerunAutomaticMigrationAfterRestart({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(rerun.skipped).toBe(false);
    expect(rerun.warnings).toEqual([]);
    await expect(fs.readFile(storePath, "utf8")).resolves.toBe(firstBytes);
    expect(rerun.changes).not.toContain(
      "Migrated 1 ACP session metadata row → shared SQLite state",
    );
  });

  it("migrates existing and imported ACP metadata in one canonical session phase", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const storeTemplate = path.join(
      stateDir,
      "agents",
      "{agentId}",
      "..",
      "main",
      "sessions",
      "sessions.json",
    );
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify({
        "agent:main:existing": {
          sessionId: "existing-main",
          updatedAt: 20,
          acp: {
            backend: "test",
            agent: "main",
            runtimeSessionName: "existing-runtime",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 20,
          },
        },
      }),
      "utf8",
    );
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    await fs.mkdir(path.dirname(legacyStorePath), { recursive: true });
    await fs.writeFile(
      legacyStorePath,
      JSON.stringify({
        "agent:voice:main": {
          sessionId: "voice-main",
          updatedAt: 10,
          acp: {
            backend: "test",
            agent: "voice",
            runtimeSessionName: "voice-runtime",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 10,
          },
        },
      }),
      "utf8",
    );
    const cfg = {
      session: { mainKey: "desk", store: storeTemplate },
      agents: { list: [{ id: "main", default: true }, { id: "voice" }] },
    } as OpenClawConfig;

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    expect(
      readAcpSessionMetaForEntry({
        sessionKey: "agent:main:existing",
        entry: { sessionId: "existing-main", lifecycleRevision: undefined },
        env,
      })?.runtimeSessionName,
    ).toBe("existing-runtime");
    expect(
      readAcpSessionMetaForEntry({
        sessionKey: "agent:voice:desk",
        entry: { sessionId: "voice-main", lifecycleRevision: undefined },
        env,
      })?.runtimeSessionName,
    ).toBe("voice-runtime");
    expect(
      readAcpSessionMetaForEntry({
        sessionKey: "agent:voice:main",
        entry: { sessionId: "voice-main", lifecycleRevision: undefined },
        env,
      }),
    ).toBeUndefined();
    expect(result.changes).toContain("Migrated 2 ACP session metadata rows → shared SQLite state");
  });

  it("migrates legacy delivery queue files into shared SQLite state", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    await fs.mkdir(path.join(stateDir, "delivery-queue"), { recursive: true });
    await fs.mkdir(path.join(stateDir, "delivery-queue", "failed"), { recursive: true });
    await fs.mkdir(path.join(stateDir, "session-delivery-queue"), { recursive: true });
    await fs.mkdir(path.join(stateDir, "session-delivery-queue", "failed"), { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "delivery-queue", "outbound-1.json"),
      JSON.stringify({
        id: "outbound-1",
        enqueuedAt: 10,
        retryCount: 2,
        channel: "telegram",
        to: "123",
        accountId: "main",
        lastAttemptAt: 1.5,
        platformSendStartedAt: Number.MAX_SAFE_INTEGER + 1,
        payloads: [{ text: "hi" }],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(stateDir, "session-delivery-queue", "session-1.json"),
      JSON.stringify({
        id: "session-1",
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "resume",
        messageId: "m1",
        retryCount: 0,
        enqueuedAt: 20,
        lastAttemptAt: 21,
        platformSendStartedAt: 22,
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(stateDir, "delivery-queue", "failed", "outbound-failed.json"),
      JSON.stringify({
        id: "outbound-failed",
        enqueuedAt: 30,
        retryCount: 3,
        channel: "telegram",
        to: "456",
        lastError: "permanent",
        retainOnFailure: true,
        payloads: [{ text: "nope" }],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(stateDir, "session-delivery-queue", "failed", "session-failed.json"),
      JSON.stringify({
        id: "session-failed",
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "failed resume",
        lastError: "expired",
        retryCount: 3,
        enqueuedAt: 40,
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.deliveryQueues.hasLegacy).toBe(true);

    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(
      "Migrated 2 outbound delivery queue entries → shared SQLite state",
    );
    expect(result.changes).toContain(
      "Migrated 1 session delivery queue entry → shared SQLite state",
    );
    const { db } = openOpenClawStateDatabase({ env });
    const rows = db
      .prepare(
        "SELECT queue_name, id, status, channel, target, retry_count FROM delivery_queue_entries ORDER BY queue_name, id",
      )
      .all();
    expect(rows).toEqual([
      {
        queue_name: "outbound",
        id: "outbound-1",
        status: "pending",
        channel: "telegram",
        target: "123",
        retry_count: 2,
      },
      {
        queue_name: "outbound",
        id: "outbound-failed",
        status: "failed",
        channel: null,
        target: null,
        retry_count: 3,
      },
      {
        queue_name: "session",
        id: "session-1",
        status: "pending",
        channel: null,
        target: null,
        retry_count: 0,
      },
    ]);
    expect(
      db
        .prepare(
          `SELECT id, last_attempt_at, platform_send_started_at
             FROM delivery_queue_entries
            WHERE status = 'pending'
            ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { id: "outbound-1", last_attempt_at: null, platform_send_started_at: null },
      { id: "session-1", last_attempt_at: 21, platform_send_started_at: 22 },
    ]);
    expect(
      db
        .prepare(
          `SELECT entry_kind, session_key, account_id, last_attempt_at, last_error,
                  recovery_state, platform_send_started_at, entry_json, failed_at
             FROM delivery_queue_entries
            WHERE status = 'failed'
            ORDER BY queue_name, id`,
        )
        .all(),
    ).toEqual([
      {
        entry_kind: null,
        session_key: null,
        account_id: null,
        last_attempt_at: null,
        last_error: null,
        recovery_state: "completed_permanent",
        platform_send_started_at: null,
        entry_json: JSON.stringify({
          id: "outbound-failed",
          enqueuedAt: 30,
          retryCount: 3,
          failedAt: 30,
          completionRetention: "permanent",
          recoveryState: "completed_permanent",
        }),
        failed_at: 30,
      },
    ]);
    await expectMissingPath(path.join(stateDir, "delivery-queue"));
    await expectMissingPath(path.join(stateDir, "session-delivery-queue"));
  });

  it("migrates legacy voice wake JSON settings into shared SQLite state", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const settingsDir = path.join(stateDir, "settings");
    const triggersPath = path.join(settingsDir, "voicewake.json");
    const routingPath = path.join(settingsDir, "voicewake-routing.json");
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(
      triggersPath,
      JSON.stringify({ triggers: ["  wake ", "", "there"], updatedAtMs: -1 }),
      "utf8",
    );
    await fs.writeFile(
      routingPath,
      JSON.stringify({
        defaultTarget: { mode: "current" },
        routes: [
          { trigger: "  Robot   Wake ", target: { agentId: "Main Agent" } },
          { trigger: "", target: { sessionKey: "agent:main:voice" } },
        ],
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.voiceWake.hasLegacy).toBe(true);
    expect(detected.preview).toContain(
      "- Voice Wake settings: legacy JSON files → shared SQLite state",
    );

    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 2 voice wake triggers → shared SQLite state");
    expect(result.changes).toContain(
      "Migrated voice wake routing config with 1 route → shared SQLite state",
    );
    await expect(loadVoiceWakeConfig(stateDir)).resolves.toMatchObject({
      triggers: ["wake", "there"],
    });
    await expect(loadVoiceWakeRoutingConfig(stateDir)).resolves.toMatchObject({
      defaultTarget: { mode: "current" },
      routes: [{ trigger: "robot wake", target: { agentId: "main-agent" } }],
    });
    await expectMissingPath(triggersPath);
    await expectMissingPath(routingPath);
    await expect(fs.readFile(`${triggersPath}.migrated`, "utf8")).resolves.toContain("wake");
    await expect(fs.readFile(`${routingPath}.migrated`, "utf8")).resolves.toContain("Robot");
  });

  it("archives legacy voice wake JSON when shared SQLite already matches", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const settingsDir = path.join(stateDir, "settings");
    const triggersPath = path.join(settingsDir, "voicewake.json");
    const routingPath = path.join(settingsDir, "voicewake-routing.json");
    await setVoiceWakeTriggers(["wake"], stateDir);
    seedCanonicalVoiceWakeRouting(stateDir, "robot wake");
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(triggersPath, JSON.stringify({ triggers: ["wake"] }), "utf8");
    await fs.writeFile(
      routingPath,
      JSON.stringify({
        defaultTarget: { mode: "current" },
        routes: [{ trigger: "robot wake", target: { agentId: "main" } }],
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    await expectMissingPath(triggersPath);
    await expectMissingPath(routingPath);
    await expect(fs.readFile(`${triggersPath}.migrated`, "utf8")).resolves.toContain("wake");
    await expect(fs.readFile(`${routingPath}.migrated`, "utf8")).resolves.toContain("robot wake");
  });

  it("archives divergent legacy voice wake triggers and keeps shared SQLite canonical", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const cfg = createConfig();
    const triggersPath = path.join(stateDir, "settings", "voicewake.json");
    await setVoiceWakeTriggers(["sqlite wake"], stateDir);
    await fs.mkdir(path.dirname(triggersPath), { recursive: true });
    await fs.writeFile(triggersPath, JSON.stringify({ triggers: ["legacy wake"] }), "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: createEnv(stateDir),
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.notices).toEqual([
      `Kept shared SQLite voice wake triggers because legacy file differs: ${triggersPath}`,
    ]);
    await expect(loadVoiceWakeConfig(stateDir)).resolves.toMatchObject({
      triggers: ["sqlite wake"],
    });
    await expectMissingPath(triggersPath);
    await expect(fs.readFile(`${triggersPath}.migrated`, "utf8")).resolves.toContain("legacy wake");
  });

  it("keeps a failed voice wake triggers archive blocking and converges on retry", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const cfg = createConfig();
    const triggersPath = path.join(stateDir, "settings", "voicewake.json");
    await setVoiceWakeTriggers(["sqlite wake"], stateDir);
    await fs.mkdir(path.dirname(triggersPath), { recursive: true });
    await fs.writeFile(triggersPath, JSON.stringify({ triggers: ["legacy wake"] }), "utf8");

    const rename = failArchiveRenameOnce(triggersPath);
    const detected = await detectLegacyStateMigrations({
      cfg,
      env: createEnv(stateDir),
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({ detected, config: cfg });
    rename.mockRestore();

    expect(result.warnings).toStrictEqual([
      `Failed archiving voice wake triggers legacy source ${triggersPath}: Error: forced archive failure`,
    ]);
    expect(result.notices).toEqual([
      `Kept shared SQLite voice wake triggers because legacy file differs: ${triggersPath}`,
    ]);
    await expect(fs.readFile(triggersPath, "utf8")).resolves.toContain("legacy wake");
    await expectMissingPath(`${triggersPath}.migrated`);

    const retryDetected = await detectLegacyStateMigrations({
      cfg,
      env: createEnv(stateDir),
      homedir: () => root,
    });
    const retry = await runLegacyStateMigrations({ detected: retryDetected, config: cfg });
    expect(retry.warnings).toStrictEqual([]);
    await expectMissingPath(triggersPath);
  });

  it("leaves malformed legacy voice wake triggers in place with a warning", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const cfg = createConfig();
    const triggersPath = path.join(stateDir, "settings", "voicewake.json");
    await fs.mkdir(path.dirname(triggersPath), { recursive: true });
    await fs.writeFile(triggersPath, "{ malformed", "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: createEnv(stateDir),
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Failed reading legacy voice wake triggers");
    expect(result.notices).toBeUndefined();
    await expect(fs.access(triggersPath)).resolves.toBeUndefined();
    await expectMissingPath(`${triggersPath}.migrated`);
  });

  it("archives divergent legacy voice wake routing and keeps shared SQLite canonical", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const cfg = createConfig();
    const routingPath = path.join(stateDir, "settings", "voicewake-routing.json");
    seedCanonicalVoiceWakeRouting(stateDir, "sqlite wake");
    await fs.mkdir(path.dirname(routingPath), { recursive: true });
    await fs.writeFile(
      routingPath,
      JSON.stringify({
        defaultTarget: { mode: "current" },
        routes: [{ trigger: "legacy wake", target: { agentId: "main" } }],
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: createEnv(stateDir),
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.notices).toEqual([
      `Kept shared SQLite voice wake routing because legacy file differs: ${routingPath}`,
    ]);
    await expect(loadVoiceWakeRoutingConfig(stateDir)).resolves.toMatchObject({
      routes: [{ trigger: "sqlite wake", target: { agentId: "main" } }],
    });
    await expectMissingPath(routingPath);
    await expect(fs.readFile(`${routingPath}.migrated`, "utf8")).resolves.toContain("legacy wake");
  });

  it("keeps a failed voice wake routing archive blocking and converges on retry", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const cfg = createConfig();
    const routingPath = path.join(stateDir, "settings", "voicewake-routing.json");
    seedCanonicalVoiceWakeRouting(stateDir, "sqlite wake");
    await fs.mkdir(path.dirname(routingPath), { recursive: true });
    await fs.writeFile(
      routingPath,
      JSON.stringify({
        defaultTarget: { mode: "current" },
        routes: [{ trigger: "legacy wake", target: { agentId: "main" } }],
      }),
      "utf8",
    );

    const rename = failArchiveRenameOnce(routingPath);
    const detected = await detectLegacyStateMigrations({
      cfg,
      env: createEnv(stateDir),
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({ detected, config: cfg });
    rename.mockRestore();

    expect(result.warnings).toStrictEqual([
      `Failed archiving voice wake routing legacy source ${routingPath}: Error: forced archive failure`,
    ]);
    expect(result.notices).toEqual([
      `Kept shared SQLite voice wake routing because legacy file differs: ${routingPath}`,
    ]);
    await expect(fs.readFile(routingPath, "utf8")).resolves.toContain("legacy wake");
    await expectMissingPath(`${routingPath}.migrated`);

    const retryDetected = await detectLegacyStateMigrations({
      cfg,
      env: createEnv(stateDir),
      homedir: () => root,
    });
    const retry = await runLegacyStateMigrations({ detected: retryDetected, config: cfg });
    expect(retry.warnings).toStrictEqual([]);
    await expectMissingPath(routingPath);
  });

  it("leaves malformed legacy voice wake routing in place with a warning", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const cfg = createConfig();
    const routingPath = path.join(stateDir, "settings", "voicewake-routing.json");
    await fs.mkdir(path.dirname(routingPath), { recursive: true });
    await fs.writeFile(routingPath, "{ malformed", "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: createEnv(stateDir),
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Failed reading legacy voice wake routing");
    expect(result.notices).toBeUndefined();
    await expect(fs.access(routingPath)).resolves.toBeUndefined();
    await expectMissingPath(`${routingPath}.migrated`);
  });

  it("auto-migrates standalone legacy JSON settings", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const settingsDir = path.join(stateDir, "settings");
    await fs.mkdir(settingsDir, { recursive: true });
    await fs.writeFile(
      path.join(settingsDir, "voicewake.json"),
      JSON.stringify({ triggers: ["wake"] }),
      "utf8",
    );
    const expectedSentinel = {
      kind: "update" as const,
      status: "ok" as const,
      ts: 321,
      message: "Update completed",
    };
    const restartSentinelPath = path.join(stateDir, "restart-sentinel.json");
    await fs.writeFile(
      restartSentinelPath,
      `${JSON.stringify({ version: 1, payload: expectedSentinel })}\n`,
      "utf8",
    );

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

    expect(result.skipped).toBe(false);
    expect(result.migrated).toBe(true);
    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(
      "Imported the legacy restart sentinel into shared SQLite state.",
    );
    await expect(loadVoiceWakeConfig(stateDir)).resolves.toMatchObject({ triggers: ["wake"] });
    await expect(readRestartSentinel(env)).resolves.toMatchObject({ payload: expectedSentinel });
    await expectMissingPath(path.join(settingsDir, "voicewake.json"));
    await expectMissingPath(restartSentinelPath);
  });

  it("runs plugin doctor migrations after repairing shared state schema", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const stateDbPath = path.join(stateDir, "state", "openclaw.sqlite");
    await fs.mkdir(path.dirname(stateDbPath), { recursive: true });
    const db = new DatabaseSync(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE agent_databases (
          agent_id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          size_bytes INTEGER
        );
        INSERT INTO agent_databases VALUES ('main', 'agent.sqlite', 1, 10, 20);
      `);
    } finally {
      db.close();
    }
    const migrateLegacyState = vi.fn(() => ({
      changes: ["plugin state migrated"],
      warnings: [],
    }));
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-test",
          label: "Memory Core test migration",
          detectLegacyState: () => ({ preview: ["plugin state"] }),
          migrateLegacyState,
        },
      },
    ];

    const result = await autoMigrateLegacyPluginDoctorState({
      config: cfg,
      env,
      homedir: () => root,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(
      "Migrated shared state agent database registry primary key → agent_id,path",
    );
    expect(result.changes).toContain("plugin state migrated");
    expect(migrateLegacyState).toHaveBeenCalledOnce();
  });

  it("previews and repairs the released audit ledger before other state migrations", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const databasePath = await createLegacyAuditLedger(stateDir);
    const cfg = createConfig();

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.preview.filter((line) => line.startsWith("- Shared SQLite schema:"))).toEqual([
      "- Shared SQLite schema: audit event ledger → versioned message lifecycle schema",
      "- Shared SQLite schema: tables → SQLite STRICT typing",
    ]);

    const result = await runLegacyStateMigrations({ detected, config: cfg, env });
    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(
      "Migrated shared state audit event ledger → versioned message lifecycle schema",
    );

    closeOpenClawStateDatabaseForTest();
    const db = new DatabaseSync(databasePath);
    try {
      expect(
        db
          .prepare(
            "SELECT sequence, event_id, source_id, schema_version FROM audit_events WHERE event_id = ?",
          )
          .get("event-before-v2"),
      ).toEqual({
        sequence: 3,
        event_id: "event-before-v2",
        source_id: "run-before-v2:1:100:agent.run.started",
        schema_version: 1,
      });
      expect(db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        db
          .prepare(
            "SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1",
          )
          .get(),
      ).toEqual({
        role: "global",
        schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
    } finally {
      db.close();
    }

    const after = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(after.preview).not.toContain(
      "- Shared SQLite schema: audit event ledger → versioned message lifecycle schema",
    );
  });

  it("repairs shared SQLite before discarding retired commitments JSON", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    await createLegacyAuditLedger(stateDir);
    const sourcePath = path.join(stateDir, "commitments", "commitments.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({ version: 1, commitments: [{ id: "retired" }] }),
      "utf8",
    );
    const cfg = createConfig();

    const runtime = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(runtime.commitments?.hasLegacy).toBe(false);
    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(detected.preview).toContain(
      "- Commitments: discard retired commitments/commitments.json rows without import, archive, or export",
    );

    const result = await runLegacyStateMigrations({ detected, config: cfg, env });

    expect(result.warnings).toStrictEqual([]);
    const schemaChange = result.changes.indexOf(
      "Migrated shared state audit event ledger → versioned message lifecycle schema",
    );
    const discardChange = result.changes.indexOf(
      "Discarded retired commitments JSON with 1 row; no data was imported, archived, or exported.",
    );
    expect(schemaChange).toBeGreaterThanOrEqual(0);
    expect(discardChange).toBeGreaterThan(schemaChange);
    await expectMissingPath(sourcePath);
    expect(
      openOpenClawStateDatabase({ env })
        .db.prepare(
          "SELECT removed_source FROM migration_sources WHERE migration_kind = 'legacy-commitments-json'",
        )
        .get(),
    ).toEqual({ removed_source: 1 });
  });

  it("doctor discards worktree rows that predate the provisioned-file ledger", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const db = openOpenClawStateDatabase({ env }).db;
    db.prepare(
      `INSERT INTO worktrees (
        id, repo_fingerprint, repo_root, path, branch, base_ref, owner_kind,
        created_at, last_active_at, provisioned_paths_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      "legacy-worktree",
      "legacy-fingerprint",
      path.join(root, "repo"),
      path.join(stateDir, "worktrees", "legacy"),
      "openclaw/legacy",
      "HEAD",
      "session",
      1,
      1,
    );

    const runtime = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(runtime.preview).not.toContain(
      "- Managed worktrees: discard rows without provisioned-file ledgers",
    );
    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(detected.preview).toContain(
      "- Managed worktrees: discard rows without provisioned-file ledgers",
    );

    const result = await runLegacyStateMigrations({ detected, config: cfg, env });
    expect(result.changes).toContain(
      "Discarded 1 legacy managed worktree row; affected worktrees will provision fresh on next use",
    );
    expect(
      db.prepare("SELECT id FROM worktrees WHERE id = ?").get("legacy-worktree"),
    ).toBeUndefined();
  });

  it("does not run plugin doctor migrations after shared state schema repair fails", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const stateDbPath = path.join(stateDir, "state", "openclaw.sqlite");
    await fs.mkdir(path.dirname(stateDbPath), { recursive: true });
    const db = new DatabaseSync(stateDbPath);
    try {
      db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    } finally {
      db.close();
    }
    const detectLegacyState = vi.fn(() => ({ preview: ["plugin state"] }));
    const migrateLegacyState = vi.fn(() => ({
      changes: ["plugin state migrated"],
      warnings: [],
    }));
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-schema-failure-test",
          label: "Memory Core schema failure test migration",
          detectLegacyState,
          migrateLegacyState,
        },
      },
    ];

    await expect(
      autoMigrateLegacyPluginDoctorState({
        config: cfg,
        env,
        homedir: () => root,
      }),
    ).rejects.toThrow("Failed migrating shared state database schema");
    expect(detectLegacyState).not.toHaveBeenCalled();
    expect(migrateLegacyState).not.toHaveBeenCalled();
  });

  it("does not mutate other legacy state after shared schema repair fails", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const stateDbPath = path.join(stateDir, "state", "openclaw.sqlite");
    const voiceWakePath = path.join(stateDir, "settings", "voicewake.json");
    await fs.mkdir(path.dirname(stateDbPath), { recursive: true });
    await fs.mkdir(path.dirname(voiceWakePath), { recursive: true });
    await fs.writeFile(voiceWakePath, JSON.stringify({ triggers: ["leave-me"] }), "utf8");
    const db = new DatabaseSync(stateDbPath);
    try {
      db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    } finally {
      db.close();
    }

    await expect(autoMigrateLegacyState({ cfg, env, homedir: () => root })).rejects.toThrow(
      "Failed migrating shared state database schema",
    );
    await expect(fs.readFile(voiceWakePath, "utf8")).resolves.toContain("leave-me");
    await expect(fs.stat(`${voiceWakePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports plugin detector failures in read-only legacy state detection", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = { ...createConfig(), agents: { list: 42 } } as unknown as OpenClawConfig;
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "msteams",
        migration: {
          id: "msteams-readonly-malformed-config-test",
          label: "Microsoft Teams readonly malformed config test migration",
          detectLegacyState: () => {
            throw new TypeError("config.agents.list is not iterable");
          },
          migrateLegacyState: vi.fn(() => ({ changes: [], warnings: [] })),
        },
      },
    ];

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });

    expect(detected.pluginPlans?.hasLegacy).toBe(false);
    expect(detected.warnings).toStrictEqual([
      "Failed detecting Microsoft Teams readonly malformed config test migration: TypeError: config.agents.list is not iterable",
    ]);
  });

  it("continues plugin doctor migrations when one detector rejects malformed config", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = { ...createConfig(), agents: { list: 42 } } as unknown as OpenClawConfig;
    const migrateLegacyState = vi.fn(() => ({
      changes: ["healthy plugin state migrated"],
      warnings: [],
    }));
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "msteams",
        migration: {
          id: "msteams-malformed-config-test",
          label: "Microsoft Teams malformed config test migration",
          detectLegacyState: () => {
            throw new TypeError("config.agents.list is not iterable");
          },
          migrateLegacyState: vi.fn(() => ({ changes: [], warnings: [] })),
        },
      },
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-healthy-config-test",
          label: "Memory Core healthy config test migration",
          detectLegacyState: () => ({ preview: ["healthy plugin state"] }),
          migrateLegacyState,
        },
      },
    ];

    const result = await autoMigrateLegacyPluginDoctorState({
      config: cfg,
      env,
      homedir: () => root,
    });

    expect(result.warnings).toStrictEqual([
      "Failed detecting Microsoft Teams malformed config test migration: TypeError: config.agents.list is not iterable",
    ]);
    expect(result.changes).toContain("healthy plugin state migrated");
    expect(migrateLegacyState).toHaveBeenCalledOnce();
  });

  it("requires exclusive state ownership before plugin doctor migrations", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    openOpenClawStateDatabase({ env });
    closeOpenClawStateDatabaseForTest();
    const migrateLegacyState = vi.fn(() => ({
      changes: ["plugin state migrated"],
      warnings: [],
    }));
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-lock-test",
          label: "Memory Core lock test migration",
          detectLegacyState: () => ({ preview: ["plugin state"] }),
          migrateLegacyState,
        },
      },
    ];
    const gatewayLock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: 10,
      port: 18_791,
      timeoutMs: 100,
    });
    if (!gatewayLock) {
      throw new Error("expected test Gateway lock");
    }

    let result: Awaited<ReturnType<typeof autoMigrateLegacyPluginDoctorState>>;
    try {
      result = await autoMigrateLegacyPluginDoctorState({
        config: cfg,
        env,
        homedir: () => root,
      });
    } finally {
      await gatewayLock.release();
    }

    expect(result.changes).not.toContain("plugin state migrated");
    expect(result.warnings.join("\n")).toContain("exclusive state ownership is unavailable");
    expect(migrateLegacyState).not.toHaveBeenCalled();
  });

  it("skips stale plugin doctor plans when refresh detection fails", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const migrateLegacyState = vi.fn(() => ({
      changes: ["stale plugin state migrated"],
      warnings: [],
    }));
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-stale-plan-test",
          label: "Memory Core stale plan test migration",
          detectLegacyState: () => ({ preview: ["stale plugin state"] }),
          migrateLegacyState,
        },
      },
    ];
    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.pluginPlans?.hasLegacy).toBe(true);

    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-stale-plan-test",
          label: "Memory Core stale plan test migration",
          detectLegacyState: () => {
            throw new TypeError("config.agents.list is not iterable");
          },
          migrateLegacyState,
        },
      },
    ];

    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toContain(
      "Failed detecting Memory Core stale plan test migration: TypeError: config.agents.list is not iterable",
    );
    expect(result.changes).not.toContain("stale plugin state migrated");
    expect(migrateLegacyState).not.toHaveBeenCalled();
  });

  it("runs plugin doctor migrations against the canonical state dir after state-dir repair", async () => {
    const root = await createTempDir();
    const legacyStateDir = path.join(root, ".clawdbot");
    const canonicalStateDir = path.join(root, ".openclaw");
    await fs.mkdir(legacyStateDir, { recursive: true });
    await fs.writeFile(path.join(legacyStateDir, "legacy.txt"), "legacy", "utf8");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root };
    delete env.OPENCLAW_STATE_DIR;
    const cfg = createConfig();
    const detectedStateDirs: string[] = [];
    const migratedStateDirs: string[] = [];
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-state-dir-test",
          label: "Memory Core state dir test migration",
          detectLegacyState: ({ stateDir }) => {
            detectedStateDirs.push(stateDir);
            return { preview: ["plugin state"] };
          },
          migrateLegacyState: ({ stateDir }) => {
            migratedStateDirs.push(stateDir);
            return { changes: ["plugin state migrated"], warnings: [] };
          },
        },
      },
    ];

    const result = await autoMigrateLegacyPluginDoctorState({
      config: cfg,
      env,
      homedir: () => root,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("plugin state migrated");
    expect(detectedStateDirs).toStrictEqual([canonicalStateDir]);
    expect(migratedStateDirs).toStrictEqual([canonicalStateDir]);
    await expect(fs.access(path.join(canonicalStateDir, "legacy.txt"))).resolves.toBeUndefined();
  });

  it("routes explicit Doctor repair through the APNs SQLite importer", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const pushDir = path.join(stateDir, "push");
    const sourcePath = path.join(pushDir, "apns-registrations.json");
    await fs.mkdir(pushDir, { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        registrationsByNodeId: {
          "doctor-ios-node": {
            nodeId: "doctor-ios-node",
            [APNS_DEVICE_FIELD]: "abcd1234abcd1234abcd1234abcd1234",
            topic: "ai.openclaw.ios",
            environment: "sandbox",
            updatedAtMs: 1,
          },
        },
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(detected.apns.hasLegacy).toBe(true);
    expect(detected.preview).toContain("- APNs registrations: legacy JSON → shared SQLite state");

    const result = await runLegacyStateMigrations({ detected, config: cfg, env });

    expect(result.warnings).toStrictEqual([]);
    await expect(loadApnsRegistration("doctor-ios-node", stateDir)).resolves.toMatchObject({
      nodeId: "doctor-ios-node",
      transport: "direct",
    });
    await expectMissingPath(sourcePath);
  });

  it("routes explicit Doctor repair through the ACP replay SQLite importer", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const sourcePath = path.join(stateDir, "acp", "event-ledger.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        sessions: {
          "doctor-acp-session": {
            sessionId: "doctor-acp-session",
            sessionKey: "agent:main:doctor-acp",
            cwd: "/work",
            complete: true,
            createdAt: 1,
            updatedAt: 2,
            nextSeq: 2,
            events: [
              {
                seq: 1,
                at: 2,
                sessionId: "doctor-acp-session",
                sessionKey: "agent:main:doctor-acp",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "Doctor import" },
                },
              },
            ],
          },
        },
      }),
      "utf8",
    );

    const runtimeDetection = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    expect(runtimeDetection.acpReplayLedger.hasLegacy).toBe(false);

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(detected.acpReplayLedger.hasLegacy).toBe(true);
    expect(detected.preview).toContain(
      "- ACP replay ledger: legacy JSON file → shared SQLite state",
    );

    const result = await runLegacyStateMigrations({ detected, config: cfg, env });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(
      "Migrated 1 ACP replay session(s) and 1 event(s) → shared SQLite state",
    );
    const row = openOpenClawStateDatabase({ env })
      .db.prepare(
        "SELECT session_key, estimated_bytes FROM acp_replay_sessions WHERE session_id = ?",
      )
      .get("doctor-acp-session") as
      | { session_key: string; estimated_bytes: number | bigint }
      | undefined;
    expect(row?.session_key).toBe("agent:main:doctor-acp");
    expect(Number(row?.estimated_bytes ?? 0)).toBeGreaterThan(0);
    await expectMissingPath(sourcePath);
  });

  it("routes explicit Doctor repair through the Web Push SQLite importer", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const endpoint = "https://push.example.com/doctor-integration";
    const subscription = {
      subscriptionId: "c0a80101-0000-4000-8000-000000000001",
      endpoint,
      keys: { p256dh: "doctor-p256dh", auth: "doctor-auth" },
      createdAtMs: 1,
      updatedAtMs: 2,
    };
    const pushDir = path.join(stateDir, "push");
    const subscriptionsPath = path.join(pushDir, "web-push-subscriptions.json");
    const vapidKeysPath = path.join(pushDir, "vapid-keys.json");
    await fs.mkdir(pushDir, { recursive: true });
    await fs.writeFile(
      subscriptionsPath,
      JSON.stringify({
        subscriptionsByEndpointHash: {
          [hashWebPushEndpoint(endpoint)]: subscription,
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      vapidKeysPath,
      JSON.stringify(
        createWebPushVapidKeyPair("doctor-public", "doctor-private", "https://openclaw.ai"),
      ),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(detected.webPush.hasLegacy).toBe(true);
    expect(detected.preview).toContain(
      "- Web Push subscriptions and VAPID identity: legacy JSON → shared SQLite state",
    );

    const result = await runLegacyStateMigrations({ detected, config: cfg, env });

    expect(result.warnings).toStrictEqual([]);
    expect(listWebPushSubscriptions(stateDir)).toStrictEqual([subscription]);
    expect(readPersistedVapidKeyPair(stateDir)).toStrictEqual(
      createWebPushVapidKeyPair("doctor-public", "doctor-private", "https://openclaw.ai"),
    );
    await expectMissingPath(subscriptionsPath);
    await expectMissingPath(vapidKeysPath);
  });

  it("routes explicit Doctor repair through the node-host SQLite importer", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const sourcePath = path.join(stateDir, "node.json");
    const fixtureDigest = ["fixture", "digest"].join("-");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        nodeId: "doctor-node",
        token: "test-token-placeholder",
        displayName: "Doctor Node",
        gateway: {
          host: "gateway.example",
          port: 18443,
          tls: true,
          tlsFingerprint: fixtureDigest,
          contextPath: "/doctor",
        },
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(detected.nodeHost.hasLegacy).toBe(true);
    expect(detected.preview).toContain(
      "- Node-host config: legacy node.json → shared SQLite state",
    );

    const result = await runLegacyStateMigrations({ detected, config: cfg, env });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated node-host config to shared SQLite state.");
    await expect(loadNodeHostConfig(env)).resolves.toStrictEqual({
      version: 1,
      nodeId: "doctor-node",
      displayName: "Doctor Node",
      gateway: {
        host: "gateway.example",
        port: 18443,
        tls: true,
        tlsFingerprint: fixtureDigest,
        contextPath: "/doctor",
      },
      installedAppsSharing: false,
    });
    await expectMissingPath(sourcePath);
  });

  it("previews retired subagent JSON as discard-only transient state", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const sourcePath = path.join(stateDir, "subagents", "runs.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, JSON.stringify({ version: 2, runs: {} }), "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg: createConfig(),
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    expect(detected.preview).toContain(
      "- Subagent runs: discard retired transient subagents/runs.json state",
    );
  });

  it("migrates legacy update-check JSON into shared SQLite state", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const sourcePath = path.join(stateDir, "update-check.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        lastCheckedAt: "2026-01-17T09:30:00.000Z",
        lastAvailableVersion: "2.0.0",
        lastAvailableTag: "latest",
        autoInstallId: "install-1",
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.updateCheck.hasLegacy).toBe(true);
    expect(detected.preview).toContain(
      "- Update-check state: legacy JSON file → shared SQLite state",
    );

    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated update-check state → shared SQLite state");
    expect(readUpdateCheckState(env)).toMatchObject({
      lastCheckedAt: "2026-01-17T09:30:00.000Z",
      lastAvailableVersion: "2.0.0",
      lastAvailableTag: "latest",
      autoInstallId: "install-1",
    });
    await expectMissingPath(sourcePath);
    await expect(fs.readFile(`${sourcePath}.migrated`, "utf8")).resolves.toContain("2.0.0");

    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        lastCheckedAt: "2026-01-18T09:30:00.000Z",
        lastAvailableVersion: "3.0.0",
        lastAvailableTag: "latest",
      }),
      "utf8",
    );
    const conflictResult = await runLegacyStateMigrations({ detected, config: cfg });
    expect(conflictResult.warnings).toStrictEqual([]);
    expect(conflictResult.notices).toEqual([
      expect.stringContaining("Kept shared SQLite update-check state because legacy cache differs"),
    ]);
    expect(readUpdateCheckState(env)?.lastAvailableVersion).toBe("2.0.0");
    await expectMissingPath(sourcePath);
    await expect(fs.readFile(`${sourcePath}.migrated.2`, "utf8")).resolves.toContain("3.0.0");

    const convergedResult = await runLegacyStateMigrations({ detected, config: cfg });
    expect(convergedResult.warnings).toStrictEqual([]);
    expect(convergedResult.notices).toBeUndefined();
  });

  it("migrates legacy config health JSON into shared SQLite state", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const configPath = path.join(stateDir, "openclaw.json");
    const logsDir = path.join(stateDir, "logs");
    const sourcePath = path.join(logsDir, "config-health.json");
    const fingerprint = {
      hash: "abc123",
      bytes: 42,
      mtimeMs: 1,
      ctimeMs: 2,
      dev: "3",
      ino: "4",
      mode: 384,
      nlink: 1,
      uid: 501,
      gid: 20,
      hasMeta: true,
      gatewayMode: "local",
      observedAt: "2026-01-17T09:30:00.000Z",
    };
    await fs.mkdir(logsDir, { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        entries: {
          [configPath]: {
            lastKnownGood: fingerprint,
            lastPromotedGood: fingerprint,
            lastObservedSuspiciousSignature: "abc123:size-drop",
          },
        },
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.configHealth.hasLegacy).toBe(true);
    expect(detected.preview).toContain(
      "- Config health state: legacy JSON file → shared SQLite state",
    );

    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 1 config health entry → shared SQLite state");
    expect(readConfigHealthRows(env)).toEqual([
      {
        config_path: configPath,
        last_known_good_json: JSON.stringify(fingerprint),
        last_promoted_good_json: JSON.stringify(fingerprint),
        last_observed_suspicious_signature: "abc123:size-drop",
      },
    ]);
    await expectMissingPath(sourcePath);
    await expect(fs.readFile(`${sourcePath}.migrated`, "utf8")).resolves.toContain("abc123");
  });

  it("reconciles missing promoted config health state without replacing current SQLite fields", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const configPath = path.join(stateDir, "openclaw.json");
    const importedConfigPath = path.join(stateDir, "imported.json");
    const sourcePath = path.join(stateDir, "logs", "config-health.json");
    const legacyFingerprint = { hash: "legacy", bytes: 10 };
    const currentFingerprint = { hash: "current", bytes: 20 };
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        entries: {
          [configPath]: {
            lastKnownGood: legacyFingerprint,
            lastPromotedGood: legacyFingerprint,
            lastObservedSuspiciousSignature: "legacy:size-drop",
          },
          [importedConfigPath]: {
            lastKnownGood: legacyFingerprint,
            lastPromotedGood: legacyFingerprint,
          },
        },
      }),
      "utf8",
    );
    insertConfigHealthRow(env, {
      config_path: configPath,
      last_known_good_json: JSON.stringify(currentFingerprint),
      last_promoted_good_json: null,
      last_observed_suspicious_signature: null,
    });

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 1 config health entry → shared SQLite state");
    expect(result.changes).toContain("Reconciled 1 config health entry → shared SQLite state");
    expect(readConfigHealthRows(env)).toEqual([
      {
        config_path: importedConfigPath,
        last_known_good_json: JSON.stringify(legacyFingerprint),
        last_promoted_good_json: JSON.stringify(legacyFingerprint),
        last_observed_suspicious_signature: null,
      },
      {
        config_path: configPath,
        last_known_good_json: JSON.stringify(currentFingerprint),
        last_promoted_good_json: JSON.stringify(legacyFingerprint),
        last_observed_suspicious_signature: null,
      },
    ]);
    await expectMissingPath(sourcePath);
    await expect(fs.readFile(`${sourcePath}.migrated`, "utf8")).resolves.toContain("legacy");
  });

  it("keeps complete SQLite config health state when legacy fingerprints differ", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const configPath = path.join(stateDir, "openclaw.json");
    const sourcePath = path.join(stateDir, "logs", "config-health.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        entries: {
          [configPath]: {
            lastKnownGood: { hash: "legacy-known" },
            lastPromotedGood: { hash: "legacy-promoted" },
            lastObservedSuspiciousSignature: "legacy:size-drop",
          },
        },
      }),
      "utf8",
    );
    insertConfigHealthRow(env, {
      config_path: configPath,
      last_known_good_json: JSON.stringify({ hash: "current-known" }),
      last_promoted_good_json: JSON.stringify({ hash: "current-promoted" }),
      last_observed_suspicious_signature: "current:size-drop",
    });

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes.some((change) => change.startsWith("Reconciled "))).toBe(false);
    expect(readConfigHealthRows(env)).toEqual([
      {
        config_path: configPath,
        last_known_good_json: JSON.stringify({ hash: "current-known" }),
        last_promoted_good_json: JSON.stringify({ hash: "current-promoted" }),
        last_observed_suspicious_signature: "current:size-drop",
      },
    ]);
    await expectMissingPath(sourcePath);
    await expect(fs.access(`${sourcePath}.migrated`)).resolves.toBeUndefined();
  });

  it("removes a regenerated config health source when its archive already exists", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const configPath = path.join(stateDir, "openclaw.json");
    const sourcePath = path.join(stateDir, "logs", "config-health.json");
    const archivedPath = `${sourcePath}.migrated`;
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({ entries: { [configPath]: { lastKnownGood: { hash: "legacy" } } } }),
      "utf8",
    );
    await fs.writeFile(archivedPath, "existing archive", "utf8");
    insertConfigHealthRow(env, {
      config_path: configPath,
      last_known_good_json: JSON.stringify({ hash: "current" }),
      last_promoted_good_json: JSON.stringify({ hash: "promoted" }),
      last_observed_suspicious_signature: null,
    });

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Removed regenerated config health legacy source");
    await expectMissingPath(sourcePath);
    await expect(fs.readFile(archivedPath, "utf8")).resolves.toBe("existing archive");
  });

  it("leaves malformed legacy config health state in place", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const cfg = createConfig();
    const sourcePath = path.join(stateDir, "logs", "config-health.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "{ malformed", "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: createEnv(stateDir),
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Failed reading legacy config health state");
    await expect(fs.access(sourcePath)).resolves.toBeUndefined();
    await expectMissingPath(`${sourcePath}.migrated`);
  });

  it("migrates legacy current-conversation bindings JSON into shared SQLite state", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const bindingsDir = path.join(stateDir, "bindings");
    const sourcePath = path.join(bindingsDir, "current-conversations.json");
    await fs.mkdir(bindingsDir, { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
            targetSessionKey: " agent:codex:acp:workspace-dm ",
            targetKind: "session",
            conversation: {
              channel: "workspace",
              accountId: "default",
              conversationId: "user:U123",
            },
            status: "active",
            boundAt: 1234,
            metadata: {
              label: "workspace-dm",
            },
          },
        ],
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.currentConversationBindings.hasLegacy).toBe(true);
    expect(detected.preview).toContain(
      "- Current-conversation bindings: legacy JSON file → shared SQLite state",
    );

    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(
      "Migrated 1 current-conversation binding → shared SQLite state",
    );
    const rows = readCurrentConversationBindingRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      binding_id: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      target_session_key: "agent:codex:acp:workspace-dm",
      channel: "workspace",
      account_id: "default",
      conversation_id: "user:U123",
    });
    expect(JSON.parse(rows[0]?.record_json ?? "{}")).toMatchObject({
      metadata: { label: "workspace-dm" },
    });
    await expectMissingPath(sourcePath);
    await expect(fs.readFile(`${sourcePath}.migrated`, "utf8")).resolves.toContain("workspace-dm");
  });

  it("migrates legacy plugin binding approvals JSON into shared SQLite state", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const sourcePath = path.join(stateDir, "plugin-binding-approvals.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        approvals: [
          {
            pluginRoot: "/plugins/codex-a",
            pluginId: "codex",
            pluginName: "Codex App Server",
            channel: "Discord",
            accountId: "default",
            approvedAt: 1234,
          },
        ],
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.pluginBindingApprovals.hasLegacy).toBe(true);
    expect(detected.preview).toContain(
      "- Plugin binding approvals: legacy JSON file → shared SQLite state",
    );

    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 1 plugin binding approval → shared SQLite state");
    expect(readPluginBindingApprovalRows(env)).toEqual([
      {
        plugin_root: "/plugins/codex-a",
        channel: "discord",
        account_id: "default",
        plugin_id: "codex",
        plugin_name: "Codex App Server",
        approved_at: 1234,
      },
    ]);
    await expectMissingPath(sourcePath);
    await expect(fs.readFile(`${sourcePath}.migrated`, "utf8")).resolves.toContain(
      "Codex App Server",
    );
  });

  it("archives conflicting plugin binding approvals without overwriting shared SQLite", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const sourcePath = path.join(stateDir, "plugin-binding-approvals.json");
    insertPluginBindingApprovalRow(env, {
      plugin_root: "/plugins/conflict",
      channel: "discord",
      account_id: "default",
      plugin_id: "sqlite-plugin",
      plugin_name: "SQLite Plugin",
      approved_at: 1,
    });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        approvals: [
          {
            pluginRoot: "/plugins/conflict",
            pluginId: "legacy-plugin",
            pluginName: "Legacy Plugin",
            channel: "discord",
            accountId: "default",
            approvedAt: 2,
          },
          {
            pluginRoot: "/plugins/import",
            pluginId: "imported-plugin",
            pluginName: "Imported Plugin",
            channel: "telegram",
            accountId: "default",
            approvedAt: 3,
          },
        ],
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.notices).toEqual([
      `Kept shared SQLite plugin binding approvals because 1 legacy approval conflicts: ${sourcePath}`,
    ]);
    expect(result.changes).toContain("Migrated 1 plugin binding approval → shared SQLite state");
    expect(readPluginBindingApprovalRows(env)).toEqual([
      {
        plugin_root: "/plugins/conflict",
        channel: "discord",
        account_id: "default",
        plugin_id: "sqlite-plugin",
        plugin_name: "SQLite Plugin",
        approved_at: 1,
      },
      {
        plugin_root: "/plugins/import",
        channel: "telegram",
        account_id: "default",
        plugin_id: "imported-plugin",
        plugin_name: "Imported Plugin",
        approved_at: 3,
      },
    ]);
    await expectMissingPath(sourcePath);
    await expect(fs.readFile(`${sourcePath}.migrated`, "utf8")).resolves.toContain("Legacy Plugin");
  });

  it("archives a legacy plugin binding approvals file when every approval conflicts", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const sourcePath = path.join(stateDir, "plugin-binding-approvals.json");
    insertPluginBindingApprovalRow(env, {
      plugin_root: "/plugins/conflict",
      channel: "discord",
      account_id: "default",
      plugin_id: "sqlite-plugin",
      plugin_name: "SQLite Plugin",
      approved_at: 1,
    });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        approvals: [
          {
            pluginRoot: "/plugins/conflict",
            pluginId: "legacy-plugin",
            pluginName: "Legacy Plugin",
            channel: "discord",
            accountId: "default",
            approvedAt: 2,
          },
        ],
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.notices).toEqual([
      `Kept shared SQLite plugin binding approvals because 1 legacy approval conflicts: ${sourcePath}`,
    ]);
    expect(result.changes.filter((change) => change.startsWith("Migrated"))).toStrictEqual([]);
    expect(readPluginBindingApprovalRows(env)).toEqual([
      {
        plugin_root: "/plugins/conflict",
        channel: "discord",
        account_id: "default",
        plugin_id: "sqlite-plugin",
        plugin_name: "SQLite Plugin",
        approved_at: 1,
      },
    ]);
    await expectMissingPath(sourcePath);
    await expect(fs.readFile(`${sourcePath}.migrated`, "utf8")).resolves.toContain("legacy-plugin");
  });

  it("keeps a failed plugin binding approvals archive blocking and converges on retry", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const sourcePath = path.join(stateDir, "plugin-binding-approvals.json");
    insertPluginBindingApprovalRow(env, {
      plugin_root: "/plugins/conflict",
      channel: "discord",
      account_id: "default",
      plugin_id: "sqlite-plugin",
      plugin_name: "SQLite Plugin",
      approved_at: 1,
    });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        approvals: [
          {
            pluginRoot: "/plugins/conflict",
            pluginId: "legacy-plugin",
            pluginName: "Legacy Plugin",
            channel: "discord",
            accountId: "default",
            approvedAt: 2,
          },
        ],
      }),
      "utf8",
    );

    const rename = failArchiveRenameOnce(sourcePath);
    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const result = await runLegacyStateMigrations({ detected, config: cfg });
    rename.mockRestore();

    expect(result.warnings).toStrictEqual([
      `Failed archiving plugin binding approvals legacy source ${sourcePath}: Error: forced archive failure`,
    ]);
    expect(result.notices).toEqual([
      `Kept shared SQLite plugin binding approvals because 1 legacy approval conflicts: ${sourcePath}`,
    ]);
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toContain("legacy-plugin");
    await expectMissingPath(`${sourcePath}.migrated`);

    const retryDetected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const retry = await runLegacyStateMigrations({ detected: retryDetected, config: cfg });
    expect(retry.warnings).toStrictEqual([]);
    await expectMissingPath(sourcePath);
  });

  it("leaves malformed plugin binding approvals in place with a warning", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const sourcePath = path.join(stateDir, "plugin-binding-approvals.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(sourcePath, "{ malformed", "utf8");

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Failed reading legacy plugin binding approvals");
    expect(result.notices).toBeUndefined();
    await expect(fs.access(sourcePath)).resolves.toBeUndefined();
    await expectMissingPath(`${sourcePath}.migrated`);
  });

  it("never imports home-state plugin approvals into a custom state dir", async () => {
    // Regression: direct doctor repair follows the same trust boundary as
    // automatic startup migration and cannot archive another state's policy.
    const root = await createTempDir();
    const stateDir = path.join(root, "custom-state");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const sourcePath = path.join(root, ".openclaw", "plugin-binding-approvals.json");
    const sourceRaw = JSON.stringify({
      version: 1,
      approvals: [
        {
          pluginRoot: "/plugins/codex-a",
          pluginId: "codex",
          channel: "telegram",
          accountId: "default",
          approvedAt: 2345,
        },
      ],
    });
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, sourceRaw, "utf8");

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.pluginBindingApprovals).toMatchObject({
      sourcePath,
      hasLegacy: false,
    });
    expect(detected.preview).not.toContain(
      "- Plugin binding approvals: legacy JSON file → shared SQLite state",
    );

    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).not.toContain(
      "Migrated 1 plugin binding approval → shared SQLite state",
    );
    expect(readPluginBindingApprovalRows(env)).toEqual([]);
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(sourceRaw);
    await expectMissingPath(`${sourcePath}.migrated`);
  });

  it("never imports default-profile approvals into a named profile", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw-work");
    const env = { ...createEnv(stateDir), OPENCLAW_PROFILE: "work" };
    const cfg = createConfig();
    const defaultStateDir = path.join(root, ".openclaw");
    const execApprovalsPath = path.join(defaultStateDir, "exec-approvals.json");
    const pluginApprovalsPath = path.join(defaultStateDir, "plugin-binding-approvals.json");
    await fs.mkdir(defaultStateDir, { recursive: true });
    await fs.writeFile(execApprovalsPath, '{"version":1,"agents":{}}\n', "utf8");
    await fs.writeFile(
      pluginApprovalsPath,
      JSON.stringify({
        version: 1,
        approvals: [
          {
            pluginRoot: "/plugins/codex-a",
            pluginId: "codex",
            channel: "telegram",
            accountId: "default",
            approvedAt: 2345,
          },
        ],
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });

    expect(detected.pluginBindingApprovals.hasLegacy).toBe(false);
    expect(detected.notices).toEqual([]);
    const result = await runLegacyStateMigrations({ detected, config: cfg, env });
    expect(result.changes.some((change) => change.includes("exec approvals"))).toBe(false);
    expect(result.changes.some((change) => change.includes("plugin binding approval"))).toBe(false);
    await expect(fs.access(execApprovalsPath)).resolves.toBeUndefined();
    await expect(fs.access(pluginApprovalsPath)).resolves.toBeUndefined();
    await expectMissingPath(path.join(stateDir, "exec-approvals.json"));
    expect(readPluginBindingApprovalRows(env)).toEqual([]);
  });

  it.each(["agent:codex:acp:legacy-missing", "plugin-binding:fixture:legacy-missing"])(
    "imports non-conflicting legacy target %s when SQLite has a conflict",
    async (targetSessionKey) => {
      const root = await createTempDir();
      const stateDir = path.join(root, ".openclaw");
      const env = createEnv(stateDir);
      const cfg = createConfig();
      const bindingsDir = path.join(stateDir, "bindings");
      const sourcePath = path.join(bindingsDir, "current-conversations.json");
      const conflictingKey = "workspace\u241fdefault\u241f\u241fuser:U123";
      const missingKey = "workspace\u241fdefault\u241f\u241fuser:U456";
      await fs.mkdir(bindingsDir, { recursive: true });
      insertCurrentConversationBindingRow(env, {
        bindingKey: conflictingKey,
        bindingId: `generic:${conflictingKey}`,
        targetSessionKey: "agent:codex:acp:existing",
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
        recordJson: JSON.stringify({
          bindingId: `generic:${conflictingKey}`,
          targetSessionKey: "agent:codex:acp:existing",
          targetKind: "session",
          conversation: {
            channel: "workspace",
            accountId: "default",
            conversationId: "user:U123",
          },
          status: "active",
          boundAt: 1,
        }),
      });
      await fs.writeFile(
        sourcePath,
        JSON.stringify({
          version: 1,
          bindings: [
            {
              bindingId: `generic:${conflictingKey}`,
              targetSessionKey: "agent:codex:acp:legacy-conflict",
              targetKind: "session",
              conversation: {
                channel: "workspace",
                accountId: "default",
                conversationId: "user:U123",
              },
              status: "active",
              boundAt: 2,
            },
            {
              bindingId: `generic:${missingKey}`,
              targetSessionKey,
              targetKind: "session",
              conversation: {
                channel: "workspace",
                accountId: "default",
                conversationId: "user:U456",
              },
              status: "active",
              boundAt: 3,
            },
          ],
        }),
        "utf8",
      );

      const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
      const result = await runLegacyStateMigrations({ detected, config: cfg });

      expect(result.changes).toContain(
        "Migrated 1 current-conversation binding → shared SQLite state",
      );
      expect(result.warnings).toStrictEqual([]);
      expect(result.notices).toEqual([
        `Kept shared SQLite current-conversation bindings because 1 legacy binding conflicts: ${sourcePath}`,
      ]);
      expect(readCurrentConversationBindingRows(env)).toMatchObject([
        {
          binding_key: conflictingKey,
          target_session_key: "agent:codex:acp:existing",
        },
        {
          binding_key: missingKey,
          target_session_key: targetSessionKey,
        },
      ]);
      await expectMissingPath(sourcePath);
      await expect(fs.readFile(`${sourcePath}.migrated`, "utf8")).resolves.toContain(
        "legacy-conflict",
      );
    },
  );

  it.each([
    {
      name: "plugin binding approvals",
      setup: createMixedPluginBindingCommitFailureFixture,
    },
    {
      name: "current-conversation bindings",
      setup: createMixedCurrentConversationCommitFailureFixture,
    },
  ])("keeps mixed $name retryable when SQLite commit fails", async ({ setup }) => {
    const fixture = await setup();
    const commit = failNextStateDbCommit(fixture.env);
    const result = fixture.migrate();
    commit.mockRestore();

    expect(result.warnings).toEqual([fixture.expectedWarning]);
    expect(result.notices).toBeUndefined();
    expect(fixture.readRowCount()).toBe(1);
    await expect(fs.readFile(fixture.sourcePath, "utf8")).resolves.toContain(
      fixture.sourceFragment,
    );
    await expectMissingPath(`${fixture.sourcePath}.migrated`);

    const retry = fixture.migrate();
    expect(retry.warnings).toStrictEqual([]);
    expect(fixture.readRowCount()).toBe(2);
    await expectMissingPath(fixture.sourcePath);
  });

  it("archives a legacy current-conversation file when every binding conflicts", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const sourcePath = path.join(stateDir, "bindings", "current-conversations.json");
    const bindingKey = "workspace\u241fdefault\u241f\u241fuser:U123";
    insertCurrentConversationBindingRow(env, {
      bindingKey,
      bindingId: `generic:${bindingKey}`,
      targetSessionKey: "agent:codex:acp:existing",
      channel: "workspace",
      accountId: "default",
      conversationId: "user:U123",
      recordJson: JSON.stringify({
        bindingId: `generic:${bindingKey}`,
        targetSessionKey: "agent:codex:acp:existing",
        targetKind: "session",
        conversation: {
          channel: "workspace",
          accountId: "default",
          conversationId: "user:U123",
        },
        status: "active",
        boundAt: 1,
      }),
    });
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            bindingId: `generic:${bindingKey}`,
            targetSessionKey: "agent:codex:acp:legacy-conflict",
            targetKind: "session",
            conversation: {
              channel: "workspace",
              accountId: "default",
              conversationId: "user:U123",
            },
            status: "active",
            boundAt: 2,
          },
        ],
      }),
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.notices).toEqual([
      `Kept shared SQLite current-conversation bindings because 1 legacy binding conflicts: ${sourcePath}`,
    ]);
    expect(readCurrentConversationBindingRows(env)).toMatchObject([
      {
        binding_key: bindingKey,
        target_session_key: "agent:codex:acp:existing",
      },
    ]);
    await expectMissingPath(sourcePath);
    await expect(fs.readFile(`${sourcePath}.migrated`, "utf8")).resolves.toContain(
      "legacy-conflict",
    );
  });

  it("keeps a failed current-conversation bindings archive blocking and converges on retry", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const sourcePath = path.join(stateDir, "bindings", "current-conversations.json");
    const bindingKey = "workspace\u241fdefault\u241f\u241fuser:U123";
    insertCurrentConversationBindingRow(env, {
      bindingKey,
      bindingId: `generic:${bindingKey}`,
      targetSessionKey: "agent:codex:acp:existing",
      channel: "workspace",
      accountId: "default",
      conversationId: "user:U123",
      recordJson: JSON.stringify({
        bindingId: `generic:${bindingKey}`,
        targetSessionKey: "agent:codex:acp:existing",
        targetKind: "session",
        conversation: {
          channel: "workspace",
          accountId: "default",
          conversationId: "user:U123",
        },
        status: "active",
        boundAt: 1,
      }),
    });
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            bindingId: `generic:${bindingKey}`,
            targetSessionKey: "agent:codex:acp:legacy-conflict",
            targetKind: "session",
            conversation: {
              channel: "workspace",
              accountId: "default",
              conversationId: "user:U123",
            },
            status: "active",
            boundAt: 2,
          },
        ],
      }),
      "utf8",
    );

    const rename = failArchiveRenameOnce(sourcePath);
    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const result = await runLegacyStateMigrations({ detected, config: cfg });
    rename.mockRestore();

    expect(result.warnings).toStrictEqual([
      `Failed archiving current-conversation bindings legacy source ${sourcePath}: Error: forced archive failure`,
    ]);
    expect(result.notices).toEqual([
      `Kept shared SQLite current-conversation bindings because 1 legacy binding conflicts: ${sourcePath}`,
    ]);
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toContain("legacy-conflict");
    await expectMissingPath(`${sourcePath}.migrated`);

    const retryDetected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const retry = await runLegacyStateMigrations({ detected: retryDetected, config: cfg });
    expect(retry.warnings).toStrictEqual([]);
    await expectMissingPath(sourcePath);
  });

  it("leaves malformed current-conversation bindings in place with a warning", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const sourcePath = path.join(stateDir, "bindings", "current-conversations.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "{ malformed", "utf8");

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Failed reading legacy current-conversation bindings");
    expect(result.notices).toBeUndefined();
    await expect(fs.access(sourcePath)).resolves.toBeUndefined();
    await expectMissingPath(`${sourcePath}.migrated`);
  });

  it("keeps legacy delivery queue files when shared SQLite already has a conflicting row", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    const cfg = createConfig();
    const queueDir = path.join(stateDir, "delivery-queue");
    await fs.mkdir(path.join(queueDir, "failed"), { recursive: true });
    await fs.writeFile(
      path.join(queueDir, "outbound-1.json"),
      JSON.stringify({
        id: "outbound-1",
        enqueuedAt: 10,
        retryCount: 2,
        channel: "telegram",
        to: "123",
        payloads: [{ text: "hi" }],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(queueDir, "outbound-1.delivered"), '{"id":"done"}\n', "utf8");
    await fs.writeFile(
      path.join(queueDir, "outbound-2.json"),
      JSON.stringify({
        id: "outbound-2",
        enqueuedAt: 11,
        retryCount: 1,
        channel: "telegram",
        to: "456",
        payloads: [{ text: "still pending" }],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(queueDir, "failed", "outbound-failed.json"),
      JSON.stringify({
        id: "outbound-failed",
        enqueuedAt: 12,
        retryCount: 3,
        channel: "telegram",
        to: "789",
        lastError: "nope",
        retainOnFailure: true,
        payloads: [{ text: "failed once" }],
      }),
      "utf8",
    );

    const { db } = openOpenClawStateDatabase({ env });
    db.prepare(
      `
        INSERT INTO delivery_queue_entries (
          queue_name, id, status, channel, target, retry_count, entry_json,
          enqueued_at, updated_at
        ) VALUES (
          'outbound', 'outbound-1', 'pending', 'telegram', '123', 0,
          '{"id":"outbound-1","retryCount":0}', 10, 10
        )
      `,
    ).run();

    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const result = await runLegacyStateMigrations({ detected });

    expect(result.changes).toContain(
      "Migrated 2 outbound delivery queue entries → shared SQLite state",
    );
    expect(result.changes).toContain("Removed 1 outbound delivery queue delivered marker");
    expect(result.warnings).toStrictEqual([
      "Left outbound delivery queue in place because 1 entry already existed in shared state: outbound-1",
    ]);
    await expect(fs.readFile(path.join(queueDir, "outbound-1.json"), "utf8")).resolves.toContain(
      '"retryCount":2',
    );
    await expectMissingPath(path.join(queueDir, "outbound-1.delivered"));
    expect(
      db
        .prepare(
          "SELECT retry_count FROM delivery_queue_entries WHERE queue_name = 'outbound' AND id = 'outbound-1'",
        )
        .get(),
    ).toEqual({ retry_count: 0 });
    expect(
      db
        .prepare(
          "SELECT retry_count FROM delivery_queue_entries WHERE queue_name = 'outbound' AND id = 'outbound-2'",
        )
        .get(),
    ).toEqual({ retry_count: 1 });
    expect(
      db
        .prepare(
          "SELECT retry_count, failed_at FROM delivery_queue_entries WHERE queue_name = 'outbound' AND id = 'outbound-failed'",
        )
        .get(),
    ).toEqual({ retry_count: 3, failed_at: 12 });

    vi.setSystemTime(2_000);
    const rerunDetected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const rerunResult = await runLegacyStateMigrations({ detected: rerunDetected });
    expect(rerunResult.warnings).toStrictEqual([
      "Left outbound delivery queue in place because 1 entry already existed in shared state: outbound-1",
    ]);
  });

  it("preserves a corrupt target session store instead of overwriting it with legacy-only data", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();

    const targetStorePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
    // target sessions.json is corrupt (trailing garbage → JSON5.parse fails) and
    // holds a target-only key that has no legacy counterpart.
    const corruptBytes = `${JSON.stringify({
      "agent:worker-1:desk:target-only": { sessionId: "target-only-session", updatedAt: 99 },
    })}\n<<<corrupt trailing garbage>>>`;
    await fs.writeFile(targetStorePath, corruptBytes, "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
    });

    // The corrupt bytes must survive on disk (parse still fails after migration).
    const afterRaw = await fs.readFile(targetStorePath, "utf8");
    expect(afterRaw).toContain("corrupt trailing garbage");
    expect(afterRaw).toBe(corruptBytes);

    // No "Merged sessions store" change was committed against the corrupt target.
    expect(result.changes.some((c) => c.startsWith("Merged sessions store"))).toBe(false);

    // And no direct-chat migration is reported either: the legacy direct entry was
    // not saved (the target was left untouched), so doctor/startup logs must not
    // claim a session migration happened on this skip path.
    expect(result.changes.some((c) => c.startsWith("Migrated latest direct-chat session"))).toBe(
      false,
    );

    // The user is warned that the target store was left untouched because it is unreadable.
    expect(result.warnings.some((w) => /unreadable|corrupt/i.test(w))).toBe(true);

    // Legacy store is NOT deleted or renamed, so a later explicit doctor --fix
    // can retry the migration from the detector's normal legacy path.
    await expect(
      fs.readFile(path.join(stateDir, "sessions", "sessions.json"), "utf8"),
    ).resolves.toContain("legacy-direct");
    await expect(fs.readFile(path.join(stateDir, "sessions", "trace.jsonl"), "utf8")).resolves.toBe(
      "{}\n",
    );
  });

  it("archives a corrupt target session store before explicit recovery", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();

    const targetStorePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
    const corruptBytes = `${JSON.stringify({
      "agent:worker-1:desk:target-only": { sessionId: "target-only-session", updatedAt: 99 },
    })}\n<<<corrupt trailing garbage>>>`;
    await fs.writeFile(targetStorePath, corruptBytes, "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
      recoverCorruptTargetStore: true,
    });

    const archivedPath = `${targetStorePath}.corrupt-1234`;
    await expect(fs.readFile(archivedPath, "utf8")).resolves.toBe(corruptBytes);

    const recoveredStore = JSON.parse(await fs.readFile(targetStorePath, "utf8")) as Record<
      string,
      { sessionId?: string }
    >;
    expect(recoveredStore["agent:worker-1:desk"]?.sessionId).toBe("legacy-direct");
    expect(recoveredStore["agent:worker-1:desk:target-only"]).toBeUndefined();
    expect(result.changes).toContain(`Archived corrupt target sessions store → ${archivedPath}`);
    expect(result.changes).toContain(`Merged sessions store → ${targetStorePath}`);
    expect(result.warnings).toStrictEqual([]);
    await expectMissingPath(path.join(stateDir, "sessions", "sessions.json"));
  });

  it("preserves a readable target store when normalization rejects an existing key", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();

    const targetStorePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    const targetBytes = `${JSON.stringify(
      {
        "agent:worker-1:desk": { sessionId: "valid-session", updatedAt: 50 },
        "agent:worker-1:desk:invalid": { sessionId: "../invalid", updatedAt: 60 },
      },
      null,
      2,
    )}\n`;
    const legacyBytes = await fs.readFile(legacyStorePath, "utf8");
    await fs.writeFile(targetStorePath, targetBytes, "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
    });

    await expect(fs.readFile(targetStorePath, "utf8")).resolves.toBe(targetBytes);
    await expect(fs.readFile(legacyStorePath, "utf8")).resolves.toBe(legacyBytes);
    await expect(fs.readFile(path.join(stateDir, "sessions", "trace.jsonl"), "utf8")).resolves.toBe(
      "{}\n",
    );
    expect(result.changes.some((change) => change.startsWith("Merged sessions store"))).toBe(false);
    expect(result.changes.some((change) => change.startsWith("Moved trace.jsonl"))).toBe(false);
    expect(result.warnings).toContainEqual(
      expect.stringContaining("normalization rejected 1 existing target session key"),
    );
  });

  it("still filters invalid legacy-only rows", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();

    const targetStorePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    await fs.writeFile(
      legacyStorePath,
      `${JSON.stringify(
        {
          invalidLegacy: { sessionId: "../invalid", updatedAt: 100 },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
    });

    const afterStore = JSON.parse(await fs.readFile(targetStorePath, "utf8")) as Record<
      string,
      { sessionId?: string }
    >;
    expect(afterStore["agent:worker-1:invalidLegacy"]).toBeUndefined();
    expect(Object.values(afterStore).some((entry) => entry.sessionId === "group-session")).toBe(
      true,
    );
    expect(result.changes).toContain(`Merged sessions store → ${targetStorePath}`);
    expect(result.warnings).toStrictEqual([]);
    await expectMissingPath(legacyStorePath);
  });

  it("keeps a path-safe Unicode legacy session attached to its transcript", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();

    const sessionId = "volume-main-हिन्दी-会議-000000";
    const transcriptName = `${sessionId}.jsonl`;
    const legacySessionsDir = path.join(stateDir, "sessions");
    const legacyStorePath = path.join(legacySessionsDir, "sessions.json");
    const targetSessionsDir = path.join(stateDir, "agents", "worker-1", "sessions");
    const targetStorePath = path.join(targetSessionsDir, "sessions.json");
    await fs.writeFile(
      legacyStorePath,
      `${JSON.stringify(
        {
          unicode: {
            sessionFile: path.join(legacySessionsDir, transcriptName),
            sessionId,
            updatedAt: 100,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const transcript = `${JSON.stringify({ type: "session", sessionId })}\n`;
    await fs.writeFile(path.join(legacySessionsDir, transcriptName), transcript, "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({ detected, now: () => 1234 });

    const migratedStore = JSON.parse(await fs.readFile(targetStorePath, "utf8")) as Record<
      string,
      { sessionId?: string }
    >;
    expect(migratedStore["agent:worker-1:unicode"]?.sessionId).toBe(sessionId);
    await expect(fs.readFile(path.join(targetSessionsDir, transcriptName), "utf8")).resolves.toBe(
      transcript,
    );
    await expectMissingPath(legacyStorePath);
    expect(result.warnings).toStrictEqual([]);
  });

  it("defers when an invalid legacy winner would replace an existing target key", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();

    const targetStorePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    const conflictKey = "agent:worker-1:desk:conflict";
    const targetBytes = `${JSON.stringify(
      {
        [conflictKey]: { sessionId: "target-session", updatedAt: 50 },
      },
      null,
      2,
    )}\n`;
    const legacyBytes = `${JSON.stringify(
      {
        [conflictKey]: { sessionId: "../invalid", updatedAt: 100 },
      },
      null,
      2,
    )}\n`;
    await fs.writeFile(targetStorePath, targetBytes, "utf8");
    await fs.writeFile(legacyStorePath, legacyBytes, "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
    });

    await expect(fs.readFile(targetStorePath, "utf8")).resolves.toBe(targetBytes);
    await expect(fs.readFile(legacyStorePath, "utf8")).resolves.toBe(legacyBytes);
    expect(result.changes.some((change) => change.startsWith("Merged sessions store"))).toBe(false);
    expect(result.warnings).toContainEqual(
      expect.stringContaining("normalization rejected 1 existing target session key"),
    );
  });

  it.runIf(process.platform !== "win32")(
    "preserves a key-shaped pending row while Doctor moves its matching legacy transcript",
    async () => {
      const { root, stateDir, env, cfg } = await createLegacyStateFixture();

      const targetStorePath = path.join(
        stateDir,
        "agents",
        "worker-1",
        "sessions",
        "sessions.json",
      );
      const pendingKey = "agent:worker-1:desk";
      const transcriptKey = "agent:worker-1:desk:transcript";
      const ordinaryKey = "agent:worker-1:desk:ordinary";
      const targetStore = {
        [pendingKey]: {
          sessionId: pendingKey,
          updatedAt: 50,
          displayName: "Pending desk",
          label: "pending-label",
          category: "triage",
          providerOverride: "test-provider",
          modelOverride: "test-model",
          modelOverrideSource: "user",
          groupActivation: "always",
          delivery: { kind: "none" },
        },
        [transcriptKey]: { sessionId: "trace", updatedAt: 60 },
        [ordinaryKey]: { sessionId: "ordinary-session", updatedAt: 70 },
      };
      await fs.writeFile(targetStorePath, `${JSON.stringify(targetStore, null, 2)}\n`, "utf8");
      await fs.writeFile(
        path.join(stateDir, "sessions", `${pendingKey}.jsonl`),
        '{"type":"session"}\n',
        "utf8",
      );

      const result = await autoMigrateLegacyState({
        cfg,
        env,
        homedir: () => root,
        now: () => 1234,
        doctorOnlyStateMigrations: true,
      });

      expect(result.changes).toContain(`Merged sessions store → ${targetStorePath}`);
      expect(result.changes).toContain("Moved trace.jsonl → agents/worker-1/sessions");
      expect(result.changes).toContain(`Moved ${pendingKey}.jsonl → agents/worker-1/sessions`);
      expect(result.changes).not.toContain("Rewrote migrated session transcript paths");
      await expect(
        fs.readFile(path.join(stateDir, "agents", "worker-1", "sessions", "trace.jsonl"), "utf8"),
      ).resolves.toBe("{}\n");
      await expect(
        fs.readFile(
          path.join(stateDir, "agents", "worker-1", "sessions", `${pendingKey}.jsonl`),
          "utf8",
        ),
      ).resolves.toBe('{"type":"session"}\n');

      const afterStore = JSON.parse(await fs.readFile(targetStorePath, "utf8")) as Record<
        string,
        {
          sessionId?: string;
          sessionFile?: string;
          initializationPending?: boolean;
          updatedAt?: number;
          displayName?: string;
          label?: string;
          category?: string;
          providerOverride?: string;
          modelOverride?: string;
          modelOverrideSource?: string;
          groupActivation?: string;
          delivery?: { kind?: string };
        }
      >;
      expect(afterStore[pendingKey]).toMatchObject({
        initializationPending: true,
        updatedAt: 50,
        displayName: "Pending desk",
        label: "pending-label",
        category: "triage",
        providerOverride: "test-provider",
        modelOverride: "test-model",
        modelOverrideSource: "user",
        groupActivation: "always",
        delivery: { kind: "none" },
      });
      expect(afterStore[pendingKey]?.sessionId).toBeUndefined();
      expect(afterStore[transcriptKey]?.sessionId).toBe("trace");
      expect(afterStore[transcriptKey]?.sessionFile).toBeUndefined();
      expect(afterStore[ordinaryKey]?.sessionId).toBe("ordinary-session");

      const firstBytes = await fs.readFile(targetStorePath, "utf8");
      const rerun = await rerunAutomaticMigrationAfterRestart({
        cfg,
        env,
        homedir: () => root,
        now: () => 1234,
        doctorOnlyStateMigrations: true,
      });
      expect(rerun.skipped).toBe(false);
      expect(rerun.warnings).toEqual([]);
      await expect(fs.readFile(targetStorePath, "utf8")).resolves.toBe(firstBytes);
      expect(rerun.changes.some((change) => change.startsWith("Merged sessions store"))).toBe(
        false,
      );
      expect(rerun.changes.some((change) => change.startsWith("Moved "))).toBe(false);
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
