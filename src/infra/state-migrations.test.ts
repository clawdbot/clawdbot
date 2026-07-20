// Covers legacy state migration detection and repair behavior.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readAcpSessionMetaForEntry } from "../acp/runtime/session-meta.js";
import type { OpenClawConfig } from "../config/config.js";
import * as sessionStore from "../config/sessions.js";
import { loadNodeHostConfig } from "../node-host/config.js";
import { readChannelPairingStateSnapshot } from "../pairing/pairing-store-sqlite.test-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { loadApnsRegistration } from "./push-apns.js";
import {
  createWebPushVapidKeyPair,
  hashWebPushEndpoint,
  listWebPushSubscriptions,
  readPersistedVapidKeyPair,
} from "./push-web-store.js";
import { readRestartSentinel } from "./restart-sentinel.js";
import {
  autoMigrateLegacyState,
  autoMigrateLegacyPluginDoctorState,
  detectLegacyStateMigrations,
  resetAutoMigrateLegacyStateDirForTest,
  resetAutoMigrateLegacyStateForTest,
  runLegacyStateMigrations,
} from "./state-migrations.js";
import { loadVoiceWakeRoutingConfig, setVoiceWakeRoutingConfig } from "./voicewake-routing.js";
import { loadVoiceWakeConfig, setVoiceWakeTriggers } from "./voicewake.js";

