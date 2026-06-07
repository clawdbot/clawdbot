// Device Pair tests cover doctor migration of legacy notify state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import {
  DEVICE_PAIR_NOTIFY_LEGACY_STATE_FILE,
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
  notifySubscriberStoreKey,
  type NotifySubscription,
} from "./notify-state.js";

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("device-pair", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

describe("device-pair doctor notify migration", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-device-pair-doctor-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  function migrationParams() {
    return {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    };
  }

  it("imports legacy notify subscribers into plugin state", async () => {
    const sourcePath = path.join(stateDir, DEVICE_PAIR_NOTIFY_LEGACY_STATE_FILE);
    const subscriber: NotifySubscription = {
      to: "chat-123",
      accountId: "telegram-default",
      messageThreadId: 271,
      mode: "persistent",
      addedAtMs: 1,
    };
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        subscribers: [subscriber],
        notifiedRequestIds: { stale: Date.now() },
      }),
      "utf8",
    );

    const migration = stateMigrations[0];
    await expect(migration.detectLegacyState(migrationParams())).resolves.toMatchObject({
      preview: [expect.stringContaining("Device Pair notify subscribers")],
    });

    const result = await migration.migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Device Pair notify subscribers -> plugin state (1 imported, 0 already present)",
      expect.stringContaining("Archived Device Pair notify-state legacy source"),
    ]);
    await expect(fs.access(sourcePath)).rejects.toThrow();
    await expect(fs.access(`${sourcePath}.migrated`)).resolves.toBeUndefined();
    await expect(
      createDoctorContext(env)
        .openPluginStateKeyedStore<NotifySubscription>({
          namespace: DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
          maxEntries: DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
        })
        .lookup(notifySubscriberStoreKey(subscriber)),
    ).resolves.toEqual(subscriber);
  });

  it("ignores legacy notify files that only contain cache state", async () => {
    const sourcePath = path.join(stateDir, DEVICE_PAIR_NOTIFY_LEGACY_STATE_FILE);
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        subscribers: [],
        notifiedRequestIds: { cached: Date.now() },
      }),
      "utf8",
    );

    const migration = stateMigrations[0];

    await expect(migration.detectLegacyState(migrationParams())).resolves.toBeNull();
    await expect(migration.migrateLegacyState(migrationParams())).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    await expect(fs.access(sourcePath)).resolves.toBeUndefined();
  });
});
