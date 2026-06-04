// Covers installed plugin manifest registry behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readPersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndex,
} from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import {
  loadPluginManifestRegistryForInstalledIndex,
  resolveInstalledManifestRegistryIndexFingerprint,
} from "./manifest-registry-installed.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
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

function fileSignature(filePath: string) {
  const stat = fs.statSync(filePath);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function createIndexWithFileSignatures(rootDir: string): InstalledPluginIndex {
  const index = createIndex(rootDir);
  return {
    ...index,
    plugins: index.plugins.map((record) => {
      record.manifestFile = fileSignature(record.manifestPath);
      return record;
    }),
  };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") {
    return value;
  }
  const object = value as object;
  if (seen.has(object)) {
    return value;
  }
  seen.add(object);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function writePackageManifest(rootDir: string, channelLabel: string) {
  const packageJsonPath = path.join(rootDir, "package.json");
  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify({
      name: "@openclaw/installed",
      version: "1.0.0",
      dependencies: {
        "runtime-dep": "1.0.0",
      },
      openclaw: {
        channel: {
          id: "installed",
          label: channelLabel,
        },
      },
    }),
    "utf8",
  );
  return packageJsonPath;
}

function createIndexWithPackageJson(rootDir: string): InstalledPluginIndex {
  const index = createIndexWithFileSignatures(rootDir);
  const packageJsonPath = writePackageManifest(rootDir, "Installed");
  const record = index.plugins[0];
  if (!record) {
    throw new Error("expected index record");
  }
  record.packageJson = {
    path: "package.json",
    hash: "package-json-hash",
    fileSignature: fileSignature(packageJsonPath),
  };
  return {
    ...index,
    plugins: [record],
  };
}

