import fs from "node:fs";
import path from "node:path";
// Plugin registry migration tests cover doctor repair of persisted plugin registry state.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { recordPluginCandidateInstallOwner } from "../../../plugins/candidate-install-owner.js";
import type { PluginCandidate } from "../../../plugins/discovery.js";
import { writePersistedInstalledPluginIndex } from "../../../plugins/installed-plugin-index-store-write.js";
import {
  readPersistedInstalledPluginIndex,
  resolveInstalledPluginIndexStorePath,
} from "../../../plugins/installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "../../../plugins/installed-plugin-index.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
} from "../../../plugins/test-helpers/fs-fixtures.js";
import * as stateDbReadOnly from "../../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { migratePluginRegistryForInstall } from "./plugin-registry-migration.js";
const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-registry-migration", tempDirs);
}

function hermeticEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_VERSION: "2026.4.25",
    VITEST: "true",
    ...overrides,
  };
}

function createCandidate(
  rootDir: string,
  id = "demo",
  origin: PluginCandidate["origin"] = "global",
  options: {
    enabledByDefault?: boolean;
    installOwner?: string;
    manifest?: Record<string, unknown>;
  } = {},
): PluginCandidate {
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load while migrating plugin registry');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      name: id,
      ...(options.enabledByDefault ? { enabledByDefault: true } : {}),
      configSchema: { type: "object" },
      providers: [id],
      ...options.manifest,
    }),
    "utf8",
  );
  return recordPluginCandidateInstallOwner(
    {
      idHint: id,
      source: path.join(rootDir, "index.ts"),
      rootDir,
      origin,
    },
    options.installOwner,
  );
}

function createCurrentIndex(): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    installRecords: {},
    plugins: [],
    diagnostics: [],
  };
}

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");
function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectSha256(value: unknown) {
  expect(typeof value).toBe("string");
  expect(value).toMatch(/^[a-f0-9]{64}$/u);
}

function requireMigratedIndex(
  result: Awaited<ReturnType<typeof migratePluginRegistryForInstall>>,
): InstalledPluginIndex {
  if (result.status !== "migrated") {
    throw new Error(`Expected migration result to be migrated, got ${result.status}`);
  }
  return result.current;
}

function requirePlugin(index: InstalledPluginIndex | null | undefined, pluginId: string) {
  const plugin = index?.plugins.find((entry) => entry.pluginId === pluginId);
  if (!plugin) {
    throw new Error(`Expected plugin record for ${pluginId}`);
  }
  return plugin;
}

function insertStalePersistedIndexRow(stateDir: string, installRecordsJson = "{}") {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const valueJson = JSON.stringify({
        revision: 123,
        index: {
          version: 1,
          warning: null,
          hostContractVersion: "2026.4.25",
          compatRegistryVersion: "compat-v1",
          migrationVersion: 0,
          policyHash: "stale-policy",
          generatedAtMs: 123,
          installRecords: JSON.parse(installRecordsJson) as unknown,
          plugins: [],
          diagnostics: [],
        },
      });
      db.prepare(
        `
          INSERT OR REPLACE INTO config_machine_state (state_key, value_json, updated_at_ms)
          VALUES ('plugins.installedIndex', ?, 123)
        `,
      ).run(valueJson);
    },
    { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
  );
}

