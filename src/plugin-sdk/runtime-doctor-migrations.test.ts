import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/legacy-state-migration.types.js";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import {
  defineLegacyJsonStateMigration,
  definePluginDoctorMigrationFromPlans,
  LEGACY_JSON_MIGRATION_MAX_BYTES,
  type PluginDoctorStateMigration,
  type PluginDoctorStateMigrationContext,
} from "./runtime-doctor-migrations.js";

const runLegacyMigrationPlans = vi.hoisted(() => vi.fn());
const executorModuleLoads = vi.hoisted(() => vi.fn());

vi.mock("../infra/state-migrations.plugin-state.js", () => {
  executorModuleLoads();
  return { runLegacyMigrationPlans };
});

describe("defineLegacyJsonStateMigration retention", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let context: PluginDoctorStateMigrationContext;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-json-migration-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    context = {
      openPluginStateKeyedStore: (options) =>
        createPluginStateKeyedStore("migration-fixture", { ...options, env }),
    };
  });

  afterEach(async () => {
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it.each(["imported", "pre-existing"])(
    "preserves the source and warns when a row is evicted (%s)",
    async (evicted) => {
      const sourcePath = path.join(stateDir, "legacy.json");
      const rows = ["first", "second", ...(evicted === "imported" ? ["third"] : [])].map((key) => ({
        key,
        value: key,
      }));
      const source = JSON.stringify(rows);
      await fs.writeFile(sourcePath, source);
      const store = context.openPluginStateKeyedStore({ namespace: "entries", maxEntries: 2 });
      if (evicted === "pre-existing") {
        await store.register("existing", "canonical");
      }
      const migration = defineLegacyJsonStateMigration({
        id: "retention-fixture",
        label: "Fixture entries",
        resolvePath: () => sourcePath,
        parse: (value) => value as typeof rows,
        namespace: "entries",
        maxEntries: 2,
        describeEntries: () => ({
          preview: ["legacy entries"],
          change: ({ imported }) => `Migrated ${imported} entries`,
        }),
        toRows: (entries) => entries,
      });
      const params = { config: {}, env, stateDir, oauthDir: stateDir, context };

      const result = await migration.migrateLegacyState(params);

      expect(await store.entries()).toHaveLength(2);
      expect(result).toEqual({
        changes: [],
        warnings: [expect.stringContaining("failed to retain every required entry (1 missing)")],
      });
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(source);
      await expect(fs.access(`${sourcePath}.migrated`)).rejects.toThrow();
      await expect(migration.detectLegacyState(params)).resolves.not.toBeNull();
    },
  );
});

const migrationInput = {
  config: {},
  env: {},
  stateDir: "/state",
  oauthDir: "/oauth",
  context: { openPluginStateKeyedStore: vi.fn() } as never,
};

describe("definePluginDoctorMigrationFromPlans", () => {
  it("maps previews and delegates normalized plans to the existing executor", async () => {
    const plans: ChannelLegacyStateMigrationPlan[] = [
      {
        kind: "plugin-state-import",
        label: "Cache",
        sourcePath: "/state/cache.json",
        targetPath: "plugin state:cache",
        pluginId: "demo",
        namespace: "cache",
        maxEntries: 10,
        scopeKey: "",
        readEntries: () => [],
      },
      {
        kind: "move",
        label: "Credentials",
        sourcePath: "/oauth/creds.json",
        targetPath: "/oauth/demo/creds.json",
      },
      {
        kind: "copy",
        label: "Backup",
        sourcePath: "/state/backup.json",
        targetPath: "/state/demo/backup.json",
      },
    ];
    const migration = definePluginDoctorMigrationFromPlans({
      id: "demo-state",
      label: "Demo state",
      resolvePlans: () => plans,
    });

    await expect(migration.detectLegacyState(migrationInput)).resolves.toEqual({
      preview: [
        "- Cache: /state/cache.json",
        "- Credentials: /oauth/creds.json → /oauth/demo/creds.json",
        "- Backup: /state/backup.json → /state/demo/backup.json",
      ],
    });
    expect(executorModuleLoads).not.toHaveBeenCalled();

    runLegacyMigrationPlans.mockResolvedValueOnce({
      changes: ["migrated"],
      warnings: ["warning"],
    });
    await expect(migration.migrateLegacyState(migrationInput)).resolves.toEqual({
      changes: ["migrated"],
      warnings: ["warning"],
    });
    expect(executorModuleLoads).toHaveBeenCalledTimes(1);
    expect(runLegacyMigrationPlans).toHaveBeenCalledTimes(1);
    expect(runLegacyMigrationPlans.mock.calls[0]?.[0]).toEqual([
      { ...plans[0], stateDir: "/state" },
      plans[1],
      plans[2],
    ]);
  });

  it("returns null when no legacy plans resolve", async () => {
    const migration = definePluginDoctorMigrationFromPlans({
      id: "empty-state",
      label: "Empty state",
      resolvePlans: () => [],
    });

    await expect(migration.detectLegacyState(migrationInput)).resolves.toBeNull();
  });
});

type TestState = { value: string };

