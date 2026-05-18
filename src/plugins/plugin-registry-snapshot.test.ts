import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata-snapshot.js";
import type { PluginCandidate } from "./discovery.js";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import {
  loadInstalledPluginIndex,
  resolveInstalledPluginIndexPolicyHash,
  type InstalledPluginIndex,
} from "./installed-plugin-index.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry-snapshot.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  clearCurrentPluginMetadataSnapshot();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-registry-snapshot", tempDirs);
}

function createHermeticEnv(rootDir: string): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(rootDir, "bundled"),
    OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
    OPENCLAW_VERSION: "2026.4.26",
    VITEST: "true",
  };
}

function writeManifestlessClaudeBundle(rootDir: string) {
  fs.mkdirSync(path.join(rootDir, "skills"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "skills", "SKILL.md"), "# Workspace skill\n", "utf8");
}

function writePackagePlugin(rootDir: string) {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, "index.ts"), "export default { register() {} };\n", "utf8");
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "demo",
      name: "Demo",
      description: "one",
      configSchema: { type: "object" },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({ name: "demo", version: "1.0.0" }),
    "utf8",
  );
}

function createCandidate(rootDir: string, pluginId = "demo"): PluginCandidate {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, "index.ts"), "export default { register() {} };\n", "utf8");
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      name: pluginId,
      description: pluginId,
      configSchema: { type: "object" },
      providers: [pluginId],
    }),
    "utf8",
  );
  return {
    idHint: pluginId,
    source: path.join(rootDir, "index.ts"),
    rootDir,
    origin: "global",
  };
}

function replaceFilePreservingSizeAndMtime(filePath: string, contents: string) {
  const previous = fs.statSync(filePath);
  expect(Buffer.byteLength(contents)).toBe(previous.size);
  fs.writeFileSync(filePath, contents, "utf8");
  fs.utimesSync(filePath, previous.atime, previous.mtime);
}