const pluginDoctorStateMigrationEntries = vi.hoisted(
  () =>
    ({
      entries: [] as Array<{
        pluginId: string;
        migration: {
          id: string;
          label: string;
          doctorOnly?: boolean;
          detectLegacyState: (params: {
            config: OpenClawConfig;
            env: NodeJS.ProcessEnv;
            stateDir: string;
            oauthDir: string;
            context: unknown;
          }) => Promise<{ preview: string[] } | null> | { preview: string[] } | null;
          migrateLegacyState: (params: {
            config: OpenClawConfig;
            env: NodeJS.ProcessEnv;
            stateDir: string;
            oauthDir: string;
            context: unknown;
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
        migration: {
          id: string;
          label: string;
          detectLegacyState: (params: {
            config: OpenClawConfig;
            env: NodeJS.ProcessEnv;
            stateDir: string;
            oauthDir: string;
            context: unknown;
          }) => Promise<{ preview: string[] } | null> | { preview: string[] } | null;
          migrateLegacyState: (params: {
            config: OpenClawConfig;
            env: NodeJS.ProcessEnv;
            stateDir: string;
            oauthDir: string;
            context: unknown;
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

vi.mock("../channels/plugins/bundled.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/bundled.js")>(
    "../channels/plugins/bundled.js",
  );
  function fileExists(filePath: string): boolean {
    try {
      return fsSync.statSync(filePath).isFile();
    } catch {
      return false;
    }
  }

  return {
    ...actual,
    listBundledChannelLegacySessionSurfaces: vi.fn(() => [
      {
        isLegacyGroupSessionKey: (key: string) => /^group:mobile-/i.test(key.trim()),
        canonicalizeLegacySessionKey: ({ key, agentId }: { key: string; agentId: string }) => {
          if (key === "legacy-prototype") {
            return "__proto__";
          }
          return /^group:mobile-/i.test(key.trim())
            ? `agent:${agentId}:mobileauth:${key.trim().toLowerCase()}`
            : null;
        },
      },
    ]),
    listBundledChannelLegacyStateMigrationDetectors: vi.fn(() => [
      ({ oauthDir }: { oauthDir: string }) => {
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
          return fileExists(targetPath)
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
    ]),
  };
});

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  return {
    ...actual,
    listPluginDoctorStateMigrationEntries: vi.fn(() => pluginDoctorStateMigrationEntries.entries),
  };
});

const tempDirs = createTrackedTempDirs();
const APNS_DEVICE_FIELD = "token";

type UpdateCheckStateDatabase = Pick<OpenClawStateKyselyDatabase, "update_check_state">;
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
const createTempDir = () => tempDirs.make("openclaw-state-migrations-test-");

function readUpdateCheckState(env: NodeJS.ProcessEnv):
  | {
      last_checked_at: string | null;
      last_available_version: string | null;
      last_available_tag: string | null;
      auto_install_id: string | null;
    }
  | undefined {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<UpdateCheckStateDatabase>(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("update_check_state")
      .select([
        "last_checked_at",
        "last_available_version",
        "last_available_tag",
        "auto_install_id",
      ])
      .where("state_key", "=", "default"),
  );
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
      target_agent_id: "codex",
      target_session_id: null,
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
  resetAutoMigrateLegacyStateForTest();
  resetAutoMigrateLegacyStateDirForTest();
  closeOpenClawStateDatabaseForTest();
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
    expect(detectionCase.channelPlans.hasLegacy).toBe(true);
    expect(detectionCase.channelPlans.plans.map((plan) => plan.targetPath)).toEqual([
      path.join(detectionCase.stateDir, "credentials", "mobileauth", "default", "creds.json"),
    ]);
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
      `Migrated latest direct-chat session → agent:worker-1:desk`,
      `Merged sessions store → ${path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json")}`,
      "Canonicalized 3 legacy session key(s)",
      "Moved trace.jsonl → agents/worker-1/sessions",
      "Rewrote migrated session transcript paths",
      "Migrated 2 ACP session metadata rows → shared SQLite state",
      "Moved agent file settings.json → agents/worker-1/agent",
      `Moved MobileAuth auth creds.json → ${path.join(stateDir, "credentials", "mobileauth", "default", "creds.json")}`,
      `Moved MobileAuth auth pre-key-1.json → ${path.join(stateDir, "credentials", "mobileauth", "default", "pre-key-1.json")}`,
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
    expect(mergedStore["agent:worker-1:mobileauth:group:mobile-room"]?.sessionId).toBe(
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
    expect(Object.hasOwn(mergedStore, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(mergedStore, "__proto__")?.value.sessionId).toBe(
      "prototype-row",
    );
    expect(Object.getOwnPropertyDescriptor(mergedStore, "__proto__")?.value.sessionFile).toBe(
      path.join(stateDir, "agents", "worker-1", "sessions", "trace.jsonl"),
    );
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
    const realSaveSessionStore = sessionStore.saveSessionStore;
    let sawRequiredWrite = false;
    const saveSpy = vi
      .spyOn(sessionStore, "saveSessionStore")
      .mockImplementation(async (storePath, store, options) => {
        sawRequiredWrite ||= options?.requireWriteSuccess === true;
        if (storePath === targetStorePath) {
          if (options?.requireWriteSuccess) {
            throw new Error("simulated alias write failure");
          }
          return;
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

      result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });
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

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

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
    await fs.writeFile(
      outsideStorePath,
      JSON.stringify({
        "agent:main:task": {
          sessionId: "canonical-acp",
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

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

    expect((await fs.lstat(configuredStorePath)).isSymbolicLink()).toBe(true);
    const outsideStore = JSON.parse(await fs.readFile(outsideStorePath, "utf8")) as Record<
      string,
      { sessionId: string; acp?: unknown }
    >;
    expect(outsideStore["agent:main:task"]?.acp).toBeDefined();
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

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

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

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

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

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

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

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

    const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
      string,
      { sessionId: string; acp?: unknown }
    >;
    for (const { legacyKey, canonicalKey, sessionId, runtimeSessionName } of cases) {
      expect(store[legacyKey]).toBeUndefined();
      expect(store[canonicalKey]).toEqual({ sessionId, updatedAt: 10 });
      expect(
        readAcpSessionMetaForEntry({
          sessionKey: canonicalKey,
          entry: { sessionId },
          env,
        })?.runtimeSessionName,
      ).toBe(runtimeSessionName);
      expect(
        readAcpSessionMetaForEntry({
          sessionKey: legacyKey,
          entry: { sessionId },
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

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

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
      2,
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

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

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

  it("canonicalizes imported ACP aliases with their session row owner", async () => {
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
    await fs.writeFile(storePath, "{}\n", "utf8");
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

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

    expect(
      readAcpSessionMetaForEntry({
        sessionKey: "agent:voice:desk",
        entry: { sessionId: "voice-main" },
        env,
      })?.runtimeSessionName,
    ).toBe("voice-runtime");
    expect(
      readAcpSessionMetaForEntry({
        sessionKey: "agent:voice:main",
        entry: { sessionId: "voice-main" },
        env,
      }),
    ).toBeUndefined();
    expect(result.changes).toContain("Migrated 1 ACP session metadata row → shared SQLite state");
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
      "Migrated 2 session delivery queue entries → shared SQLite state",
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
        channel: "telegram",
        target: "456",
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
      {
        queue_name: "session",
        id: "session-failed",
        status: "failed",
        channel: null,
        target: null,
        retry_count: 3,
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
    await setVoiceWakeRoutingConfig(
      {
        defaultTarget: { mode: "current" },
        routes: [{ trigger: "robot wake", target: { agentId: "main" } }],
      },
      stateDir,
    );
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
    } finally {
      db.close();
    }

    const after = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(after.preview).not.toContain(
      "- Shared SQLite schema: audit event ledger → versioned message lifecycle schema",
    );
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

    const result = await autoMigrateLegacyPluginDoctorState({
      config: cfg,
      env,
      homedir: () => root,
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Failed migrating shared state database schema");
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

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

    expect(result.migrated).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Failed migrating shared state database schema");
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
      last_checked_at: "2026-01-17T09:30:00.000Z",
      last_available_version: "2.0.0",
      last_available_tag: "latest",
      auto_install_id: "install-1",
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
    expect(readUpdateCheckState(env)?.last_available_version).toBe("2.0.0");
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

  it("imports non-conflicting legacy current-conversation bindings when SQLite has a conflict", async () => {
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
            targetSessionKey: "agent:codex:acp:legacy-missing",
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
    expect(result.warnings).toContain(
      `Left legacy current-conversation bindings in place because 1 binding conflicts with shared SQLite state: ${sourcePath}`,
    );
    expect(readCurrentConversationBindingRows(env)).toMatchObject([
      {
        binding_key: conflictingKey,
        target_session_key: "agent:codex:acp:existing",
      },
      {
        binding_key: missingKey,
        target_session_key: "agent:codex:acp:legacy-missing",
      },
    ]);
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toContain("legacy-conflict");
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
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