describe("plugin registry install migration", () => {
  it.each([1, 2])(
    "stops migration with the original error when required read %s fails",
    async (failedRead) => {
      const stateDir = makeTempDir();
      const records = { authoritative: { source: "npm", spec: "authoritative@1.0.0" } };
      insertStalePersistedIndexRow(stateDir, JSON.stringify(records));
      const error = Object.assign(new Error("database is locked"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 5,
      });
      const read = stateDbReadOnly.withExistingOpenClawStateDatabaseReadOnly;
      const readSpy = vi.spyOn(stateDbReadOnly, "withExistingOpenClawStateDatabaseReadOnly");
      if (failedRead === 2) {
        readSpy.mockImplementationOnce(read);
      }
      readSpy.mockImplementationOnce(() => {
        throw error;
      });
      const readConfig = vi.fn(() => ({}));
      await expect
        .soft(
          migratePluginRegistryForInstall({
            stateDir,
            readConfig,
            candidates: [],
            env: hermeticEnv(),
          }),
        )
        .rejects.toBe(error);
      expect.soft(readConfig).not.toHaveBeenCalled();
      readSpy.mockRestore();
      const row = runOpenClawStateWriteTransaction(
        ({ db }) =>
          db
            .prepare(
              "SELECT value_json, updated_at_ms FROM config_machine_state WHERE state_key = 'plugins.installedIndex'",
            )
            .get(),
        { env: { OPENCLAW_STATE_DIR: stateDir } },
      );
      expect(row).toMatchObject({ updated_at_ms: 123 });
      const restored = await migratePluginRegistryForInstall({
        stateDir,
        readConfig,
        candidates: [],
        env: hermeticEnv(),
      });
      expect(requireMigratedIndex(restored).installRecords).toEqual(records);
    },
  );

  it("short-circuits when a current registry file already exists", async () => {
    const stateDir = makeTempDir();
    const filePath = resolveInstalledPluginIndexStorePath({ stateDir });
    await writePersistedInstalledPluginIndex(createCurrentIndex(), { stateDir });
    const readConfig = vi.fn(async () => ({}));

    const result = await migratePluginRegistryForInstall({
      stateDir,
      readConfig,
      env: hermeticEnv(),
    });
    expectRecordFields(requireRecord(result, "migration result"), {
      status: "skip-existing",
      migrated: false,
    });
    expectRecordFields(requireRecord(result.preflight, "migration preflight"), {
      action: "skip-existing",
      filePath,
    });
    expect(readConfig).not.toHaveBeenCalled();
  });

  it("migrates when an existing registry file is not current", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    insertStalePersistedIndexRow(stateDir);

    const result = await migratePluginRegistryForInstall({
      stateDir,
      candidates: [createCandidate(pluginDir)],
      readConfig: async () => ({}),
      env: hermeticEnv(),
    });
    expectRecordFields(requireRecord(result, "migration result"), {
      status: "migrated",
    });
    expect(result.preflight.action).toBe("migrate");

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    expect(persisted?.migrationVersion).toBe(1);
    expectRecordFields(requirePlugin(persisted, "demo") as unknown as Record<string, unknown>, {
      pluginId: "demo",
    });
  });

  it("rejects invalid SQLite install records without rewriting the row", async () => {
    const stateDir = makeTempDir();
    const installRecordsJson = '{"__proto__":{"source":"bogus"}}';
    insertStalePersistedIndexRow(stateDir, installRecordsJson);

    await expect(
      migratePluginRegistryForInstall({
        stateDir,
        readConfig: async () => ({}),
        env: hermeticEnv(),
      }),
    ).rejects.toThrow(
      "delete only the config_machine_state row with state_key='plugins.installedIndex'",
    );

    const row = runOpenClawStateWriteTransaction(
      ({ db }) =>
        db
          .prepare(
            `SELECT value_json, updated_at_ms
               FROM config_machine_state
              WHERE state_key = 'plugins.installedIndex'`,
          )
          .get() as { value_json: string; updated_at_ms: number | bigint },
      { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
    );
    expect(row.updated_at_ms).toBe(123);
    const persistedValue = JSON.parse(row.value_json) as {
      index: { migrationVersion: number; installRecords: unknown };
    };
    expect(persistedValue.index.migrationVersion).toBe(0);
    expect(JSON.stringify(persistedValue.index.installRecords)).toBe(
      JSON.stringify(JSON.parse(installRecordsJson)),
    );
  });

  it("rejects invalid config install records before recovery or persistence", async () => {
    const stateDir = makeTempDir();
    const invalidConfig = JSON.parse(
      '{"plugins":{"installs":{"constructor":{"source":"bogus"}}}}',
    ) as OpenClawConfig;

    await expect(
      migratePluginRegistryForInstall({
        stateDir,
        readConfig: async () => invalidConfig,
        env: hermeticEnv(),
      }),
    ).rejects.toThrow(
      "Back up openclaw.json, correct or remove the invalid retired plugins.installs record",
    );
    expect(fs.existsSync(resolveInstalledPluginIndexStorePath({ stateDir }))).toBe(false);
  });

  it("persists migration-relevant plugin records without dropping explicit disabled state", async () => {
    const stateDir = makeTempDir();
    const enabledDir = path.join(stateDir, "plugins", "enabled-demo");
    const disabledDir = path.join(stateDir, "plugins", "disabled-demo");
    const unusedBundledDir = path.join(stateDir, "plugins", "unused-bundled");
    fs.mkdirSync(enabledDir, { recursive: true });
    fs.mkdirSync(disabledDir, { recursive: true });
    fs.mkdirSync(unusedBundledDir, { recursive: true });

    const result = await migratePluginRegistryForInstall({
      stateDir,
      candidates: [
        createCandidate(enabledDir, "enabled-demo"),
        createCandidate(disabledDir, "disabled-demo", "bundled"),
        createCandidate(unusedBundledDir, "unused-bundled", "bundled"),
      ],
      readConfig: async () => ({
        plugins: {
          entries: {
            "disabled-demo": {
              enabled: false,
            },
          },
        },
      }),
      env: hermeticEnv(),
    });
    expectRecordFields(requireRecord(result, "migration result"), {
      status: "migrated",
    });
    const current = requireMigratedIndex(result);
    expect(requirePlugin(current, "enabled-demo").enabled).toBe(true);
    expect(requirePlugin(current, "disabled-demo").enabled).toBe(false);

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    expect(requirePlugin(persisted, "enabled-demo").enabled).toBe(true);
    expect(requirePlugin(persisted, "disabled-demo").enabled).toBe(false);
    expect(persisted?.plugins.map((plugin) => plugin.pluginId)).toEqual([
      "enabled-demo",
      "disabled-demo",
    ]);
  });

  it("keeps enabled-by-default bundled provider plugins discoverable for setup", async () => {
    const stateDir = makeTempDir();
    const openaiDir = path.join(stateDir, "plugins", "openai");
    const unusedBundledDir = path.join(stateDir, "plugins", "unused-bundled");
    fs.mkdirSync(openaiDir, { recursive: true });
    fs.mkdirSync(unusedBundledDir, { recursive: true });

    const result = await migratePluginRegistryForInstall({
      stateDir,
      candidates: [
        createCandidate(openaiDir, "openai", "bundled", { enabledByDefault: true }),
        createCandidate(unusedBundledDir, "unused-bundled", "bundled"),
      ],
      readConfig: async () => ({}),
      env: hermeticEnv(),
    });
    expectRecordFields(requireRecord(result, "migration result"), {
      status: "migrated",
    });
    const current = requireMigratedIndex(result);
    expect(requirePlugin(current, "openai").enabledByDefault).toBe(true);

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    expect(persisted?.plugins.map((plugin) => plugin.pluginId)).toEqual(["openai"]);
  });

  it("keeps bundled migration contracts discoverable after install", async () => {
    const stateDir = makeTempDir();
    const migrationDir = path.join(stateDir, "plugins", "migrate-demo");
    const unusedBundledDir = path.join(stateDir, "plugins", "unused-bundled");
    fs.mkdirSync(migrationDir, { recursive: true });
    fs.mkdirSync(unusedBundledDir, { recursive: true });

    const result = await migratePluginRegistryForInstall({
      stateDir,
      candidates: [
        createCandidate(migrationDir, "migrate-demo", "bundled", {
          manifest: {
            providers: [],
            contracts: { migrationProviders: ["demo"] },
          },
        }),
        createCandidate(unusedBundledDir, "unused-bundled", "bundled"),
      ],
      readConfig: async () => ({}),
      env: hermeticEnv(),
    });

    const current = requireMigratedIndex(result);
    expect(current.plugins.map((plugin) => plugin.pluginId)).toEqual(["migrate-demo"]);

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    expect(persisted?.plugins.map((plugin) => plugin.pluginId)).toEqual(["migrate-demo"]);
  });

  it("keeps legacy OpenAI Codex plugin references doctor-only", async () => {
    const stateDir = makeTempDir();
    const openaiDir = path.join(stateDir, "plugins", "openai");
    const unusedBundledDir = path.join(stateDir, "plugins", "unused-bundled");
    fs.mkdirSync(openaiDir, { recursive: true });
    fs.mkdirSync(unusedBundledDir, { recursive: true });

    const result = await migratePluginRegistryForInstall({
      stateDir,
      candidates: [
        createCandidate(openaiDir, "openai", "bundled"),
        createCandidate(unusedBundledDir, "unused-bundled", "bundled"),
      ],
      readConfig: async () => ({
        plugins: {
          entries: {
            "openai-codex": {
              enabled: true,
            },
          },
        },
      }),
      env: hermeticEnv(),
    });

    const current = requireMigratedIndex(result);
    expect(current.plugins.map((plugin) => plugin.pluginId)).toEqual(["openai"]);

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    expect(persisted?.plugins.map((plugin) => plugin.pluginId)).toEqual(["openai"]);
  });

  it("keeps bundled memory command plugins discoverable for first-run CLI registration", async () => {
    const stateDir = makeTempDir();
    const memoryDir = path.join(stateDir, "plugins", "memory-core");
    const unusedBundledDir = path.join(stateDir, "plugins", "unused-bundled");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.mkdirSync(unusedBundledDir, { recursive: true });

    const result = await migratePluginRegistryForInstall({
      stateDir,
      candidates: [
        createCandidate(memoryDir, "memory-core", "bundled", {
          manifest: {
            kind: "memory",
            providers: [],
            contracts: { tools: ["memory_search"] },
            commandAliases: [
              {
                name: "dreaming",
                kind: "runtime-slash",
                cliCommand: "memory",
              },
            ],
          },
        }),
        createCandidate(unusedBundledDir, "unused-bundled", "bundled"),
      ],
      readConfig: async () => ({}),
      env: hermeticEnv(),
    });
    expectRecordFields(requireRecord(result, "migration result"), {
      status: "migrated",
    });
    const current = requireMigratedIndex(result);
    expect(requirePlugin(current, "memory-core").startup.memory).toBe(true);

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    expect(persisted?.plugins.map((plugin) => plugin.pluginId)).toEqual(["memory-core"]);
  });

  it("supports dry-run preflight without reading config or writing the registry", async () => {
    const stateDir = makeTempDir();
    const readConfig = vi.fn(async () => ({}));

    const result = await migratePluginRegistryForInstall({
      stateDir,
      dryRun: true,
      readConfig,
      env: hermeticEnv(),
    });
    expectRecordFields(requireRecord(result, "migration result"), {
      status: "dry-run",
      migrated: false,
    });
    expect(result.preflight.action).toBe("migrate");
    expect(readConfig).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(stateDir, "plugins", "installs.json"))).toBe(false);
  });

  it("builds missing registry state from discovered plugin manifests", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);

    const result = await migratePluginRegistryForInstall({
      stateDir,
      candidates: [candidate],
      config: {},
      env: hermeticEnv(),
    });
    expectRecordFields(requireRecord(result, "migration result"), {
      status: "migrated",
      migrated: true,
    });
    expect(result.preflight.action).toBe("initialize");
    const current = requireMigratedIndex(result);
    expect(current.refreshReason).toBe("migration");
    expect(current.migrationVersion).toBe(1);
    expect(requirePlugin(current, "demo").pluginId).toBe("demo");

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    expect(persisted?.refreshReason).toBe("migration");
    expect(requirePlugin(persisted, "demo").pluginId).toBe("demo");
  });

  it("seeds first-run install records from shipped plugins.installs config", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });

    const result = await migratePluginRegistryForInstall({
      stateDir,
      candidates: [createCandidate(pluginDir, "demo", "global", { installOwner: "demo" })],
      readConfig: async () => ({
        plugins: {
          entries: {
            demo: {
              enabled: true,
            },
          },
          installs: {
            demo: {
              source: "npm",
              spec: "demo@1.0.0",
              installPath: pluginDir,
            },
          },
        },
      }),
      env: hermeticEnv(),
    });
    expectRecordFields(requireRecord(result, "migration result"), {
      status: "migrated",
    });
    const current = requireMigratedIndex(result);
    expect(current.installRecords.demo).toEqual({
      source: "npm",
      spec: "demo@1.0.0",
      installPath: pluginDir,
    });
    expect(requirePlugin(current, "demo").pluginId).toBe("demo");
    expectSha256(requirePlugin(current, "demo").installRecordHash);

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    expect(persisted?.installRecords.demo).toEqual({
      source: "npm",
      spec: "demo@1.0.0",
      installPath: pluginDir,
    });
    expect(requirePlugin(persisted, "demo").pluginId).toBe("demo");
    expectSha256(requirePlugin(persisted, "demo").installRecordHash);
  });

  it("preserves shipped install records when the plugin manifest cannot be discovered", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "missing");

    const result = await migratePluginRegistryForInstall({
      stateDir,
      candidates: [],
      readConfig: async () => ({
        plugins: {
          entries: {
            missing: {
              enabled: true,
            },
          },
          installs: {
            missing: {
              source: "npm",
              spec: "missing-plugin@1.0.0",
              installPath: pluginDir,
            },
          },
        },
      }),
      env: hermeticEnv(),
    });
    expectRecordFields(requireRecord(result, "migration result"), {
      status: "migrated",
    });
    const current = requireMigratedIndex(result);
    expect(current.installRecords.missing).toEqual({
      source: "npm",
      spec: "missing-plugin@1.0.0",
      installPath: pluginDir,
    });
    expect(current.plugins).toEqual([]);

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    expect(persisted?.installRecords.missing).toEqual({
      source: "npm",
      spec: "missing-plugin@1.0.0",
      installPath: pluginDir,
    });
    expect(persisted?.plugins).toEqual([]);
  });
});