function fileHash(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function fileSignature(filePath: string) {
  const stat = fs.statSync(filePath);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function createManifestlessClaudeBundleIndex(params: {
  rootDir: string;
  env: NodeJS.ProcessEnv;
}): InstalledPluginIndex {
  return loadInstalledPluginIndex({
    config: {
      plugins: {
        load: { paths: [params.rootDir] },
      },
    },
    env: params.env,
  });
}

function expectDiagnosticsContainCode(diagnostics: readonly { code?: unknown }[], code: string) {
  expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
}

function expectDiagnosticsContainSource(
  diagnostics: readonly { source?: unknown }[],
  source: string,
) {
  expect(diagnostics.map((diagnostic) => diagnostic.source)).toContain(source);
}

function expectDiagnosticsDoNotContainSource(
  diagnostics: readonly { source?: unknown }[],
  source: string,
) {
  expect(diagnostics.map((diagnostic) => diagnostic.source)).not.toContain(source);
}

function requirePluginRecord(
  plugins: InstalledPluginIndex["plugins"],
  pluginId: string,
): InstalledPluginIndex["plugins"][number] {
  const plugin = plugins.find((candidate) => candidate.pluginId === pluginId);
  if (!plugin) {
    throw new Error(`expected plugin ${pluginId}`);
  }
  return plugin;
}

describe("loadPluginRegistrySnapshotWithMetadata", () => {
  it("reuses a compatible current metadata snapshot", () => {
    const env = createHermeticEnv(makeTempDir());
    const config = {};
    const workspaceDir = path.join(makeTempDir(), "workspace");
    const policyHash = resolveInstalledPluginIndexPolicyHash(config);
    const index: InstalledPluginIndex = {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash,
      generatedAtMs: 0,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    };
    const snapshot: PluginMetadataSnapshot = {
      policyHash,
      configFingerprint: "",
      workspaceDir,
      index,
      registryDiagnostics: [],
      manifestRegistry: { plugins: [], diagnostics: [] },
      plugins: [],
      diagnostics: [],
      byPluginId: new Map(),
      normalizePluginId: (pluginId: string) => pluginId,
      owners: {
        channels: new Map(),
        channelConfigs: new Map(),
        providers: new Map(),
        modelCatalogProviders: new Map(),
        cliBackends: new Map(),
        setupProviders: new Map(),
        commandAliases: new Map(),
        contracts: new Map(),
      },
      metrics: {
        registrySnapshotMs: 0,
        manifestRegistryMs: 0,
        ownerMapsMs: 0,
        totalMs: 0,
        indexPluginCount: 0,
        manifestPluginCount: 0,
      },
    };
    setCurrentPluginMetadataSnapshot(snapshot, { config, env, workspaceDir });

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, workspaceDir });

    expect(result).toEqual({
      snapshot: index,
      source: "provided",
      diagnostics: [],
    });
  });

  it("does not treat diagnostic current metadata as provided registry input", () => {
    const env = {
      ...createHermeticEnv(makeTempDir()),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const config = {};
    const workspaceDir = path.join(makeTempDir(), "workspace");
    const policyHash = resolveInstalledPluginIndexPolicyHash(config);
    const index: InstalledPluginIndex = {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash,
      generatedAtMs: 0,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    };
    setCurrentPluginMetadataSnapshot(
      {
        policyHash,
        configFingerprint: "",
        workspaceDir,
        index,
        registryDiagnostics: [
          {
            level: "info",
            code: "persisted-registry-missing",
            message: "missing",
          },
        ],
        manifestRegistry: { plugins: [], diagnostics: [] },
        plugins: [],
        diagnostics: [],
        byPluginId: new Map(),
        normalizePluginId: (pluginId: string) => pluginId,
        owners: {
          channels: new Map(),
          channelConfigs: new Map(),
          providers: new Map(),
          modelCatalogProviders: new Map(),
          cliBackends: new Map(),
          setupProviders: new Map(),
          commandAliases: new Map(),
          contracts: new Map(),
        },
        metrics: {
          registrySnapshotMs: 0,
          manifestRegistryMs: 0,
          ownerMapsMs: 0,
          totalMs: 0,
          indexPluginCount: 0,
          manifestPluginCount: 0,
        },
      },
      { config, env, workspaceDir },
    );

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, workspaceDir });

    expect(result.source).not.toBe("provided");
  });

  it("does not reuse current metadata when explicit derivation inputs are supplied", () => {
    const tempRoot = makeTempDir();
    const env = {
      ...createHermeticEnv(tempRoot),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const config = {};
    const workspaceDir = path.join(tempRoot, "workspace");
    const policyHash = resolveInstalledPluginIndexPolicyHash(config);
    const currentIndex: InstalledPluginIndex = {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash,
      generatedAtMs: 0,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    };
    setCurrentPluginMetadataSnapshot(
      {
        policyHash,
        configFingerprint: "",
        workspaceDir,
        index: currentIndex,
        registryDiagnostics: [],
        manifestRegistry: { plugins: [], diagnostics: [] },
        plugins: [],
        diagnostics: [],
        byPluginId: new Map(),
        normalizePluginId: (pluginId: string) => pluginId,
        owners: {
          channels: new Map(),
          channelConfigs: new Map(),
          providers: new Map(),
          modelCatalogProviders: new Map(),
          cliBackends: new Map(),
          setupProviders: new Map(),
          commandAliases: new Map(),
          contracts: new Map(),
        },
        metrics: {
          registrySnapshotMs: 0,
          manifestRegistryMs: 0,
          ownerMapsMs: 0,
          totalMs: 0,
          indexPluginCount: 0,
          manifestPluginCount: 0,
        },
      },
      { config, env, workspaceDir },
    );

    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      workspaceDir,
      candidates: [createCandidate(path.join(tempRoot, "candidate"), "explicit")],
    });

    expect(result.source).toBe("derived");
    expect(result.snapshot.plugins.map((plugin) => plugin.pluginId)).toEqual(["explicit"]);
  });

  it("recovers managed npm plugins missing from a stale persisted registry", () => {
    const tempRoot = makeTempDir();
    const stateDir = path.join(tempRoot, "state");
    const env = {
      ...createHermeticEnv(tempRoot),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
    };
    const config = {};
    const whatsappDir = writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/whatsapp",
      pluginId: "whatsapp",
      version: "2026.5.2",
    });
    const staleIndex = loadInstalledPluginIndex({
      config,
      env,
      stateDir,
      installRecords: {},
    });
    expect(staleIndex.plugins.map((plugin) => plugin.pluginId)).not.toContain("whatsapp");
    writePersistedInstalledPluginIndexSync(staleIndex, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      stateDir,
    });

    expect(result.source).toBe("derived");
    expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
    expect(result.snapshot.installRecords.whatsapp).toEqual({
      source: "npm",
      spec: "@openclaw/whatsapp@2026.5.2",
      installPath: whatsappDir,
      version: "2026.5.2",
      resolvedName: "@openclaw/whatsapp",
      resolvedVersion: "2026.5.2",
      resolvedSpec: "@openclaw/whatsapp@2026.5.2",
    });
    const whatsappPlugin = requirePluginRecord(result.snapshot.plugins, "whatsapp");
    expect(whatsappPlugin.origin).toBe("global");
  });

  it("keeps vanished recovered install records on the persisted fast path", () => {
    const tempRoot = makeTempDir();
    const stateDir = path.join(tempRoot, "state");
    const goneDir = path.join(tempRoot, "gone");
    const env = {
      ...createHermeticEnv(tempRoot),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
    };
    writePersistedInstalledPluginIndexSync(
      {
        ...loadInstalledPluginIndex({ config: {}, env, stateDir, installRecords: {} }),
        installRecords: { gone: { source: "npm", spec: "gone@1.0.0", installPath: goneDir } },
      },
      { stateDir },
    );

    const result = loadPluginRegistrySnapshotWithMetadata({ config: {}, env, stateDir });

    expect(result.source).toBe("persisted");
    expect(result.diagnostics).toStrictEqual([]);
  });

  it("keeps persisted manifestless Claude bundles on the fast path", () => {
    const tempRoot = makeTempDir();
    const rootDir = path.join(tempRoot, "workspace");
    const stateDir = path.join(tempRoot, "state");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {
      plugins: {
        load: { paths: [rootDir] },
      },
    };
    writeManifestlessClaudeBundle(rootDir);
    const index = createManifestlessClaudeBundleIndex({ rootDir, env });
    writePersistedInstalledPluginIndexSync(index, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      stateDir,
    });

    expect(result.source).toBe("persisted");
    expect(result.diagnostics).toStrictEqual([]);
  });

  it("keeps persisted package plugins when file hashes match", () => {
    const tempRoot = makeTempDir();
    const rootDir = path.join(tempRoot, "workspace");
    const stateDir = path.join(tempRoot, "state");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {
      plugins: {
        load: { paths: [rootDir] },
      },
    };
    writePackagePlugin(rootDir);
    const index = loadInstalledPluginIndex({ config, env });
    const [record] = index.plugins;
    if (!record?.packageJson?.fileSignature || !record.manifestFile) {
      throw new Error("expected package plugin index record with file signatures");
    }
    expect(record.manifestFile.size).toBe(
      fs.statSync(path.join(rootDir, "openclaw.plugin.json")).size,
    );
    expect(record.packageJson.fileSignature.size).toBe(
      fs.statSync(path.join(rootDir, "package.json")).size,
    );
    writePersistedInstalledPluginIndexSync(index, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      stateDir,
    });

    expect(result.source).toBe("persisted");
    expect(result.diagnostics).toStrictEqual([]);
  });

  it("keeps persisted package plugins with dot-prefixed package metadata paths", () => {
    const tempRoot = makeTempDir();
    const rootDir = path.join(tempRoot, "workspace");
    const stateDir = path.join(tempRoot, "state");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {
      plugins: {
        load: { paths: [rootDir] },
      },
    };
    writePackagePlugin(rootDir);
    const metaDir = path.join(rootDir, "..meta");
    fs.mkdirSync(metaDir, { recursive: true });
    const packageJsonPath = path.join(metaDir, "package.json");
    fs.writeFileSync(packageJsonPath, JSON.stringify({ name: "demo", version: "1.0.0" }), "utf8");
    const index = loadInstalledPluginIndex({ config, env });
    const [plugin] = index.plugins;
    if (!plugin) {
      throw new Error("expected test plugin");
    }
    writePersistedInstalledPluginIndexSync(
      {
        ...index,
        plugins: [
          {
            ...plugin,
            packageJson: {
              path: "..meta/package.json",
              hash: fileHash(packageJsonPath),
              fileSignature: fileSignature(packageJsonPath),
            },
          },
          ...index.plugins.slice(1),
        ],
      },
      { stateDir },
    );

    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      stateDir,
    });

    expect(result.source).toBe("persisted");
    expect(result.diagnostics).toStrictEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "treats persisted package metadata symlinks outside the plugin root as stale",
    () => {
      const tempRoot = makeTempDir();
      const rootDir = path.join(tempRoot, "workspace");
      const stateDir = path.join(tempRoot, "state");
      const outsideDir = path.join(tempRoot, "outside");
      const packageJsonPath = path.join(rootDir, "package.json");
      const outsidePackageJsonPath = path.join(outsideDir, "package.json");
      const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
      const config = {
        plugins: {
          load: { paths: [rootDir] },
        },
      };
      writePackagePlugin(rootDir);
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.rmSync(packageJsonPath);
      fs.writeFileSync(
        outsidePackageJsonPath,
        JSON.stringify({ name: "demo", version: "1.0.0" }),
        "utf8",
      );
      fs.symlinkSync(outsidePackageJsonPath, packageJsonPath);
      const index = loadInstalledPluginIndex({ config, env });
      const [plugin] = index.plugins;
      if (!plugin) {
        throw new Error("expected test plugin");
      }
      writePersistedInstalledPluginIndexSync(
        {
          ...index,
          plugins: [
            {
              ...plugin,
              packageJson: {
                path: "package.json",
                hash: fileHash(packageJsonPath),
                fileSignature: fileSignature(packageJsonPath),
              },
            },
            ...index.plugins.slice(1),
          ],
        },
        { stateDir },
      );

      const result = loadPluginRegistrySnapshotWithMetadata({
        config,
        env,
        stateDir,
      });

      expect(result.source).toBe("derived");
      expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
    },
  );

  it("detects same-size same-mtime manifest replacements", () => {
    const tempRoot = makeTempDir();
    const rootDir = path.join(tempRoot, "workspace");
    const stateDir = path.join(tempRoot, "state");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {
      plugins: {
        load: { paths: [rootDir] },
      },
    };
    writePackagePlugin(rootDir);
    const index = loadInstalledPluginIndex({ config, env });
    writePersistedInstalledPluginIndexSync(index, { stateDir });

    replaceFilePreservingSizeAndMtime(
      path.join(rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        description: "two",
        configSchema: { type: "object" },
      }),
    );

    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      stateDir,
    });

    expect(result.source).toBe("derived");
    expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
  });

  it("detects same-size same-mtime package.json replacements", () => {
    const tempRoot = makeTempDir();
    const rootDir = path.join(tempRoot, "workspace");
    const stateDir = path.join(tempRoot, "state");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {
      plugins: {
        load: { paths: [rootDir] },
      },
    };
    writePackagePlugin(rootDir);
    const index = loadInstalledPluginIndex({ config, env });
    writePersistedInstalledPluginIndexSync(index, { stateDir });

    replaceFilePreservingSizeAndMtime(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.1" }),
    );

    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      stateDir,
    });

    expect(result.source).toBe("derived");
    expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
  });

  it("detects package.json replacements even when stored stat fields still match", () => {
    const tempRoot = makeTempDir();
    const rootDir = path.join(tempRoot, "workspace");
    const stateDir = path.join(tempRoot, "state");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {
      plugins: {
        load: { paths: [rootDir] },
      },
    };
    writePackagePlugin(rootDir);
    const index = loadInstalledPluginIndex({ config, env });

    replaceFilePreservingSizeAndMtime(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.1" }),
    );
    const stat = fs.statSync(path.join(rootDir, "package.json"));
    const [plugin] = index.plugins;
    if (!plugin?.packageJson) {
      throw new Error("expected test plugin package metadata");
    }
    const stalePlugin = {
      ...plugin,
      packageJson: {
        ...plugin.packageJson,
        fileSignature: {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
        },
      },
    };
    const staleIndex: InstalledPluginIndex = {
      ...index,
      plugins: [stalePlugin, ...index.plugins.slice(1)],
    };
    writePersistedInstalledPluginIndexSync(staleIndex, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      stateDir,
    });

    expect(result.source).toBe("derived");
    expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
  });

  it("treats persisted registry as stale when a plugin diagnostic source path no longer exists", () => {
    const tempRoot = makeTempDir();
    const stateDir = path.join(tempRoot, "state");
    const env = {
      ...createHermeticEnv(tempRoot),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
    };
    const config = {};
    const ghostDir = path.join(tempRoot, "extensions", "lossless-claw");
    const npmPluginDir = writeManagedNpmPlugin({
      stateDir,
      packageName: "@martian-engineering/lossless-claw",
      pluginId: "lossless-claw",
      version: "0.9.4",
    });
    const staleIndex: InstalledPluginIndex = {
      ...loadInstalledPluginIndex({ config, env, stateDir, installRecords: {} }),
      diagnostics: [
        {
          level: "warn",
          message:
            "installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js",
          pluginId: "lossless-claw",
          source: ghostDir,
        },
      ],
    };
    writePersistedInstalledPluginIndexSync(staleIndex, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expect(result.source).toBe("derived");
    expectDiagnosticsDoNotContainSource(result.snapshot.diagnostics, ghostDir);
    const losslessPlugin = requirePluginRecord(result.snapshot.plugins, "lossless-claw");
    expect(losslessPlugin.origin).toBe("global");
    expect(losslessPlugin.source).toBe(
      fs.realpathSync(path.join(npmPluginDir, "dist", "index.js")),
    );
    expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
  });

  it("keeps persisted registry when a non-plugin diagnostic source path still does not exist", () => {
    const tempRoot = makeTempDir();
    const stateDir = path.join(tempRoot, "state");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {};
    const missingConfiguredPath = path.join(tempRoot, "missing-configured-plugin");
    const index: InstalledPluginIndex = {
      ...loadInstalledPluginIndex({ config, env, stateDir, installRecords: {} }),
      diagnostics: [
        {
          level: "error",
          message: `plugin path not found: ${missingConfiguredPath}`,
          source: missingConfiguredPath,
        },
      ],
    };
    writePersistedInstalledPluginIndexSync(index, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expect(result.source).toBe("persisted");
    expectDiagnosticsContainSource(result.snapshot.diagnostics, missingConfiguredPath);
    expect(result.diagnostics).toStrictEqual([]);
  });
});
