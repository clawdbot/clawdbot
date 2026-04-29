import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readPersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndex,
} from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-installed-manifest-registry", tempDirs);
}

function writePlugin(rootDir: string, pluginId: string, modelPrefix: string) {
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load while reading manifests');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      configSchema: { type: "object" },
      providers: [pluginId],
      modelSupport: {
        modelPrefixes: [modelPrefix],
      },
    }),
    "utf8",
  );
}

function createIndex(rootDir: string): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    installRecords: {},
    plugins: [
      {
        pluginId: "installed",
        manifestPath: path.join(rootDir, "openclaw.plugin.json"),
        manifestHash: "manifest-hash",
        source: path.join(rootDir, "index.ts"),
        rootDir,
        origin: "global",
        enabled: true,
        startup: {
          sidecar: false,
          memory: false,
          deferConfiguredChannelFullLoadUntilAfterListen: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
    diagnostics: [],
  };
}

describe("loadPluginManifestRegistryForInstalledIndex", () => {
  it("reconstructs installed-index manifest registries when manifest files change", () => {
    const rootDir = makeTempDir();
    const manifestPath = path.join(rootDir, "openclaw.plugin.json");
    writePlugin(rootDir, "installed", "installed-");
    const index = createIndex(rootDir);
    const env = {
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };

    const first = loadPluginManifestRegistryForInstalledIndex({
      index,
      env,
      includeDisabled: true,
    });
    expect(first.plugins[0]?.modelSupport).toEqual({
      modelPrefixes: ["installed-"],
    });

    writePlugin(rootDir, "installed", "updated-installed-");
    const nextMtime = new Date(Date.now() + 5000);
    fs.utimesSync(manifestPath, nextMtime, nextMtime);

    const second = loadPluginManifestRegistryForInstalledIndex({
      index,
      env,
      includeDisabled: true,
    });

    expect(second).not.toBe(first);
    expect(second.plugins[0]?.modelSupport).toEqual({
      modelPrefixes: ["updated-installed-"],
    });
  });

  it("loads manifest metadata only for plugins present in the installed index", () => {
    const installedRoot = makeTempDir();
    const unrelatedRoot = makeTempDir();
    writePlugin(installedRoot, "installed", "installed-");
    writePlugin(unrelatedRoot, "unrelated", "unrelated-");

    const registry = loadPluginManifestRegistryForInstalledIndex({
      index: createIndex(installedRoot),
      env: {
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
      includeDisabled: true,
    });

    expect(registry.plugins.map((plugin) => plugin.id)).toEqual(["installed"]);
    expect(registry.plugins[0]?.modelSupport).toEqual({
      modelPrefixes: ["installed-"],
    });
  });

  it("reconstructs bundle candidates with their bundle manifest format", () => {
    const rootDir = makeTempDir();
    fs.mkdirSync(path.join(rootDir, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "Claude Bundle",
        commands: "commands",
      }),
      "utf8",
    );

    const index = createIndex(rootDir);
    const registry = loadPluginManifestRegistryForInstalledIndex({
      index: {
        ...index,
        plugins: [
          {
            ...index.plugins[0],
            pluginId: "claude-bundle",
            manifestPath: path.join(rootDir, ".claude-plugin", "plugin.json"),
            source: rootDir,
            format: "bundle",
            bundleFormat: "claude",
          },
        ],
      },
      env: {
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
      includeDisabled: true,
    });

    expect(registry.diagnostics).toEqual([]);
    expect(registry.plugins).toEqual([
      expect.objectContaining({
        id: "claude-bundle",
        format: "bundle",
        bundleFormat: "claude",
        skills: ["commands"],
      }),
    ]);
  });

  it("hydrates package channel command metadata while reconstructing from an older index", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "installed", "installed-");
    fs.writeFileSync(
      path.join(rootDir, "package.json"),
      JSON.stringify({
        openclaw: {
          channel: {
            id: "installed",
            label: "Installed",
            commands: {
              nativeCommandsAutoEnabled: true,
              nativeSkillsAutoEnabled: false,
            },
          },
        },
      }),
      "utf8",
    );

    const index = createIndex(rootDir);
    const registry = loadPluginManifestRegistryForInstalledIndex({
      index: {
        ...index,
        plugins: [
          {
            ...index.plugins[0],
            packageChannel: {
              id: "installed",
              label: "Installed",
            },
            packageJson: {
              path: "package.json",
              hash: "old-index-hash",
            },
          },
        ],
      },
      env: {
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
      includeDisabled: true,
    });

    expect(registry.plugins[0]?.channelCatalogMeta?.commands).toEqual({
      nativeCommandsAutoEnabled: true,
      nativeSkillsAutoEnabled: false,
    });
  });

  it("round-trips bundle metadata through the persisted index before reconstruction", async () => {
    const stateDir = makeTempDir();
    const rootDir = makeTempDir();
    fs.mkdirSync(path.join(rootDir, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "Claude Bundle",
        commands: "commands",
      }),
      "utf8",
    );

    const index = createIndex(rootDir);
    await writePersistedInstalledPluginIndex(
      {
        ...index,
        plugins: [
          {
            ...index.plugins[0],
            pluginId: "claude-bundle",
            manifestPath: path.join(rootDir, ".claude-plugin", "plugin.json"),
            source: rootDir,
            format: "bundle",
            bundleFormat: "claude",
            setupSource: path.join(rootDir, "setup-api.js"),
          },
        ],
      },
      { stateDir },
    );

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    if (!persisted) {
      throw new Error("expected persisted installed plugin index");
    }
    expect(persisted?.plugins[0]).toMatchObject({
      pluginId: "claude-bundle",
      source: rootDir,
      format: "bundle",
      bundleFormat: "claude",
      setupSource: path.join(rootDir, "setup-api.js"),
      rootDir,
    });

    const registry = loadPluginManifestRegistryForInstalledIndex({
      index: persisted,
      env: {
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
      includeDisabled: true,
    });

    expect(registry.diagnostics).toEqual([]);
    expect(registry.plugins).toEqual([
      expect.objectContaining({
        id: "claude-bundle",
        format: "bundle",
        bundleFormat: "claude",
        rootDir,
        skills: ["commands"],
      }),
    ]);
  });
});