function createJsonMigration(
  options: {
    maxBytes?: number;
    recoveryMaxBytes?: number;
    oversizedSource?: (params: { filePath: string; maxBytes: number }) => {
      warning: string;
      preview: string;
    };
  } = {},
): PluginDoctorStateMigration {
  return defineLegacyJsonStateMigration<TestState>({
    id: "runtime-doctor-json-migration-test",
    label: "runtime doctor JSON test",
    resolvePath: (dir) => path.join(dir, "legacy.json"),
    parse: (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      const candidate = value as { value?: unknown };
      return typeof candidate.value === "string" ? { value: candidate.value } : null;
    },
    namespace: "runtime-doctor-json-migration-test",
    maxEntries: 1,
    ...options,
    describeEntries: () => ({
      preview: ["loaded"],
      change: () => null,
    }),
    toRows: (source) => [{ key: "state", value: source }],
  });
}

function detectParams(stateDir: string, context: PluginDoctorStateMigrationContext) {
  return {
    config: {},
    env: process.env,
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
    context,
  };
}

describe("defineLegacyJsonStateMigration", () => {
  let stateDir = "";
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-runtime-doctor-migration-");
  });

  it("preserves unbounded reads when maxBytes is omitted", async () => {
    const sourcePath = path.join(stateDir, "legacy.json");
    const payload = `${JSON.stringify({ value: "ok" })}${" ".repeat(LEGACY_JSON_MIGRATION_MAX_BYTES)}`;
    await fs.writeFile(sourcePath, payload, "utf8");

    const migration = createJsonMigration();
    await expect(
      migration.detectLegacyState(detectParams(stateDir, {} as PluginDoctorStateMigrationContext)),
    ).resolves.toEqual({ preview: ["loaded"] });
  });

  it("follows symlinked legacy sources when maxBytes is omitted", async () => {
    const sourcePath = path.join(stateDir, "legacy.json");
    const targetPath = path.join(stateDir, "legacy-target.json");
    const source = JSON.stringify({ value: "symlinked" });
    await fs.writeFile(targetPath, source, "utf8");
    await fs.symlink(targetPath, sourcePath);

    const migration = createJsonMigration();
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const context: PluginDoctorStateMigrationContext = {
      openPluginStateKeyedStore: (options) =>
        createPluginStateKeyedStore("migration-symlink-fixture", { ...options, env }),
    };
    const params = detectParams(stateDir, context);

    await expect(migration.detectLegacyState(params)).resolves.toEqual({ preview: ["loaded"] });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [expect.stringContaining("Archived runtime doctor JSON test legacy source")],
      warnings: [],
    });
    await expect(fs.readFile(`${sourcePath}.migrated`, "utf8")).resolves.toBe(source);
    await expect(fs.access(sourcePath)).rejects.toThrow();
  });

  it("follows symlinked legacy sources under an explicit maxBytes limit", async () => {
    const sourcePath = path.join(stateDir, "legacy.json");
    const targetPath = path.join(stateDir, "legacy-target.json");
    const source = JSON.stringify({ value: "capped-symlinked" });
    await fs.writeFile(targetPath, source, "utf8");
    await fs.symlink(targetPath, sourcePath);

    const migration = createJsonMigration({ maxBytes: 128 });
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const context: PluginDoctorStateMigrationContext = {
      openPluginStateKeyedStore: (options) =>
        createPluginStateKeyedStore("migration-capped-symlink-fixture", { ...options, env }),
    };
    const params = detectParams(stateDir, context);

    await expect(migration.detectLegacyState(params)).resolves.toEqual({ preview: ["loaded"] });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [expect.stringContaining("Archived runtime doctor JSON test legacy source")],
      warnings: [],
    });
    const archivePath = `${sourcePath}.migrated`;
    await expect(fs.readFile(archivePath, "utf8")).resolves.toBe(source);
    expect((await fs.lstat(archivePath)).isSymbolicLink()).toBe(true);
    await expect(fs.access(sourcePath)).rejects.toThrow();
  });

  it("honors an explicit maxBytes limit", async () => {
    const sourcePath = path.join(stateDir, "legacy.json");
    await fs.writeFile(sourcePath, JSON.stringify({ value: "x".repeat(256) }), "utf8");

    const migration = createJsonMigration({ maxBytes: 128 });
    await expect(
      migration.detectLegacyState(detectParams(stateDir, {} as PluginDoctorStateMigrationContext)),
    ).resolves.toEqual({
      preview: [expect.stringContaining("exceeds 128 bytes")],
    });
  });

  it("retries once within recoveryMaxBytes", async () => {
    const sourcePath = path.join(stateDir, "legacy.json");
    await fs.writeFile(sourcePath, JSON.stringify({ value: "x".repeat(256) }), "utf8");

    const migration = createJsonMigration({ maxBytes: 128, recoveryMaxBytes: 512 });
    await expect(
      migration.detectLegacyState(detectParams(stateDir, {} as PluginDoctorStateMigrationContext)),
    ).resolves.toEqual({ preview: ["loaded"] });
  });

  it("uses the final recovery limit for oversizedSource", async () => {
    const sourcePath = path.join(stateDir, "legacy.json");
    await fs.writeFile(sourcePath, JSON.stringify({ value: "x".repeat(256) }), "utf8");

    const migration = createJsonMigration({
      maxBytes: 128,
      recoveryMaxBytes: 256,
      oversizedSource: ({ filePath, maxBytes }) => ({
        preview: `oversized:${filePath}:${maxBytes}`,
        warning: `retained:${filePath}:${maxBytes}`,
      }),
    });
    const params = detectParams(stateDir, {} as PluginDoctorStateMigrationContext);

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [`oversized:${sourcePath}:256`],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [`retained:${sourcePath}:256`],
    });
  });
});
