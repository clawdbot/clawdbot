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
    OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
    OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: "1",
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

describe("plugin registry install migration", () => {
  it("short-circuits when a current registry file already exists", async () => {
    const stateDir = makeTempDir();
    const filePath = path.join(stateDir, "plugins", "installs.json");
    await writePersistedInstalledPluginIndex(createCurrentIndex(), { stateDir });
    const readConfig = vi.fn(async () => ({}));

    await expect(
      migratePluginRegistryForInstall({
        stateDir,
        readConfig,
        env: hermeticEnv(),
      }),
    ).resolves.toMatchObject({
      status: "skip-existing",
      migrated: false,
      preflight: {
        action: "skip-existing",
        filePath,
      },
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

    await expect(
      migratePluginRegistryForInstall({
        stateDir,
        candidates: [createCandidate(pluginDir)],
        readConfig: async () => ({}),
        env: hermeticEnv(),
      }),
    ).resolves.toMatchObject({
      status: "migrated",
      preflight: {
        action: "migrate",
      },
    });

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toMatchObject({
      migrationVersion: 1,
      plugins: [expect.objectContaining({ pluginId: "demo" })],
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

    await expect(
      migratePluginRegistryForInstall({
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
      }),
    ).resolves.toMatchObject({
      status: "migrated",
      current: {
        plugins: [
          expect.objectContaining({ pluginId: "enabled-demo", enabled: true }),
          expect.objectContaining({ pluginId: "disabled-demo", enabled: false }),
        ],
      },
    });

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toMatchObject({
      plugins: [
        expect.objectContaining({ pluginId: "enabled-demo", enabled: true }),
        expect.objectContaining({ pluginId: "disabled-demo", enabled: false }),
      ],
    });
    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
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

    await expect(
      migratePluginRegistryForInstall({
        stateDir,
        candidates: [
          createCandidate(openaiDir, "openai", "bundled", { enabledByDefault: true }),
          createCandidate(unusedBundledDir, "unused-bundled", "bundled"),
        ],
        readConfig: async () => ({}),
        env: hermeticEnv(),
      }),
    ).resolves.toMatchObject({
      status: "migrated",
      current: {
        plugins: [expect.objectContaining({ pluginId: "openai", enabledByDefault: true })],
      },
    });

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    expect(persisted?.plugins.map((plugin) => plugin.pluginId)).toEqual(["openai"]);
  });

  it("supports dry-run preflight without reading config or writing the registry", async () => {
    const stateDir = makeTempDir();
    const readConfig = vi.fn(async () => ({}));

    await expect(
      migratePluginRegistryForInstall({
        stateDir,
        dryRun: true,
        readConfig,
        env: hermeticEnv(),
      }),
    ).resolves.toMatchObject({
      status: "dry-run",
      migrated: false,
      preflight: {
        action: "migrate",
      },
    });
    expect(readConfig).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(stateDir, "plugins", "installs.json"))).toBe(false);
  });

  it("builds missing registry state from discovered plugin manifests", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createCandidate(pluginDir);

    await expect(
      migratePluginRegistryForInstall({
        stateDir,
        candidates: [candidate],
        readConfig: async () => ({}),
        env: hermeticEnv(),
      }),
    ).resolves.toMatchObject({
      status: "migrated",
      migrated: true,
      current: {
        refreshReason: "migration",
        migrationVersion: 1,
        plugins: [
          expect.objectContaining({
            pluginId: "demo",
          }),
        ],
      },
    });

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toMatchObject({
      refreshReason: "migration",
      plugins: [expect.objectContaining({ pluginId: "demo" })],
    });
  });

  it("seeds first-run install records from shipped plugins.installs config", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });

    await expect(
      migratePluginRegistryForInstall({
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
      }),
    ).resolves.toMatchObject({
      status: "migrated",
      current: {
        installRecords: {
          demo: {
            source: "npm",
            spec: "demo@1.0.0",
            installPath: pluginDir,
          },
        },
        plugins: [
          expect.objectContaining({
            pluginId: "demo",
            installRecordHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          }),
        ],
      },
    });

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toMatchObject({
      installRecords: {
        demo: {
          source: "npm",
          spec: "demo@1.0.0",
          installPath: pluginDir,
        },
      },
      plugins: [
        expect.objectContaining({
          pluginId: "demo",
          installRecordHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ],
    });
  });

  it("preserves shipped install records when the plugin manifest cannot be discovered", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "missing");

    await expect(
      migratePluginRegistryForInstall({
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
      }),
    ).resolves.toMatchObject({
      status: "migrated",
      current: {
        installRecords: {
          missing: {
            source: "npm",
            spec: "missing-plugin@1.0.0",
            installPath: pluginDir,
          },
        },
        plugins: [],
      },
    });

    await expect(readPersistedInstalledPluginIndex({ stateDir })).resolves.toMatchObject({
      installRecords: {
        missing: {
          source: "npm",
          spec: "missing-plugin@1.0.0",
          installPath: pluginDir,
        },
      },
      plugins: [],
    });
  });

  it("marks force migration env as deprecated break-glass", () => {
    expect(
      preflightPluginRegistryInstallMigration({
        stateDir: makeTempDir(),
        env: hermeticEnv({
          [FORCE_PLUGIN_REGISTRY_MIGRATION_ENV]: "1",
        }),
      }),
    ).toMatchObject({
      action: "migrate",
      force: true,
      deprecationWarnings: [
        expect.stringContaining(`${FORCE_PLUGIN_REGISTRY_MIGRATION_ENV} is deprecated`),
      ],
    });
  });

  it("treats falsey env flag strings as unset", async () => {
    const stateDir = makeTempDir();
    await writePersistedInstalledPluginIndex(createCurrentIndex(), { stateDir });

    expect(
      preflightPluginRegistryInstallMigration({
        stateDir,
        env: hermeticEnv({
          [DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV]: "0",
          [FORCE_PLUGIN_REGISTRY_MIGRATION_ENV]: "false",
        }),
      }),
    ).toMatchObject({
      action: "skip-existing",
      force: false,
      deprecationWarnings: [],
    });
  });
});
