// Active Memory tests cover doctor contract api plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_TOGGLE_RECOVERY_MAX_BYTES,
  LEGACY_TOGGLE_STATE_MAX_BYTES,
  legacyConfigRules,
  normalizeCompatibilityConfig,
  stateMigrations,
} from "./doctor-contract-api.js";

it("removes the retired QMD override while preserving Active Memory siblings", () => {
  expect(legacyConfigRules).toEqual([
    expect.objectContaining({
      path: ["plugins", "entries", "active-memory", "config", "qmd"],
      message: expect.stringContaining("doctor --fix"),
    }),
  ]);
  const cfg = {
    plugins: {
      entries: {
        "active-memory": {
          config: { enabled: true, qmd: { searchMode: "search" } },
        },
      },
    },
  };

  const result = normalizeCompatibilityConfig({ cfg });

  expect(result.config).toHaveProperty("plugins.entries.active-memory.config.enabled", true);
  expect(result.config).not.toHaveProperty("plugins.entries.active-memory.config.qmd");
  expect(result.changes).toEqual(["Removed retired Active Memory QMD search-mode configuration."]);
});

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("active-memory", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

describe("active-memory doctor state migration", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-active-memory-doctor-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    vi.useRealTimers();
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("preserves oversized legacy opt-outs without writing or archiving on repeated repairs", async () => {
    const sourcePath = path.join(stateDir, "plugins", "active-memory", "session-toggles.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    const source = JSON.stringify({
      sessions: Object.fromEntries(
        Array.from({ length: 10_001 }, (_, index) => [
          `session-${index}`,
          { disabled: true, updatedAt: index + 1 },
        ]),
      ),
    });
    await fs.writeFile(sourcePath, source);
    const migration = expectDefined(stateMigrations[0], "active-memory state migration");
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(migration.migrateLegacyState(params)).resolves.toEqual({
        changes: [],
        warnings: [
          "Skipped Active Memory session toggle migration because plugin state has room for 10000 of 10001 missing entries; left legacy source in place",
        ],
      });
      await expect(
        params.context
          .openPluginStateKeyedStore({ namespace: "session-toggles", maxEntries: 10_000 })
          .entries(),
      ).resolves.toEqual([]);
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(source);
      await expect(fs.access(`${sourcePath}.migrated`)).rejects.toThrow();
      await expect(migration.detectLegacyState(params)).resolves.not.toBeNull();
    }
  });

  it("imports legacy session opt-outs into plugin state", async () => {
    const sourcePath = path.join(stateDir, "plugins", "active-memory", "session-toggles.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        sessions: {
          "telegram:dm:123": { disabled: true, updatedAt: 1700 },
          "telegram:dm:456": { disabled: false, updatedAt: 1701 },
        },
      }),
    );

    const migration = expectDefined(stateMigrations[0], "active-memory state migration");
    await expect(
      migration.detectLegacyState({
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      }),
    ).resolves.toMatchObject({
      preview: [expect.stringContaining("1 entry")],
    });

    const result = await migration.migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 1 Active Memory session toggle entry"),
      expect.stringContaining("Archived Active Memory session toggles legacy source"),
    ]);
    await expect(fs.access(sourcePath)).rejects.toThrow();
    await fs.access(`${sourcePath}.migrated`);

    const entries = await createDoctorContext(env)
      .openPluginStateKeyedStore({
        namespace: "session-toggles",
        maxEntries: 10_000,
      })
      .entries();
    expect(entries).toMatchObject([
      {
        key: expect.any(String),
        value: {
          sessionKey: "telegram:dm:123",
          disabled: true,
          updatedAt: 1700,
        },
      },
    ]);
  });

  it("imports symlinked legacy session opt-outs under the file cap", async () => {
    const sourcePath = path.join(stateDir, "plugins", "active-memory", "session-toggles.json");
    const targetPath = path.join(
      stateDir,
      "plugins",
      "active-memory",
      "session-toggles-target.json",
    );
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    const source = JSON.stringify({
      sessions: {
        "telegram:dm:symlinked": { disabled: true, updatedAt: 1700 },
      },
    });
    await fs.writeFile(targetPath, source, "utf8");
    await fs.symlink(targetPath, sourcePath);

    const migration = expectDefined(stateMigrations[0], "active-memory state migration");
    const result = await migration.migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 1 Active Memory session toggle entry"),
      expect.stringContaining("Archived Active Memory session toggles legacy source"),
    ]);
    const archivePath = `${sourcePath}.migrated`;
    await expect(fs.readFile(archivePath, "utf8")).resolves.toBe(source);
    expect((await fs.lstat(archivePath)).isSymbolicLink()).toBe(true);
    await expect(fs.access(sourcePath)).rejects.toThrow();
    await expect(
      createDoctorContext(env)
        .openPluginStateKeyedStore({ namespace: "session-toggles", maxEntries: 10_000 })
        .entries(),
    ).resolves.toHaveLength(1);
  });

  it("normalizes malformed legacy updatedAt values before importing toggles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T00:00:00.000Z"));
    const sourcePath = path.join(stateDir, "plugins", "active-memory", "session-toggles.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      '{"sessions":{"telegram:dm:bad":{"disabled":true,"updatedAt":1e999}}}',
    );

    const migration = expectDefined(stateMigrations[0], "active-memory state migration");
    const result = await migration.migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });

    expect(result.warnings).toEqual([]);
    const entries = await createDoctorContext(env)
      .openPluginStateKeyedStore({
        namespace: "session-toggles",
        maxEntries: 10_000,
      })
      .entries();
    expect(entries).toMatchObject([
      {
        value: {
          sessionKey: "telegram:dm:bad",
          disabled: true,
          updatedAt: Date.parse("2026-07-10T00:00:00.000Z"),
        },
      },
    ]);
  });

  it("preserves a live session opt-out inserted during legacy migration", async () => {
    const sourcePath = path.join(stateDir, "plugins", "active-memory", "session-toggles.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({
        sessions: {
          "telegram:dm:race": { disabled: true, updatedAt: 1700 },
        },
      }),
    );

    const baseContext = createDoctorContext(env);
    const liveEntry = {
      sessionKey: "telegram:dm:race",
      disabled: true,
      updatedAt: 9999,
    };
    let insertedLiveEntry = false;
    const context: PluginDoctorStateMigrationContext = {
      openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
        const store = baseContext.openPluginStateKeyedStore<T>(options);
        async function insertLiveEntry(key: string) {
          if (insertedLiveEntry) {
            return;
          }
          insertedLiveEntry = true;
          await store.register(key, liveEntry as T);
        }
        return {
          ...store,
          async register(...args: Parameters<typeof store.register>) {
            await insertLiveEntry(args[0]);
            return await store.register(...args);
          },
          async registerIfAbsent(...args: Parameters<typeof store.registerIfAbsent>) {
            await insertLiveEntry(args[0]);
            return await store.registerIfAbsent(...args);
          },
        };
      },
    };

    const migration = expectDefined(stateMigrations[0], "active-memory state migration");
    const result = await migration.migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringContaining("Archived Active Memory session toggles legacy source"),
    ]);
    const entries = await createDoctorContext(env)
      .openPluginStateKeyedStore({
        namespace: "session-toggles",
        maxEntries: 10_000,
      })
      .entries();
    expect(entries).toMatchObject([{ value: liveEntry }]);
  });

  it("imports the maximum supported legacy session opt-outs under the file cap", async () => {
    const sourcePath = path.join(stateDir, "plugins", "active-memory", "session-toggles.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    const sessions = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [
        `telegram:dm:${String(index).padStart(5, "0")}`,
        { disabled: true, updatedAt: index },
      ]),
    );
    const payload = JSON.stringify({ sessions });
    expect(Buffer.byteLength(payload, "utf8")).toBeLessThan(LEGACY_TOGGLE_STATE_MAX_BYTES);
    await fs.writeFile(sourcePath, payload);

    const migration = expectDefined(stateMigrations[0], "active-memory state migration");
    await expect(
      migration.detectLegacyState({
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      }),
    ).resolves.toMatchObject({
      preview: [expect.stringContaining("10000 entries")],
    });

    const result = await migration.migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 10000 Active Memory session toggle entries"),
      expect.stringContaining("Archived Active Memory session toggles legacy source"),
    ]);
    await expect(fs.access(sourcePath)).rejects.toThrow();

    const entries = await createDoctorContext(env)
      .openPluginStateKeyedStore({
        namespace: "session-toggles",
        maxEntries: 10_000,
      })
      .entries();
    expect(entries).toHaveLength(10_000);
  });

  it("recovers valid opt-outs from an oversized legacy source within the bounded recovery budget", async () => {
    const sourcePath = path.join(stateDir, "plugins", "active-memory", "session-toggles.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    const padding = "x".repeat(LEGACY_TOGGLE_STATE_MAX_BYTES);
    const sessions = Object.fromEntries(
      Array.from({ length: 2 }, (_, index) => [
        `telegram:dm:${String(index).padStart(5, "0")}`,
        { disabled: true, updatedAt: index },
      ]),
    );
    const payload = JSON.stringify({
      sessions: { ...sessions, __padding__: { disabled: false, updatedAt: 0, note: padding } },
    });
    expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(LEGACY_TOGGLE_STATE_MAX_BYTES);
    await fs.writeFile(sourcePath, payload);

    const migration = expectDefined(stateMigrations[0], "active-memory state migration");
    await expect(
      migration.detectLegacyState({
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      }),
    ).resolves.toMatchObject({
      preview: [expect.stringContaining("2 entries")],
    });

    const result = await migration.migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 2 Active Memory session toggle entries"),
      expect.stringContaining("Archived Active Memory session toggles legacy source"),
    ]);
    await expect(fs.access(sourcePath)).rejects.toThrow();
    await expect(fs.access(`${sourcePath}.migrated`)).resolves.toBeUndefined();

    const entries = await createDoctorContext(env)
      .openPluginStateKeyedStore({
        namespace: "session-toggles",
        maxEntries: 10_000,
      })
      .entries();
    expect(entries).toHaveLength(2);
  });

  it("warns and keeps an oversized legacy source that cannot be read within the bounded recovery budget", async () => {
    const sourcePath = path.join(stateDir, "plugins", "active-memory", "session-toggles.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, Buffer.alloc(LEGACY_TOGGLE_RECOVERY_MAX_BYTES + 1));

    const migration = expectDefined(stateMigrations[0], "active-memory state migration");
    await expect(
      migration.detectLegacyState({
        config: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context: createDoctorContext(env),
      }),
    ).resolves.toMatchObject({
      preview: [expect.stringContaining("cannot be recovered")],
    });

    const result = await migration.migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining(`exceeds ${LEGACY_TOGGLE_RECOVERY_MAX_BYTES} bytes`),
    ]);
    await expect(fs.access(sourcePath)).resolves.toBeUndefined();
    await expect(fs.access(`${sourcePath}.migrated`)).rejects.toThrow();
  });

  it("preserves valid opt-outs from an oversized source that also contains malformed records", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T00:00:00.000Z"));
    const sourcePath = path.join(stateDir, "plugins", "active-memory", "session-toggles.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    const padding = "x".repeat(LEGACY_TOGGLE_STATE_MAX_BYTES);
    const payload = `{"sessions":{"telegram:dm:valid-1":{"disabled":true,"updatedAt":1700},"telegram:dm:bad-disabled":{"disabled":"yes","updatedAt":1701},"telegram:dm:valid-2":{"disabled":true,"updatedAt":1702},"telegram:dm:bad-timestamp":{"disabled":true,"updatedAt":"not-a-number"},"telegram:dm:infinity-timestamp":{"disabled":true,"updatedAt":1e999},"__padding__":{"disabled":false,"updatedAt":0,"note":"${padding}"}}}`;
    expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(LEGACY_TOGGLE_STATE_MAX_BYTES);
    await fs.writeFile(sourcePath, payload);

    const migration = expectDefined(stateMigrations[0], "active-memory state migration");
    const result = await migration.migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 4 Active Memory session toggle entries"),
      expect.stringContaining("Archived Active Memory session toggles legacy source"),
    ]);
    await expect(fs.access(sourcePath)).rejects.toThrow();

    const entries = await createDoctorContext(env)
      .openPluginStateKeyedStore({
        namespace: "session-toggles",
        maxEntries: 10_000,
      })
      .entries();
    expect(entries).toHaveLength(4);
    expect(entries.map((entry) => (entry.value as { sessionKey?: unknown }).sessionKey)).toEqual(
      expect.arrayContaining([
        "telegram:dm:valid-1",
        "telegram:dm:valid-2",
        "telegram:dm:bad-timestamp",
        "telegram:dm:infinity-timestamp",
      ]),
    );
    const normalized = entries.find(
      (entry) =>
        (entry.value as { sessionKey?: unknown }).sessionKey === "telegram:dm:infinity-timestamp",
    );
    expect((normalized?.value as { updatedAt?: unknown } | undefined)?.updatedAt).toBe(
      Date.parse("2026-07-10T00:00:00.000Z"),
    );
  });

  it("preserves JSON escapes when decoding recovered session keys", async () => {
    const sourcePath = path.join(stateDir, "plugins", "active-memory", "session-toggles.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    const padding = "x".repeat(LEGACY_TOGGLE_STATE_MAX_BYTES);
    const payload = `{"sessions":{"telegram\\u003adm\\u003a123":{"disabled":true,"updatedAt":1700},"telegram\\\\quoted":{"disabled":true,"updatedAt":1701},"__padding__":{"disabled":false,"updatedAt":0,"note":"${padding}"}}}`;
    expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(LEGACY_TOGGLE_STATE_MAX_BYTES);
    await fs.writeFile(sourcePath, payload);

    const migration = expectDefined(stateMigrations[0], "active-memory state migration");
    const result = await migration.migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 2 Active Memory session toggle entries"),
      expect.stringContaining("Archived Active Memory session toggles legacy source"),
    ]);
    const entries = await createDoctorContext(env)
      .openPluginStateKeyedStore({
        namespace: "session-toggles",
        maxEntries: 10_000,
      })
      .entries();
    const sessionKeys = entries
      .map((entry) => String((entry.value as { sessionKey?: unknown }).sessionKey))
      .toSorted((left, right) => left.localeCompare(right));
    expect(sessionKeys).toEqual(["telegram:dm:123", "telegram\\quoted"]);
  });

  it("keeps the final JSON-visible value for duplicate session keys in an oversized source", async () => {
    const sourcePath = path.join(stateDir, "plugins", "active-memory", "session-toggles.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    const padding = "x".repeat(LEGACY_TOGGLE_STATE_MAX_BYTES);
    const payload = `{"sessions":{"telegram:dm:dup":{"disabled":true,"updatedAt":1700},"telegram:dm:dup":{"disabled":false,"updatedAt":1701},"__padding__":{"disabled":false,"updatedAt":0,"note":"${padding}"}}}`;
    expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(LEGACY_TOGGLE_STATE_MAX_BYTES);
    await fs.writeFile(sourcePath, payload);

    const migration = expectDefined(stateMigrations[0], "active-memory state migration");
    const result = await migration.migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([]);
    await expect(fs.access(sourcePath)).resolves.toBeUndefined();
    await expect(fs.access(`${sourcePath}.migrated`)).rejects.toThrow();
    const entries = await createDoctorContext(env)
      .openPluginStateKeyedStore({
        namespace: "session-toggles",
        maxEntries: 10_000,
      })
      .entries();
    expect(entries).toHaveLength(0);
  });

  it("skips non-object session records while recovering valid siblings from an oversized source", async () => {
    const sourcePath = path.join(stateDir, "plugins", "active-memory", "session-toggles.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    const padding = "x".repeat(LEGACY_TOGGLE_STATE_MAX_BYTES);
    const payload = `{"sessions":{"telegram:dm:valid":{"disabled":true,"updatedAt":1700},"telegram:dm:null":null,"telegram:dm:array":[],"telegram:dm:scalar":5,"__padding__":{"disabled":false,"updatedAt":0,"note":"${padding}"}}}`;
    expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(LEGACY_TOGGLE_STATE_MAX_BYTES);
    await fs.writeFile(sourcePath, payload);

    const migration = expectDefined(stateMigrations[0], "active-memory state migration");
    const result = await migration.migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 1 Active Memory session toggle entry"),
      expect.stringContaining("Archived Active Memory session toggles legacy source"),
    ]);
    const entries = await createDoctorContext(env)
      .openPluginStateKeyedStore({
        namespace: "session-toggles",
        maxEntries: 10_000,
      })
      .entries();
    expect(entries.map((entry) => (entry.value as { sessionKey?: unknown }).sessionKey)).toEqual([
      "telegram:dm:valid",
    ]);
  });

  it("finds the sessions property regardless of outer-member order in an oversized source", async () => {
    const sourcePath = path.join(stateDir, "plugins", "active-memory", "session-toggles.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    const padding = "x".repeat(LEGACY_TOGGLE_STATE_MAX_BYTES);
    const payload = `{"format":1,"note":"extra","sessions":{"telegram:dm:valid":{"disabled":true,"updatedAt":1700}},"__padding__":{"disabled":false,"updatedAt":0,"note":"${padding}"}}`;
    expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(LEGACY_TOGGLE_STATE_MAX_BYTES);
    await fs.writeFile(sourcePath, payload);

    const migration = expectDefined(stateMigrations[0], "active-memory state migration");
    const result = await migration.migrateLegacyState({
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringContaining("Migrated 1 Active Memory session toggle entry"),
      expect.stringContaining("Archived Active Memory session toggles legacy source"),
    ]);
    const entries = await createDoctorContext(env)
      .openPluginStateKeyedStore({
        namespace: "session-toggles",
        maxEntries: 10_000,
      })
      .entries();
    expect(entries.map((entry) => (entry.value as { sessionKey?: unknown }).sessionKey)).toEqual([
      "telegram:dm:valid",
    ]);
  });
});
