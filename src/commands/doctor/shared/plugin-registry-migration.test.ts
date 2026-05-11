import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginCandidate } from "../../../plugins/discovery.js";
import {
  readPersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndex,
} from "../../../plugins/installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "../../../plugins/installed-plugin-index.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
} from "../../../plugins/test-helpers/fs-fixtures.js";
import {
  DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV,
  FORCE_PLUGIN_REGISTRY_MIGRATION_ENV,
  migratePluginRegistryForInstall,
  preflightPluginRegistryInstallMigration,
} from "./plugin-registry-migration.js";

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
  options: { enabledByDefault?: boolean } = {},
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
    }),
    "utf8",
  );
  return {
    idHint: id,
    source: path.join(rootDir, "index.ts"),
    rootDir,
    origin,
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
}

function readRecordField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
}

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

describe("plugin registry install migration", () => {
  it("short-circuits when a current registry file already exists", async () => {
    const stateDir = makeTempDir();
    const filePath = path.join(stateDir, "plugins", "installs.json");
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
    const filePath = path.join(stateDir, "plugins", "installs.json");
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, migrationVersion: 0 }), "utf8");

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
      readConfig: async () => ({}),
      env: hermeticEnv(),
    });
    expectRecordFields(requireRecord(result, "migration result"), {
      status: "migrated",
      migrated: true,
    });
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
      candidates: [createCandidate(pluginDir)],
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

  it("marks force migration env as deprecated break-glass", () => {
    const result = preflightPluginRegistryInstallMigration({
      stateDir: makeTempDir(),
      env: hermeticEnv({
        [FORCE_PLUGIN_REGISTRY_MIGRATION_ENV]: "1",
      }),
    });
    expectRecordFields(requireRecord(result, "preflight result"), {
      action: "migrate",
      force: true,
    });
    expect(result.deprecationWarnings).toHaveLength(1);
    expect(result.deprecationWarnings[0]).toContain(
      `${FORCE_PLUGIN_REGISTRY_MIGRATION_ENV} is deprecated`,
    );
  });

  it("treats falsey env flag strings as unset", async () => {
    const stateDir = makeTempDir();
    await writePersistedInstalledPluginIndex(createCurrentIndex(), { stateDir });

    const result = preflightPluginRegistryInstallMigration({
      stateDir,
      env: hermeticEnv({
        [DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV]: "0",
        [FORCE_PLUGIN_REGISTRY_MIGRATION_ENV]: "false",
      }),
    });
    expectRecordFields(requireRecord(result, "preflight result"), {
      action: "skip-existing",
      force: false,
      deprecationWarnings: [],
    });
  });
});
