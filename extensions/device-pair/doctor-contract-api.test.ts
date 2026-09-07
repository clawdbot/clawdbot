// Device Pair tests cover doctor migration of legacy notify state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  LEGACY_JSON_MIGRATION_MAX_BYTES,
  LEGACY_JSON_MIGRATION_RECOVERY_MAX_BYTES,
  type OpenKeyedStoreOptions,
  type PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
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
    resetPluginStateStoreForTests();
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

  function openSubscribers() {
    return createDoctorContext(env).openPluginStateKeyedStore<NotifySubscription>({
      namespace: DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
      maxEntries: DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
    });
  }

  function legacySubscribers(count: number): NotifySubscription[] {
    return Array.from({ length: count }, (_, index) => ({
      to: `chat-${index}`,
      accountId: "telegram-default",
      messageThreadId: 271,
      mode: "persistent",
      addedAtMs: index + 1,
    }));
  }

  it.each([1023, 1024])("retains and archives %i legacy subscribers", async (count) => {
    const sourcePath = path.join(stateDir, DEVICE_PAIR_NOTIFY_LEGACY_STATE_FILE);
    const subscribers = legacySubscribers(count);
    await fs.writeFile(sourcePath, JSON.stringify({ subscribers }));
    const migration = expectDefined(stateMigrations[0], "device-pair state migration");

    const result = await migration.migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      `Migrated Device Pair notify subscribers -> plugin state (${count} imported, 0 already present)`,
      expect.stringContaining("Archived Device Pair notify-state legacy source"),
    ]);
    expect((await openSubscribers().entries()).map(({ key }) => key).toSorted()).toEqual(
      subscribers.map(notifySubscriberStoreKey).toSorted(),
    );
    await expect(fs.access(sourcePath)).rejects.toThrow();
    await fs.access(`${sourcePath}.migrated`);
    await expect(migration.detectLegacyState(migrationParams())).resolves.toBeNull();
  });

  it.each([0, 1])(
    "refuses overflow without losing source or destination rows (%i existing)",
    async (existingCount) => {
      const sourcePath = path.join(stateDir, DEVICE_PAIR_NOTIFY_LEGACY_STATE_FILE);
      const subscribers = legacySubscribers(1025 - existingCount);
      const source = JSON.stringify({ subscribers });
      await fs.writeFile(sourcePath, source);
      const store = openSubscribers();
      if (existingCount) {
        await store.register("existing", { to: "existing", mode: "once", addedAtMs: 0 });
      }
      const before = await store.entries();
      const migration = expectDefined(stateMigrations[0], "device-pair state migration");

      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await migration.migrateLegacyState(migrationParams());
        expect({ result, retained: (await store.entries()).length }).toEqual({
          result: {
            changes: [],
            warnings: [expect.stringContaining("left legacy source in place")],
          },
          retained: existingCount,
        });
        expect(await store.entries()).toEqual(before);
        await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(source);
        await expect(fs.access(`${sourcePath}.migrated`)).rejects.toThrow();
        await expect(migration.detectLegacyState(migrationParams())).resolves.not.toBeNull();
      }
      if (existingCount) {
        await store.delete("existing");
        const result = await migration.migrateLegacyState(migrationParams());
        expect(result.warnings).toEqual([]);
        expect((await store.entries()).map(({ key }) => key).toSorted()).toEqual(
          subscribers.map(notifySubscriberStoreKey).toSorted(),
        );
        await expect(fs.readFile(`${sourcePath}.migrated`, "utf8")).resolves.toBe(source);
        await expect(migration.detectLegacyState(migrationParams())).resolves.toBeNull();
      }
    },
  );

  it("counts distinct missing keys and preserves existing subscriber values", async () => {
    const sourcePath = path.join(stateDir, DEVICE_PAIR_NOTIFY_LEGACY_STATE_FILE);
    const subscribers = legacySubscribers(1024);
    const first = expectDefined(subscribers[0], "first subscriber");
    const canonical = { ...first, mode: "once" as const };
    const store = openSubscribers();
    await store.register(notifySubscriberStoreKey(first), canonical);
    await fs.writeFile(sourcePath, JSON.stringify({ subscribers: [...subscribers, first] }));
    const migration = expectDefined(stateMigrations[0], "device-pair state migration");

    const result = await migration.migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Device Pair notify subscribers -> plugin state (1023 imported, 2 already present)",
      expect.stringContaining("Archived Device Pair notify-state legacy source"),
    ]);
    expect(await store.entries()).toHaveLength(1024);
    await expect(store.lookup(notifySubscriberStoreKey(first))).resolves.toEqual(canonical);
  });

  it.each([
    {},
    { accountId: "telegram-default" },
    { messageThreadId: 271 },
    { accountId: "telegram-default", messageThreadId: 0 },
    { accountId: "telegram-default", messageThreadId: "271" },
  ])("imports legacy notify subscribers into plugin state (%j)", async (target) => {
    const sourcePath = path.join(stateDir, DEVICE_PAIR_NOTIFY_LEGACY_STATE_FILE);
    const subscriber: NotifySubscription = {
      to: "chat-123",
      ...target,
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

    const migration = expectDefined(stateMigrations[0], "device-pair state migration");
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
    await fs.access(`${sourcePath}.migrated`);
    await expect(
      createDoctorContext(env)
        .openPluginStateKeyedStore<NotifySubscription>({
          namespace: DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
          maxEntries: DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
        })
        .lookup(notifySubscriberStoreKey(subscriber)),
    ).resolves.toEqual(subscriber);
  });

  it("imports symlinked legacy notify subscribers under the file cap", async () => {
    const sourcePath = path.join(stateDir, DEVICE_PAIR_NOTIFY_LEGACY_STATE_FILE);
    const targetPath = path.join(stateDir, "device-pair-notify-state-target.json");
    const subscriber = expectDefined(legacySubscribers(1)[0], "symlinked subscriber");
    const source = JSON.stringify({ subscribers: [subscriber], notifiedRequestIds: {} });
    await fs.writeFile(targetPath, source, "utf8");
    await fs.symlink(targetPath, sourcePath);

    const migration = expectDefined(stateMigrations[0], "device-pair state migration");
    const result = await migration.migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Device Pair notify subscribers -> plugin state (1 imported, 0 already present)",
      expect.stringContaining("Archived Device Pair notify-state legacy source"),
    ]);
    const archivePath = `${sourcePath}.migrated`;
    await expect(fs.readFile(archivePath, "utf8")).resolves.toBe(source);
    expect((await fs.lstat(archivePath)).isSymbolicLink()).toBe(true);
    await expect(fs.access(sourcePath)).rejects.toThrow();
    await expect(openSubscribers().entries()).resolves.toHaveLength(1);
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

    const migration = expectDefined(stateMigrations[0], "device-pair state migration");

    await expect(migration.detectLegacyState(migrationParams())).resolves.toBeNull();
    await expect(migration.migrateLegacyState(migrationParams())).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    await fs.access(sourcePath);
  });

  it("recovers subscribers from a legacy notify source above the fast read cap", async () => {
    const sourcePath = path.join(stateDir, DEVICE_PAIR_NOTIFY_LEGACY_STATE_FILE);
    const subscriber: NotifySubscription = {
      to: "chat-oversized",
      accountId: "telegram-default",
      messageThreadId: 271,
      mode: "persistent",
      addedAtMs: 1,
    };
    const payload = JSON.stringify({
      subscribers: [subscriber],
      notifiedRequestIds: {},
      padding: "x".repeat(LEGACY_JSON_MIGRATION_MAX_BYTES),
    });
    expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(LEGACY_JSON_MIGRATION_MAX_BYTES);
    await fs.writeFile(sourcePath, payload, "utf8");

    const migration = expectDefined(stateMigrations[0], "device-pair state migration");
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

  it("keeps an unprocessable notify source above the recovery budget", async () => {
    const sourcePath = path.join(stateDir, DEVICE_PAIR_NOTIFY_LEGACY_STATE_FILE);
    await fs.writeFile(sourcePath, "", "utf8");
    await fs.truncate(sourcePath, LEGACY_JSON_MIGRATION_RECOVERY_MAX_BYTES + 1);

    const migration = expectDefined(stateMigrations[0], "device-pair state migration");
    await expect(migration.detectLegacyState(migrationParams())).resolves.toMatchObject({
      preview: [
        expect.stringContaining(`exceeds ${LEGACY_JSON_MIGRATION_RECOVERY_MAX_BYTES} bytes`),
      ],
    });

    await expect(migration.migrateLegacyState(migrationParams())).resolves.toEqual({
      changes: [],
      warnings: [
        expect.stringContaining(`exceeds ${LEGACY_JSON_MIGRATION_RECOVERY_MAX_BYTES} bytes`),
      ],
    });
    await expect(fs.access(sourcePath)).resolves.toBeUndefined();
    await expect(fs.access(`${sourcePath}.migrated`)).rejects.toThrow();
    await expect(
      createDoctorContext(env)
        .openPluginStateKeyedStore<NotifySubscription>({
          namespace: DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
          maxEntries: DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
        })
        .entries(),
    ).resolves.toEqual([]);
  });
});
