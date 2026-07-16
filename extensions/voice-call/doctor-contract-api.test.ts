// Voice Call tests cover doctor contract api plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveSessionStoreAgentIds, stateMigrations } from "./doctor-contract-api.js";
import {
  createTestStorePath,
  makePersistedCall,
  writeLegacyCallsJsonl,
} from "./src/manager.test-harness.js";
import { getCallHistoryFromStore, loadActiveCallsFromStore } from "./src/manager/store.js";
import { setVoiceCallStateRuntime } from "./src/runtime-state.js";

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("voice-call", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

function installStateRuntime(): void {
  setVoiceCallStateRuntime({
    state: {
      resolveStateDir: () => "",
      openKeyedStore: (() => {
        throw new Error("openKeyedStore is not used by voice-call doctor tests");
      }) as never,
      openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
        createPluginStateSyncKeyedStoreForTests("voice-call", options),
      openChannelIngressQueue: (() => {
        throw new Error("openChannelIngressQueue is not used by voice-call doctor tests");
      }) as never,
    },
  });
}

describe("voice-call doctor state migration", () => {
  let stateDir = "";
  let storePath = "";
  let env: NodeJS.ProcessEnv;
  let overCapacityMigration: {
    warnings: string[];
    changes: string[];
    activeCallIds: Set<string>;
    latestProviderCallId: string | undefined;
    historyCallIds: string[];
  };

  beforeAll(async () => {
    resetPluginStateStoreForTests();
    const warmStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-call-doctor-"));
    const warmStorePath = createTestStorePath();
    const warmEnv = {
      ...process.env,
      HOME: warmStateDir,
      OPENCLAW_STATE_DIR: warmStateDir,
    };
    try {
      installStateRuntime();
      const calls = Array.from({ length: 1002 }, (_, index) =>
        makePersistedCall({
          callId: `call-${index}`,
          providerCallId: `provider-${index}`,
        }),
      );
      writeLegacyCallsJsonl(warmStorePath, calls);
      const config = {
        plugins: {
          entries: {
            "@openclaw/voice-call": {
              config: { store: warmStorePath },
            },
          },
        },
      };
      const result = await expectDefined(
        stateMigrations[0],
        "voice-call state migration",
      ).migrateLegacyState({
        config,
        env: warmEnv,
        stateDir: warmStateDir,
        oauthDir: path.join(warmStateDir, "oauth"),
        context: createDoctorContext(warmEnv),
      });
      const restored = loadActiveCallsFromStore(warmStorePath);
      const history = await getCallHistoryFromStore(warmStorePath, 1000);
      overCapacityMigration = {
        warnings: result.warnings,
        changes: result.changes,
        activeCallIds: new Set(restored.activeCalls.keys()),
        latestProviderCallId: restored.activeCalls.get("call-1001")?.providerCallId,
        historyCallIds: history.map((entry) => entry.callId),
      };
    } finally {
      resetPluginStateStoreForTests();
      await fs.rm(warmStateDir, { recursive: true, force: true });
      await fs.rm(warmStorePath, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-call-doctor-"));
    storePath = createTestStorePath();
    env = { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
    installStateRuntime();
  });

  afterEach(async () => {
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(storePath, { recursive: true, force: true });
  });

  it("reports top-level and per-number session-store agents", () => {
    expect(
      resolveSessionStoreAgentIds({
        cfg: {
          plugins: {
            entries: {
              "voice-call": {
                config: {
                  agentId: "Voice",
                  numbers: {
                    "+15550001111": { agentId: "Cards" },
                    "+15550002222": {},
                  },
                },
              },
            },
          },
        },
      }),
    ).toEqual(["cards", "voice"]);
    expect(
      resolveSessionStoreAgentIds({
        cfg: {
          plugins: { entries: { "@openclaw/voice-call": { config: {} } } },
        },
      }),
    ).toEqual(["main"]);
    expect(
      resolveSessionStoreAgentIds({
        cfg: {
          plugins: { entries: { "voice-call": { enabled: true } } },
        },
      }),
    ).toEqual(["main"]);
  });

  it("imports legacy calls.jsonl into plugin state", async () => {
    const sourcePath = path.join(storePath, "calls.jsonl");
    const call = makePersistedCall({
      callId: "call-doctor",
      providerCallId: "provider-doctor",
      processedEventIds: ["evt-doctor"],
    });
    writeLegacyCallsJsonl(storePath, [
      {
        version: 2,
        persistedAt: 1000,
        sequence: 0,
        call,
      },
    ]);

    const migration = expectDefined(stateMigrations[0], "voice-call state migration");
    const config = {
      plugins: {
        entries: {
          "@openclaw/voice-call": {
            config: { store: storePath },
          },
        },
      },
    };
    await expect(
      migration.detectLegacyState({
        config,
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      }),
    ).resolves.toMatchObject({
      preview: [expect.stringContaining("1 record")],
    });

    const result = await migration.migrateLegacyState({
      config,
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 1 Voice Call call-log record"),
      expect.stringContaining("Archived Voice Call call-log legacy source"),
    ]);
    await expect(fs.access(sourcePath)).rejects.toThrow();
    await expect(fs.access(`${sourcePath}.migrated`)).resolves.toBeUndefined();

    const restored = loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.get("call-doctor")?.providerCallId).toBe("provider-doctor");
    expect(restored.processedEventIds.has("evt-doctor")).toBe(true);

    const history = await getCallHistoryFromStore(storePath);
    expect(history).toHaveLength(1);
    expect(history[0]?.callId).toBe("call-doctor");
  });

  it("repairs the plugin-local SQLite schema without a legacy call log", async () => {
    const databasePath = path.join(storePath, "state", "openclaw.sqlite");
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
      `);
    } finally {
      db.close();
    }
    const migration = expectDefined(stateMigrations[0], "voice-call state migration");
    const config = {
      plugins: {
        entries: {
          "voice-call": {
            config: { store: storePath },
          },
        },
      },
    };
    const params = {
      config,
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    };

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [
        "- Voice Call SQLite schema: audit event ledger -> versioned message lifecycle schema",
      ],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [
        "Migrated Voice Call SQLite audit event ledger -> versioned message lifecycle schema",
      ],
      warnings: [],
    });
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    expect(loadActiveCallsFromStore(storePath).activeCalls.size).toBe(0);
  });

  it("imports the newest legacy call records when the JSONL log is over capacity", () => {
    expect(overCapacityMigration.warnings).toEqual([
      expect.stringContaining("Pruned 2 older Voice Call call-log records"),
    ]);
    expect(overCapacityMigration.changes).toEqual([
      expect.stringContaining("Migrated 1000 Voice Call call-log records"),
      expect.stringContaining("Archived Voice Call call-log legacy source"),
    ]);
    expect(overCapacityMigration.activeCallIds.has("call-0")).toBe(false);
    expect(overCapacityMigration.activeCallIds.has("call-1")).toBe(false);
    expect(overCapacityMigration.latestProviderCallId).toBe("provider-1001");
    expect(overCapacityMigration.historyCallIds).toHaveLength(1000);
    expect(overCapacityMigration.historyCallIds[0]).toBe("call-2");
    expect(overCapacityMigration.historyCallIds.at(-1)).toBe("call-1001");
  });

  it("leaves malformed mixed legacy logs in place after importing valid records", async () => {
    const sourcePath = path.join(storePath, "calls.jsonl");
    const call = makePersistedCall({
      callId: "call-valid",
      providerCallId: "provider-valid",
    });
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, `${JSON.stringify(call)}\n{not json}\n`);

    const config = {
      plugins: {
        entries: {
          "@openclaw/voice-call": {
            config: { store: storePath },
          },
        },
      },
    };
    const result = await expectDefined(
      stateMigrations[0],
      "voice-call state migration",
    ).migrateLegacyState({
      config,
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });

    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 1 Voice Call call-log record"),
    ]);
    expect(result.warnings).toEqual([
      "Skipped malformed Voice Call call-log line 2",
      "Left Voice Call call-log source in place because migration was incomplete",
    ]);
    await expect(fs.access(sourcePath)).resolves.toBeUndefined();
    await expect(fs.access(`${sourcePath}.migrated`)).rejects.toThrow();
    expect(loadActiveCallsFromStore(storePath).activeCalls.has("call-valid")).toBe(true);
  });
});
