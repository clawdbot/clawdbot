// Covers installed plugin manifest registry behavior.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordInstalledPluginIndexInstallOwner,
  resolveInstalledPluginIndexInstallOwner,
} from "./installed-plugin-index-install-owner.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { loadInstalledPluginIndex, type InstalledPluginIndex } from "./installed-plugin-index.js";
import {
  hasMissingInstalledPluginOwnerMetadata,
  resolveInstalledPluginLifecycleOwnership,
  resolveInstalledPluginPackageOwnership,
} from "./installed-plugin-package-ownership.js";
import { resolvePluginManifestInstallOwner } from "./manifest-install-owner.js";
import {
  loadPluginManifestRegistryForInstalledIndex,
  resolveInstalledManifestRegistryIndexFingerprint,
} from "./manifest-registry-installed.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
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

function writePackageManifest(rootDir: string, channelLabel: string, selectionDocsPrefix?: string) {
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
          ...(selectionDocsPrefix !== undefined ? { selectionDocsPrefix } : {}),
        },
      },
    }),
    "utf8",
  );
  return packageJsonPath;
}

function createIndexWithPackageJson(
  rootDir: string,
  selectionDocsPrefix?: string,
): InstalledPluginIndex {
  const index = createIndexWithFileSignatures(rootDir);
  const packageJsonPath = writePackageManifest(rootDir, "Installed", selectionDocsPrefix);
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

function createIndexWithUnhashedPackageJson(rootDir: string): InstalledPluginIndex {
  const index = createIndexWithFileSignatures(rootDir);
  const packageJsonPath = writePackageManifest(rootDir, "Installed");
  const record = index.plugins[0];
  if (!record) {
    throw new Error("expected index record");
  }
  record.packageJson = {
    path: "package.json",
    hash: "",
    fileSignature: fileSignature(packageJsonPath),
  };
  return {
    ...index,
    plugins: [record],
  };
}

describe("loadPluginManifestRegistryForInstalledIndex", () => {
  const loadRegistry = (index: InstalledPluginIndex) =>
    loadPluginManifestRegistryForInstalledIndex({
      index,
      env: {
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
      includeDisabled: true,
    });

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

  it("fingerprints immutable inventory without inspecting plugin files", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "installed", "installed-");
    const index = createIndexWithUnhashedPackageJson(rootDir);
    const realpathSpy = vi.spyOn(fs, "realpathSync");
    const statSpy = vi.spyOn(fs, "statSync");
    try {
      resolveInstalledManifestRegistryIndexFingerprint(index);
      resolveInstalledManifestRegistryIndexFingerprint(index);
      expect(realpathSpy).not.toHaveBeenCalled();
      expect(statSpy).not.toHaveBeenCalled();
    } finally {
      realpathSpy.mockRestore();
      statSpy.mockRestore();
    }
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

  it("keeps frozen installed-index fingerprints process-stable without file signatures", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "installed", "installed-");
    const index = deepFreeze(createIndex(rootDir));
    const first = resolveInstalledManifestRegistryIndexFingerprint(index);

    const manifestPath = path.join(rootDir, "openclaw.plugin.json");
    const nextMtime = new Date(Date.now() + 5000);
    fs.utimesSync(manifestPath, nextMtime, nextMtime);
    const second = resolveInstalledManifestRegistryIndexFingerprint(index);

    expect(second).toBe(first);
  });

  it("reconstructs installed-index manifests in a fresh operation after files change", () => {
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

    const second = withPluginCache(createPluginCache(), () =>
      loadPluginManifestRegistryForInstalledIndex({
        index,
        env,
        includeDisabled: true,
      }),
    );

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

  it("preserves empty docs prefixes from package channel metadata", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "installed", "installed-");

    const registry = loadRegistry(createIndexWithPackageJson(rootDir, ""));

    expect(registry.plugins[0]?.packageChannel?.selectionDocsPrefix).toBe("");
  });

  it("preserves empty docs prefixes from persisted installed-index metadata", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "installed", "installed-");
    const index = createIndex(rootDir);
    const record = expectDefined(index.plugins[0], "index.plugins[0] test invariant");

    const registry = loadRegistry({
      ...index,
      plugins: [
        {
          ...record,
          packageChannel: {
            id: "installed",
            label: "Installed",
            selectionDocsPrefix: "",
          },
        },
      ],
    });

    expect(registry.plugins[0]?.packageChannel?.selectionDocsPrefix).toBe("");
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

  it("preserves package entry identities through a persisted cold reload", async () => {
    const stateDir = makeTempDir();
    const packageDir = path.join(stateDir, "extensions", "pack");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "pack",
        version: "1.0.0",
        openclaw: { extensions: ["./one.cjs", "./two.cjs"] },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageDir, "openclaw.plugin.json"),
      JSON.stringify({ id: "pack", configSchema: { type: "object" } }),
      "utf8",
    );
    for (const entry of ["one", "two"]) {
      fs.writeFileSync(
        path.join(packageDir, `${entry}.cjs`),
        `module.exports = { id: "pack/${entry}", register() {} };\n`,
        "utf8",
      );
    }
    const config = {
      plugins: {
        entries: {
          "pack/one": { enabled: true },
          "pack/two": { enabled: false },
        },
      },
    };
    const env = {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const installRecords = {
      pack: {
        source: "path" as const,
        sourcePath: packageDir,
        installPath: packageDir,
      },
    };
    const index = loadInstalledPluginIndex({ config, env, installRecords, stateDir });

    expect(
      index.plugins.map((plugin) => ({
        pluginId: plugin.pluginId,
        installOwner: resolveInstalledPluginIndexInstallOwner(plugin),
        enabled: plugin.enabled,
      })),
    ).toEqual([
      { pluginId: "pack/one", installOwner: "pack", enabled: true },
      { pluginId: "pack/two", installOwner: "pack", enabled: false },
    ]);
    await writePersistedInstalledPluginIndex(index, { stateDir });
    clearPluginMetadataLifecycleCaches();
    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    if (!persisted) {
      throw new Error("expected persisted package plugin index");
    }
    expect(resolveInstalledPluginPackageOwnership(persisted, "pack/one")).toMatchObject({
      ok: true,
      value: { installOwner: "pack", pluginIds: ["pack/one", "pack/two"] },
    });

    const allEntries = loadPluginManifestRegistryForInstalledIndex({
      index: persisted,
      config,
      env,
      includeDisabled: true,
    });
    expect(
      allEntries.plugins.map(({ id, source }) => ({ id, source: path.basename(source) })),
    ).toEqual([
      { id: "pack/one", source: "one.cjs" },
      { id: "pack/two", source: "two.cjs" },
    ]);
    expect(allEntries.plugins.map(resolvePluginManifestInstallOwner)).toEqual(["pack", "pack"]);

    const enabledEntries = loadPluginManifestRegistryForInstalledIndex({
      index: persisted,
      config,
      env,
    });
    expect(enabledEntries.plugins.map(({ id }) => id)).toEqual(["pack/one"]);

    const ownerless = {
      ...persisted,
      plugins: persisted.plugins.map((plugin) => {
        const {
          installOwner: _installOwner,
          installOwnerAmbiguous: _installOwnerAmbiguous,
          ...ownerlessPlugin
        } = plugin as typeof plugin & {
          installOwner?: string;
          installOwnerAmbiguous?: true;
        };
        return ownerlessPlugin;
      }),
    };
    expect(resolveInstalledPluginPackageOwnership(ownerless, "pack/one").ok).toBe(false);

    const orphanedOwner = {
      ...persisted,
      installRecords: {
        ...persisted.installRecords,
        orphaned: {
          source: "path" as const,
          sourcePath: path.join(stateDir, "removed-orphan"),
          installPath: path.join(stateDir, "removed-orphan"),
        },
      },
    };
    expect(resolveInstalledPluginPackageOwnership(orphanedOwner, "orphaned").ok).toBe(false);
    expect(resolveInstalledPluginLifecycleOwnership(orphanedOwner, "orphaned")).toMatchObject({
      ok: true,
      value: { kind: "orphan", installOwner: "orphaned", pluginIds: [] },
    });
    expect(hasMissingInstalledPluginOwnerMetadata(orphanedOwner, env)).toBe(false);

    const legacyAmbiguous = {
      ...ownerless,
      installRecords: {
        "pack/one": installRecords.pack,
        "pack/two": installRecords.pack,
      },
    };
    expect(resolveInstalledPluginPackageOwnership(legacyAmbiguous, "pack/one").ok).toBe(false);
    expect(resolveInstalledPluginLifecycleOwnership(legacyAmbiguous, "pack/one").ok).toBe(false);
    expect(hasMissingInstalledPluginOwnerMetadata(legacyAmbiguous, env)).toBe(true);

    const packageAlias = path.join(stateDir, "pack-alias");
    fs.symlinkSync(packageDir, packageAlias, process.platform === "win32" ? "junction" : "dir");
    const aliasedAmbiguous = {
      ...ownerless,
      installRecords: {
        "pack/one": installRecords.pack,
        "pack/two": {
          ...installRecords.pack,
          sourcePath: packageAlias,
          installPath: packageAlias,
        },
      },
    };
    expect(resolveInstalledPluginPackageOwnership(aliasedAmbiguous, "pack/one").ok).toBe(false);
    expect(resolveInstalledPluginLifecycleOwnership(aliasedAmbiguous, "pack/one").ok).toBe(false);
    expect(hasMissingInstalledPluginOwnerMetadata(aliasedAmbiguous, env)).toBe(true);

    const unrelatedOwner = "unrelated";
    const relationScoped = {
      ...aliasedAmbiguous,
      plugins: [
        ...aliasedAmbiguous.plugins,
        recordInstalledPluginIndexInstallOwner(
          {
            ...aliasedAmbiguous.plugins[0]!,
            pluginId: unrelatedOwner,
            rootDir: path.join(stateDir, unrelatedOwner),
          },
          unrelatedOwner,
        ),
      ],
      installRecords: {
        ...aliasedAmbiguous.installRecords,
        [unrelatedOwner]: {
          source: "path" as const,
          sourcePath: path.join(stateDir, unrelatedOwner),
          installPath: path.join(stateDir, unrelatedOwner),
        },
      },
    };
    expect(resolveInstalledPluginPackageOwnership(relationScoped, unrelatedOwner)).toMatchObject({
      ok: true,
      value: { installOwner: unrelatedOwner, pluginIds: [unrelatedOwner] },
    });

    const ambiguous = {
      ...legacyAmbiguous,
      plugins: ownerless.plugins.map((plugin) =>
        recordInstalledPluginIndexInstallOwner(plugin, undefined, true),
      ),
    };
    expect(resolveInstalledPluginPackageOwnership(ambiguous, "pack/one").ok).toBe(false);
    expect(hasMissingInstalledPluginOwnerMetadata(ambiguous, env)).toBe(true);
  });

  it("reuses a prepared manifest graph without reopening plugin manifests", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "installed", "installed-");
    const index = createIndex(rootDir);
    const env = { OPENCLAW_VERSION: "2026.4.25", VITEST: "true" };
    const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
      index,
      env,
      includeDisabled: true,
    });
    fs.unlinkSync(path.join(rootDir, "openclaw.plugin.json"));

    const reused = loadPluginManifestRegistryForInstalledIndex({
      index,
      env,
      manifestRegistry,
      includeDisabled: true,
    });

    expect(reused.plugins).toEqual(manifestRegistry.plugins);
    expect(reused.diagnostics).toEqual([]);
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
            ...expectDefined(index.plugins[0], "index.plugins[0] test invariant"),
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

  it("hydrates package metadata while dropping setup fields with mismatched CLI names", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "installed", "installed-");
    fs.writeFileSync(
      path.join(rootDir, "package.json"),
      JSON.stringify({
        openclaw: {
          channel: {
            id: "installed",
            label: "Installed",
            approvalFlags: ["native", "unsupported"],
            commands: {
              nativeCommandsAutoEnabled: true,
              nativeSkillsAutoEnabled: false,
            },
            setup: {
              fields: [
                {
                  key: "tenant",
                  kind: "choice",
                  choices: ["alpha", "beta"],
                  cli: {
                    flags: "--tenant <tenant>",
                    negatedFlags: "--no-tenant",
                    description: "Installed tenant",
                  },
                },
                {
                  key: "credential",
                  kind: "string",
                  cli: {
                    flags: "--token <value>",
                    description: "Installed credential",
                  },
                },
                {
                  key: "tenant",
                  kind: "boolean",
                  cli: {
                    flags: "--tenant",
                    negatedFlags: "--no-other",
                    description: "Mismatched tenant toggle",
                  },
                },
                {
                  key: "useEnv",
                  kind: "boolean",
                  envVars: ["INSTALLED_TOKEN", "INSTALLED_TOKEN_FILE"],
                  envVarMode: "any",
                  cli: {
                    flags: "--use-env",
                    negatedFlags: "--no-use-env",
                    description: "Use environment credentials",
                  },
                },
              ],
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
            ...expectDefined(index.plugins[0], "index.plugins[0] test invariant"),
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
    expect(registry.plugins[0]?.packageChannel?.approvalFlags).toEqual(["native"]);
    expect(registry.plugins[0]?.packageManifest?.channel?.setup).toEqual({
      fields: [
        {
          key: "tenant",
          kind: "choice",
          choices: ["alpha", "beta"],
          cli: {
            flags: "--tenant <tenant>",
            negatedFlags: "--no-tenant",
            description: "Installed tenant",
          },
        },
        {
          key: "useEnv",
          kind: "boolean",
          envVars: ["INSTALLED_TOKEN", "INSTALLED_TOKEN_FILE"],
          envVarMode: "any",
          cli: {
            flags: "--use-env",
            negatedFlags: "--no-use-env",
            description: "Use environment credentials",
          },
        },
      ],
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
            ...expectDefined(index.plugins[0], "index.plugins[0] test invariant"),
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
              ...expectDefined(index.plugins[0], "index.plugins[0] test invariant"),
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

  it("normalizes persisted channel CLI option value types", () => {
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
              id: "installed",
              cliAddOptions: [
                {
                  flags: "--limit <n>",
                  description: "Limit",
                  valueType: "int",
                },
                {
                  flags: "--ignored <value>",
                  description: "Ignored",
                  valueType: "string",
                },
              ],
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

    expect(registry.plugins[0]?.packageChannel?.cliAddOptions).toEqual([
      { flags: "--limit <n>", description: "Limit", valueType: "int" },
      { flags: "--ignored <value>", description: "Ignored" },
    ]);
  });

  it("normalizes the open-DM wildcard doctor capability from persisted metadata", () => {
    const rootDir = makeTempDir();
    writePlugin(rootDir, "installed", "installed-");
    const index = createIndex(rootDir);
    const registry = loadPluginManifestRegistryForInstalledIndex({
      index: {
        ...index,
        plugins: [
          {
            ...expectDefined(index.plugins[0], "index.plugins[0] test invariant"),
            packageChannel: {
              id: "installed",
              doctorCapabilities: {
                openDmRequiresAllowFromWildcard: false,
              },
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

    expect(
      registry.plugins[0]?.packageChannel?.doctorCapabilities?.openDmRequiresAllowFromWildcard,
    ).toBe(false);
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
      ...expectDefined(index.plugins[0], "index.plugins[0] test invariant"),
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