describe("loadPluginManifestRegistryForInstalledIndex", () => {
  it("reuses frozen installed-index fingerprints when file signatures are persisted", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "installed", "installed-");
    const index = deepFreeze(createIndexWithFileSignatures(rootDir));
    const first = resolveInstalledManifestRegistryIndexFingerprint(index);
    const manifestPath = path.join(rootDir, "openclaw.plugin.json");
    const nextMtime = new Date(Date.now() + 5000);
    fs.utimesSync(manifestPath, nextMtime, nextMtime);
    const second = resolveInstalledManifestRegistryIndexFingerprint(index);

    expect(second).toBe(first);
  });

  it("recomputes installed-index fingerprints for mutable index objects", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "installed", "installed-");
    const index = createIndexWithFileSignatures(rootDir);
    const first = resolveInstalledManifestRegistryIndexFingerprint(index);
    const record = index.plugins[0];
    if (!record) {
      throw new Error("expected index record");
    }
    record.manifestHash = "changed";
    const second = resolveInstalledManifestRegistryIndexFingerprint(index);

    expect(second).not.toBe(first);
  });

  it("does not cache shallow-frozen installed-index fingerprints with mutable nested records", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "installed", "installed-");
    const index = createIndexWithFileSignatures(rootDir);
    const record = index.plugins[0];
    if (!record) {
      throw new Error("expected index record");
    }
    Object.freeze(index.installRecords);
    Object.freeze(index.diagnostics);
    Object.freeze(record);
    Object.freeze(index.plugins);
    Object.freeze(index);
    const first = resolveInstalledManifestRegistryIndexFingerprint(index);

    const agentHarnesses = record.startup.agentHarnesses as string[];
    agentHarnesses.push("changed");
    const second = resolveInstalledManifestRegistryIndexFingerprint(index);

    expect(second).not.toBe(first);
  });

  it("does not cache frozen installed-index fingerprints that depend on live file state", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "installed", "installed-");
    const index = deepFreeze(createIndex(rootDir));
    const first = resolveInstalledManifestRegistryIndexFingerprint(index);

    const manifestPath = path.join(rootDir, "openclaw.plugin.json");
    const nextMtime = new Date(Date.now() + 5000);
    fs.utimesSync(manifestPath, nextMtime, nextMtime);
    const second = resolveInstalledManifestRegistryIndexFingerprint(index);

    expect(second).not.toBe(first);
  });

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

  it("reuses installed package metadata until plugin metadata caches are cleared", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "installed", "installed-");
    const index = createIndexWithPackageJson(rootDir);
    const env = {
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };

    const first = loadPluginManifestRegistryForInstalledIndex({
      index,
      env,
      includeDisabled: true,
    });
    writePackageManifest(rootDir, "Updated");
    const second = loadPluginManifestRegistryForInstalledIndex({
      index,
      env,
      includeDisabled: true,
    });
    clearPluginMetadataLifecycleCaches();
    const third = loadPluginManifestRegistryForInstalledIndex({
      index,
      env,
      includeDisabled: true,
    });

    expect(first.plugins[0]?.packageChannel?.label).toBe("Installed");
    expect(second.plugins[0]?.packageChannel?.label).toBe("Installed");
    expect(third.plugins[0]?.packageChannel?.label).toBe("Updated");
    expect(third.plugins[0]?.packageDependencies).toEqual({
      "runtime-dep": "1.0.0",
    });
  });

  it("reuses installed package json path validation across registry loads", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "installed", "installed-");
    const index = createIndexWithPackageJson(rootDir);
    const env = {
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };

    loadPluginManifestRegistryForInstalledIndex({
      index,
      env,
      includeDisabled: true,
    });
    const realpathSpy = vi.spyOn(fs, "realpathSync");
    let packagePathCalls: unknown[][];
    try {
      loadPluginManifestRegistryForInstalledIndex({
        index,
        env,
        includeDisabled: true,
      });
      const packageJsonPath = path.join(rootDir, "package.json");
      packagePathCalls = realpathSpy.mock.calls.filter(
        ([filePath]) => filePath === packageJsonPath,
      );
    } finally {
      realpathSpy.mockRestore();
    }

    expect(packagePathCalls).toStrictEqual([]);
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

    expect(registry.diagnostics).toStrictEqual([]);
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]?.id).toBe("claude-bundle");
    expect(registry.plugins[0]?.format).toBe("bundle");
    expect(registry.plugins[0]?.bundleFormat).toBe("claude");
    expect(registry.plugins[0]?.skills).toEqual(["commands"]);
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

  it("hydrates package metadata from dot-prefixed package directories", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "installed", "installed-");
    fs.mkdirSync(path.join(rootDir, "..meta"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "..meta", "package.json"),
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
            packageJson: {
              path: "..meta/package.json",
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

  it.runIf(process.platform !== "win32")(
    "does not hydrate package metadata through a symlink outside the plugin root",
    () => {
      const rootDir = makeTempDir();
      const outsideDir = makeTempDir();
      const packageJsonPath = path.join(rootDir, "package.json");
      const outsidePackageJsonPath = path.join(outsideDir, "package.json");
      writePlugin(rootDir, "installed", "installed-");
      fs.writeFileSync(
        outsidePackageJsonPath,
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
      fs.symlinkSync(outsidePackageJsonPath, packageJsonPath);

      const index = createIndex(rootDir);
      const registry = loadPluginManifestRegistryForInstalledIndex({
        index: {
          ...index,
          plugins: [
            {
              ...index.plugins[0],
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

      expect(registry.plugins[0]?.channelCatalogMeta?.commands).toBeUndefined();
    },
  );

  it("ignores malformed persisted package channel metadata", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "installed", "installed-");

    const index = createIndex(rootDir);
    const registry = loadPluginManifestRegistryForInstalledIndex({
      index: {
        ...index,
        plugins: [
          {
            ...index.plugins[0],
            packageChannel: {
              id: ["installed"],
              label: 12,
              blurb: { text: "bad" },
              preferOver: "legacy",
              commands: {
                nativeCommandsAutoEnabled: "yes",
              },
            },
          },
        ],
      } as unknown as InstalledPluginIndex,
      env: {
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
      includeDisabled: true,
    });

    expect(registry.plugins[0]?.packageManifest).toBeUndefined();
    expect(registry.plugins[0]?.channelCatalogMeta).toBeUndefined();
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
    const persistedPlugin = {
      ...index.plugins[0],
      pluginId: "claude-bundle",
      manifestPath: path.join(rootDir, ".claude-plugin", "plugin.json"),
      source: rootDir,
      format: "bundle" as const,
      bundleFormat: "claude" as const,
      setupSource: path.join(rootDir, "setup-api.js"),
    };
    await writePersistedInstalledPluginIndex(
      {
        ...index,
        plugins: [persistedPlugin],
      },
      { stateDir },
    );

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    if (!persisted) {
      throw new Error("expected persisted installed plugin index");
    }
    expect(persisted.plugins[0]).toEqual(persistedPlugin);

    const registry = loadPluginManifestRegistryForInstalledIndex({
      index: persisted,
      env: {
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
      includeDisabled: true,
    });

    expect(registry.diagnostics).toStrictEqual([]);
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]?.id).toBe("claude-bundle");
    expect(registry.plugins[0]?.format).toBe("bundle");
    expect(registry.plugins[0]?.bundleFormat).toBe("claude");
    expect(registry.plugins[0]?.rootDir).toBe(rootDir);
    expect(registry.plugins[0]?.skills).toEqual(["commands"]);
  });
});
