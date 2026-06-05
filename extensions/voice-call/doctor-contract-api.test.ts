// Voice Call tests cover doctor contract api plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import {
  createTestStorePath,
  makePersistedCall,
  writeLegacyCallsJsonl,
} from "./src/manager.test-harness.js";
import { getCallHistoryFromStore, loadActiveCallsFromStore } from "./src/manager/store.js";
import { clearVoiceCallStateRuntime, setVoiceCallStateRuntime } from "./src/runtime-state.js";

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

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-call-doctor-"));
    storePath = createTestStorePath();
    env = { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
    installStateRuntime();
  });

  afterEach(async () => {
    clearVoiceCallStateRuntime();
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(storePath, { recursive: true, force: true });
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

    const migration = stateMigrations[0];
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

  it("imports the newest legacy call records when the JSONL log is over capacity", async () => {
    const calls = Array.from({ length: 1002 }, (_, index) =>
      makePersistedCall({
        callId: `call-${index}`,
        providerCallId: `provider-${index}`,
      }),
    );
    writeLegacyCallsJsonl(storePath, calls);

    const config = {
      plugins: {
        entries: {
          "@openclaw/voice-call": {
            config: { store: storePath },
          },
        },
      },
    };
    const result = await stateMigrations[0].migrateLegacyState({
      config,
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });

    expect(result.warnings).toEqual([
      expect.stringContaining("Pruned 2 older Voice Call call-log records"),
    ]);
    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 1000 Voice Call call-log records"),
      expect.stringContaining("Archived Voice Call call-log legacy source"),
    ]);

    const restored = loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.has("call-0")).toBe(false);
    expect(restored.activeCalls.has("call-1")).toBe(false);
    expect(restored.activeCalls.get("call-1001")?.providerCallId).toBe("provider-1001");

    const history = await getCallHistoryFromStore(storePath, 1000);
    expect(history).toHaveLength(1000);
    expect(history[0]?.callId).toBe("call-2");
    expect(history.at(-1)?.callId).toBe("call-1001");
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
    const result = await stateMigrations[0].migrateLegacyState({
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
