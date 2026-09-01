// Covers stable plugin registry snapshot generation.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import type { PluginCandidate } from "./discovery.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-records.js";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store-write.js";
import {
  loadInstalledPluginIndex,
  resolveInstalledPluginIndexPolicyHash,
  type InstalledPluginIndex,
} from "./installed-plugin-index.js";
import { markRetainedManagedNpmInstall } from "./managed-npm-retention.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry-snapshot.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
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

function createCurrentMetadataSnapshot(
  config: OpenClawConfig,
  workspaceDir: string,
): PluginMetadataSnapshot {
  const snapshot = createPluginMetadataSnapshotFixture();
  const policyHash = resolveInstalledPluginIndexPolicyHash(config);
  snapshot.index.policyHash = policyHash;
  return {
    ...snapshot,
    policyHash,
    configFingerprint: "",
    workspaceDir,
    normalizePluginId: (pluginId) => pluginId,
  };
}

function writeManifestlessClaudeBundle(rootDir: string) {
  fs.mkdirSync(path.join(rootDir, "skills"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "skills", "SKILL.md"), "# Workspace skill\n", "utf8");
}

function writePackagePlugin(
  rootDir: string,
  options: {
    configPaths?: readonly string[];
    pluginId?: string;
    requiresPlugins?: readonly string[];
  } = {},
) {
  const pluginId = options.pluginId ?? "demo";
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, "index.ts"), "export default { register() {} };\n", "utf8");
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      name: pluginId,
      description: "one",
      configSchema: { type: "object" },
      ...(options.configPaths ? { activation: { onConfigPaths: options.configPaths } } : {}),
      ...(options.requiresPlugins ? { requiresPlugins: options.requiresPlugins } : {}),
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({ name: pluginId, version: "1.0.0" }),
    "utf8",
  );
}

function writeBundledPlugin(
  rootDir: string,
  pluginId: string,
  entryPath: string,
  build?: Record<string, unknown>,
) {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, entryPath), "export default { register() {} };\n", "utf8");
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      name: pluginId,
      description: pluginId,
      configSchema: { type: "object" },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({
      name: `@openclaw/${pluginId}`,
      version: "1.0.0",
      openclaw: {
        extensions: [`./${entryPath}`],
        ...(build ? { build } : {}),
      },
    }),
    "utf8",
  );
}

function mockLinuxMountInfo(mountPoints: readonly string[]) {
  const originalReadFileSync = fs.readFileSync;
  return vi.spyOn(fs, "readFileSync").mockImplementation((filePath, options) => {
    if (filePath === "/proc/self/mountinfo") {
      return mountPoints
        .map(
          (mountPoint, index) => `${100 + index} 99 0:${index} / ${mountPoint} rw - tmpfs tmpfs rw`,
        )
        .join("\n");
    }
    return originalReadFileSync(filePath, options as never) as never;
  });
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

function dropStartupConfigPaths(
  plugin: InstalledPluginIndex["plugins"][number],
): InstalledPluginIndex["plugins"][number] {
  return {
    ...plugin,
    startup: {
      sidecar: plugin.startup.sidecar,
      memory: plugin.startup.memory,
      agentHarnesses: plugin.startup.agentHarnesses,
    },
  };
}

describe("loadPluginRegistrySnapshotWithMetadata", () => {
  it.each(["persisted", "current"])(
    "reselects checkout plugins for a fresh config request after a %s global selection",
    (cache) => {
      const root = fs.realpathSync(makeTempDir());
      const packageRoot = path.join(root, "openclaw");
      const bundledRoot = path.join(packageRoot, "dist", "extensions");
      const bundledPlugin = path.join(bundledRoot, "demo");
      const globalPlugin = path.join(root, "state", "extensions", "demo");
      const env: NodeJS.ProcessEnv = {
        ...createHermeticEnv(root),
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
      };
      fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
      fs.mkdirSync(path.join(packageRoot, "extensions"));
      fs.writeFileSync(path.join(packageRoot, "package.json"), '{"name":"openclaw"}');
      fs.writeFileSync(path.join(packageRoot, "pnpm-workspace.yaml"), "packages: []\n");
      writeBundledPlugin(bundledPlugin, "demo", "index.js");
      writeBundledPlugin(globalPlugin, "demo", "index.js");
      const config = { plugins: { entries: { demo: { enabled: true } } } };
      const index = loadInstalledPluginIndex({
        config,
        env,
        installRecords: {
          demo: { source: "path", sourcePath: globalPlugin, installPath: globalPlugin },
        },
      });
      expect(requirePluginRecord(index.plugins, "demo").origin).toBe("global");
      writePersistedInstalledPluginIndexSync(index, { stateDir: env.OPENCLAW_STATE_DIR });
      if (cache === "current") {
        setCurrentPluginMetadataSnapshot(loadPluginMetadataSnapshot({ config, env }), {
          config,
          env,
        });
      }
      const result = loadPluginRegistrySnapshotWithMetadata({
        config: structuredClone(config),
        env: { ...env, OPENCLAW_DEV_SOURCE_ROOT: packageRoot },
      });
      expect(requirePluginRecord(result.snapshot.plugins, "demo")).toMatchObject({
        origin: "bundled",
        rootDir: bundledPlugin,
      });
    },
  );

  it("reuses a compatible current metadata snapshot", () => {
    const env = createHermeticEnv(makeTempDir());
    const config = {};
    const workspaceDir = path.join(makeTempDir(), "workspace");
    const snapshot = createCurrentMetadataSnapshot(config, workspaceDir);
    const index = snapshot.index;
    setCurrentPluginMetadataSnapshot(snapshot, { config, env, workspaceDir });

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, workspaceDir });

    expect(result).toEqual({
      snapshot: index,
      source: "provided",
      diagnostics: [],
      manifestRegistry: snapshot.manifestRegistry,
    });
  });

  it("bypasses a derived current snapshot for persisted verification", () => {
    const rootDir = makeTempDir();
    const env = {
      ...createHermeticEnv(rootDir),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const config = {};
    const derived = loadPluginMetadataSnapshot({
      config,
      env,
      preferPersisted: false,
    });
    expect(derived.registrySource).toBe("derived");
    writePersistedInstalledPluginIndexSync(derived.index, { env });
    setCurrentPluginMetadataSnapshot(derived, { config, env });

    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      allowCurrent: false,
    });

    expect(result.source).toBe("persisted");
    expect(result.snapshot).toEqual(derived.index);
  });

  it("reuses diagnostic current metadata without promoting its registry source", () => {
    const env = {
      ...createHermeticEnv(makeTempDir()),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const config = {};
    const workspaceDir = path.join(makeTempDir(), "workspace");
    const snapshot = createCurrentMetadataSnapshot(config, workspaceDir);
    const index = snapshot.index;
    setCurrentPluginMetadataSnapshot(
      {
        ...snapshot,
        registrySource: "derived",
        registryDiagnostics: [
          {
            level: "info",
            code: "persisted-registry-missing",
            message: "missing",
          },
        ],
      },
      { config, env, workspaceDir },
    );
    const readDirectory = vi.spyOn(fs, "readdirSync");
    const readFile = vi.spyOn(fs, "readFileSync");
    const statFile = vi.spyOn(fs, "statSync");

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, workspaceDir });

    expect(result).toEqual({
      snapshot: index,
      source: "derived",
      diagnostics: [
        {
          level: "info",
          code: "persisted-registry-missing",
          message: "missing",
        },
      ],
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    expect(readDirectory).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(statFile).not.toHaveBeenCalled();
  });

  it("does not reuse current metadata when explicit derivation inputs are supplied", () => {
    const tempRoot = makeTempDir();
    const env = {
      ...createHermeticEnv(tempRoot),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const config = {};
    const workspaceDir = path.join(tempRoot, "workspace");
    setCurrentPluginMetadataSnapshot(createCurrentMetadataSnapshot(config, workspaceDir), {
      config,
      env,
      workspaceDir,
    });

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

  it("recovers configured global source plugins missing from a stale persisted registry", () => {
    const tempRoot = makeTempDir();
    const stateDir = path.join(tempRoot, "state");
    const env = {
      ...createHermeticEnv(tempRoot),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
    };
    const config = {
      plugins: {
        entries: {
          "memory-demo": { enabled: true },
        },
        allow: ["memory-demo"],
        slots: {
          memory: "memory-demo",
        },
      },
    };
    const staleIndex = loadInstalledPluginIndex({
      config,
      env,
      stateDir,
      installRecords: {},
    });
    expect(staleIndex.plugins.map((plugin) => plugin.pluginId)).not.toContain("memory-demo");
    writePersistedInstalledPluginIndexSync(staleIndex, { stateDir });
    writePackagePlugin(path.join(stateDir, "extensions", "memory-demo-source"), {
      pluginId: "memory-demo",
    });

    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      stateDir,
    });

    expect(result.source).toBe("derived");
    expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
    const memoryPlugin = requirePluginRecord(result.snapshot.plugins, "memory-demo");
    expect(memoryPlugin.origin).toBe("global");
  });

  it("does not recover retained managed npm generations as install records", async () => {
    const tempRoot = makeTempDir();
    const stateDir = path.join(tempRoot, "state");
    const env = {
      ...createHermeticEnv(tempRoot),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
    };
    const config = {};
    const codexDir = writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/codex",
      pluginId: "codex",
      version: "2026.6.10-beta.1",
    });
    await markRetainedManagedNpmInstall({
      packageDir: codexDir,
      pluginId: "codex",
      retainedAt: "2026-06-21T00:00:00.000Z",
      reason: "test-retained-generation",
    });
    const staleIndex = loadInstalledPluginIndex({
      config,
      env,
      stateDir,
      installRecords: {},
    });
    writePersistedInstalledPluginIndexSync(staleIndex, { stateDir });

    expect(loadInstalledPluginIndexInstallRecordsSync({ env, stateDir }).codex).toBeUndefined();
    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      stateDir,
    });

    expect(result.snapshot.installRecords.codex).toBeUndefined();
    expect(result.snapshot.plugins.map((plugin) => plugin.pluginId)).not.toContain("codex");
  });

  it("does not trust package-owned retained npm marker files during recovery", () => {
    const tempRoot = makeTempDir();
    const stateDir = path.join(tempRoot, "state");
    const env = {
      ...createHermeticEnv(tempRoot),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
    };
    const codexDir = writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/codex",
      pluginId: "codex",
      version: "2026.6.10-beta.1",
    });
    fs.writeFileSync(
      path.join(codexDir, ".openclaw-retained-npm-install.json"),
      '{"version":1,"pluginId":"codex"}\n',
      "utf8",
    );

    expect(loadInstalledPluginIndexInstallRecordsSync({ env, stateDir }).codex).toBeDefined();
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

  it("keeps unrelated installed plugins usable beside a vanished package owner", () => {
    const tempRoot = makeTempDir();
    const stateDir = path.join(tempRoot, "state");
    const demoDir = path.join(stateDir, "extensions", "demo");
    const goneDir = path.join(stateDir, "extensions", "gone");
    const env = {
      ...createHermeticEnv(tempRoot),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
    };
    writePackagePlugin(demoDir, { pluginId: "demo" });
    const config = {
      plugins: {
        entries: {
          demo: { enabled: true },
          gone: { enabled: true },
        },
      },
    };
    const installRecords = {
      demo: { source: "path" as const, sourcePath: demoDir, installPath: demoDir },
      gone: { source: "path" as const, sourcePath: goneDir, installPath: goneDir },
    };
    const index = loadInstalledPluginIndex({ config, env, stateDir, installRecords });
    writePersistedInstalledPluginIndexSync(index, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expect(result.source).toBe("persisted");
    expect(result.snapshot.plugins.map((plugin) => plugin.pluginId)).toContain("demo");
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

  it("ignores malformed load paths while deriving snapshots", () => {
    const tempRoot = makeTempDir();
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {
      plugins: {
        load: { paths: "not-an-array" },
      },
    } as unknown as OpenClawConfig;

    expect(() => loadPluginRegistrySnapshotWithMetadata({ config, env })).not.toThrow();
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

  it("rebuilds when an explicit candidate moves identical package metadata", () => {
    const tempRoot = makeTempDir();
    const rootDir = path.join(tempRoot, "workspace");
    const stateDir = path.join(tempRoot, "state");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const packageContents = JSON.stringify({ name: "demo", version: "1.0.0" });
    const baseCandidate = createCandidate(rootDir);
    fs.writeFileSync(path.join(rootDir, "package.json"), packageContents, "utf8");
    const persisted = loadInstalledPluginIndex({
      candidates: [{ ...baseCandidate, packageDir: rootDir }],
      config: {},
      env,
    });
    writePersistedInstalledPluginIndexSync(persisted, { stateDir });
    const nestedPackageDir = path.join(rootDir, "nested");
    fs.mkdirSync(nestedPackageDir, { recursive: true });
    fs.writeFileSync(path.join(nestedPackageDir, "package.json"), packageContents, "utf8");

    const result = loadPluginRegistrySnapshotWithMetadata({
      candidates: [{ ...baseCandidate, packageDir: nestedPackageDir }],
      config: {},
      env,
      stateDir,
    });

    expect(result.source).toBe("derived");
    expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
    expect(result.snapshot.plugins[0]?.packageJson?.path).toBe("nested/package.json");
  });

  it("derives a complete index when a configured load-path plugin is missing", () => {
    const tempRoot = makeTempDir();
    const firstRoot = path.join(tempRoot, "first");
    const secondRoot = path.join(tempRoot, "second");
    const stateDir = path.join(tempRoot, "state");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const staleConfig = {
      plugins: {
        load: { paths: [firstRoot] },
      },
    };
    const config = {
      plugins: {
        load: { paths: [firstRoot, secondRoot] },
      },
    };
    writePackagePlugin(firstRoot, {
      pluginId: "first",
      requiresPlugins: ["second"],
    });
    writePackagePlugin(secondRoot, { pluginId: "second" });
    const staleIndex = loadInstalledPluginIndex({ config: staleConfig, env });
    expect(staleIndex.policyHash).toBe(resolveInstalledPluginIndexPolicyHash(config));
    writePersistedInstalledPluginIndexSync(staleIndex, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      stateDir,
    });

    expect(result.source).toBe("derived");
    expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
    expect(result.snapshot.plugins.map((plugin) => plugin.pluginId)).toEqual(["first", "second"]);
    expect(result.snapshot.plugins.map((plugin) => plugin.origin)).toEqual(["config", "config"]);
    const scopedRegistry = loadPluginManifestRegistryForInstalledIndex({
      index: result.snapshot,
      config,
      env,
      pluginIds: ["first"],
      includeDisabled: true,
    });
    expect(scopedRegistry.plugins.map((plugin) => plugin.id)).toEqual(["first"]);
    expect(scopedRegistry.diagnostics).not.toContainEqual(
      expect.objectContaining({
        pluginId: "first",
        message: expect.stringContaining('requires plugin "second"'),
      }),
    );
  });

  it("rebuilds when configured load-path precedence changes", () => {
    const tempRoot = makeTempDir();
    const firstRoot = path.join(tempRoot, "first");
    const secondRoot = path.join(tempRoot, "second");
    const stateDir = path.join(tempRoot, "state");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const originalConfig = {
      plugins: {
        load: { paths: [firstRoot, secondRoot] },
      },
    };
    const reorderedConfig = {
      plugins: {
        load: { paths: [secondRoot, firstRoot] },
      },
    };
    writePackagePlugin(firstRoot, { pluginId: "duplicate" });
    writePackagePlugin(secondRoot, { pluginId: "duplicate" });
    const originalIndex = loadInstalledPluginIndex({ config: originalConfig, env });
    expect(originalIndex.plugins.map((plugin) => plugin.rootDir)).toEqual([
      fs.realpathSync(firstRoot),
    ]);
    writePersistedInstalledPluginIndexSync(originalIndex, { stateDir });

    const unchanged = loadPluginRegistrySnapshotWithMetadata({
      config: originalConfig,
      env,
      stateDir,
    });
    expect(unchanged.source).toBe("persisted");

    const reordered = loadPluginRegistrySnapshotWithMetadata({
      config: reorderedConfig,
      env,
      stateDir,
    });
    expect(reordered.source).toBe("derived");
    expectDiagnosticsContainCode(reordered.diagnostics, "persisted-registry-stale-source");
    expect(reordered.snapshot.plugins.map((plugin) => plugin.rootDir)).toEqual([
      fs.realpathSync(secondRoot),
    ]);
  });

  it("rebuilds legacy config-path persisted registries before startup scoping", () => {
    const tempRoot = makeTempDir();
    const rootDir = path.join(tempRoot, "workspace");
    const stateDir = path.join(tempRoot, "state");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {
      plugins: {
        load: { paths: [rootDir] },
      },
    };
    writePackagePlugin(rootDir, { configPaths: ["browser"] });
    const index = loadInstalledPluginIndex({ config, env });
    const legacyIndex: InstalledPluginIndex = {
      ...index,
      plugins: index.plugins.map(dropStartupConfigPaths),
    };
    writePersistedInstalledPluginIndexSync(legacyIndex, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      stateDir,
    });

    expect(result.source).toBe("derived");
    expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
    expect(result.snapshot.plugins[0]?.startup.configPaths).toEqual(["browser"]);
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
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({
        name: "demo",
        version: "1.0.0",
        openclaw: {
          channel: {
            id: "demo",
            label: "Demo",
            commands: {
              nativeCommandsAutoEnabled: true,
              nativeSkillsAutoEnabled: false,
            },
          },
        },
      }),
      "utf8",
    );
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
    expect(result.manifestRegistry).toBeUndefined();
    const registry = loadPluginManifestRegistryForInstalledIndex({
      index: result.snapshot,
      config,
      env,
      includeDisabled: true,
    });
    expect(registry.plugins[0]?.channelCatalogMeta?.commands).toEqual({
      nativeCommandsAutoEnabled: true,
      nativeSkillsAutoEnabled: false,
    });
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
          entries: { demo: { enabled: false } },
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

  it.runIf(process.platform !== "win32")(
    "rejects dangling root, source, and manifest links for disabled records",
    () => {
      for (const artifact of ["root", "source", "manifest"] as const) {
        const tempRoot = makeTempDir();
        const rootDir = path.join(tempRoot, "workspace");
        const stateDir = path.join(tempRoot, "state");
        const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
        const config = {
          plugins: {
            load: { paths: [rootDir] },
            entries: { demo: { enabled: false } },
          },
        };
        writePackagePlugin(rootDir);
        writePersistedInstalledPluginIndexSync(loadInstalledPluginIndex({ config, env }), {
          stateDir,
        });
        const artifactPath =
          artifact === "root"
            ? rootDir
            : path.join(rootDir, artifact === "source" ? "index.ts" : "openclaw.plugin.json");
        fs.rmSync(artifactPath, { recursive: artifact === "root" });
        fs.symlinkSync(path.join(tempRoot, "missing"), artifactPath);

        const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

        expect([artifact, result.source]).toEqual([artifact, "derived"]);
        expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
      }
    },
  );

  it("rejects escaped missing package metadata for disabled records", () => {
    const tempRoot = makeTempDir();
    const rootDir = path.join(tempRoot, "workspace");
    const stateDir = path.join(tempRoot, "state");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {
      plugins: {
        load: { paths: [rootDir] },
        entries: { demo: { enabled: false } },
      },
    };
    writePackagePlugin(rootDir);
    const index = loadInstalledPluginIndex({ config, env });
    const plugin = requirePluginRecord(index.plugins, "demo");
    writePersistedInstalledPluginIndexSync(
      {
        ...index,
        plugins: [
          {
            ...plugin,
            packageJson: { path: "../gone/package.json", hash: "missing" },
          },
        ],
      },
      { stateDir },
    );

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expect(result.source).toBe("derived");
    expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
  });

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

  it("trusts unchanged Doctor contract signatures without rehashing", () => {
    const tempRoot = makeTempDir();
    const bundledRoot = path.join(tempRoot, "dist", "extensions");
    const rootDir = path.join(bundledRoot, "demo");
    const stateDir = path.join(tempRoot, "state");
    const contractPath = path.join(rootDir, "doctor-contract-api.ts");
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.4.26",
      VITEST: "true",
    };
    const config = {};
    writeBundledPlugin(rootDir, "demo", "index.js");
    fs.writeFileSync(contractPath, 'export const marker = "aaaa";\n', "utf8");
    const index = loadInstalledPluginIndex({ config, env });
    const plugin = requirePluginRecord(index.plugins, "demo");
    expect(plugin.doctorContractFile).toEqual(fileSignature(contractPath));
    const persistedPlugin = { ...plugin, doctorContractHash: "stale-contract-hash" };
    writePersistedInstalledPluginIndexSync(
      { ...index, plugins: [persistedPlugin, ...index.plugins.slice(1)] },
      { stateDir },
    );

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expect(result.source).toBe("persisted");
    expect(result.snapshot.plugins[0]?.doctorContractHash).toBe("stale-contract-hash");
  });

  it("rehashes Doctor contracts from persisted indexes without file signatures", () => {
    const tempRoot = makeTempDir();
    const rootDir = path.join(tempRoot, "workspace");
    const stateDir = path.join(tempRoot, "state");
    const contractPath = path.join(rootDir, "doctor-contract-api.ts");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = { plugins: { load: { paths: [rootDir] } } };
    writePackagePlugin(rootDir);
    fs.writeFileSync(contractPath, 'export const marker = "aaaa";\n', "utf8");
    const index = loadInstalledPluginIndex({ config, env });
    const plugin = requirePluginRecord(index.plugins, "demo");
    const { doctorContractFile: _doctorContractFile, ...legacyPlugin } = plugin;
    writePersistedInstalledPluginIndexSync(
      {
        ...index,
        plugins: [
          { ...legacyPlugin, doctorContractHash: "stale-contract-hash" },
          ...index.plugins.slice(1),
        ],
      },
      { stateDir },
    );

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expect(result.source).toBe("derived");
    expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
    expect(result.snapshot.plugins[0]?.doctorContractHash).not.toBe("stale-contract-hash");
  });

  it("detects same-size same-mtime Doctor contract replacements", () => {
    const tempRoot = makeTempDir();
    const rootDir = path.join(tempRoot, "workspace");
    const stateDir = path.join(tempRoot, "state");
    const contractPath = path.join(rootDir, "doctor-contract-api.ts");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = { plugins: { load: { paths: [rootDir] } } };
    writePackagePlugin(rootDir);
    fs.writeFileSync(contractPath, 'export const marker = "aaaa";\n', "utf8");
    const index = loadInstalledPluginIndex({ config, env });
    writePersistedInstalledPluginIndexSync(index, { stateDir });

    replaceFilePreservingSizeAndMtime(contractPath, 'export const marker = "bbbb";\n');

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

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

  it("keeps mixed source-checkout bundled roots from the same checkout", () => {
    const tempRoot = makeTempDir();
    const packageRoot = path.join(tempRoot, "openclaw");
    const bundledRoot = path.join(packageRoot, "dist", "extensions");
    const sourceRoot = path.join(packageRoot, "extensions");
    const stateDir = path.join(tempRoot, "state");
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.4.26",
      VITEST: "true",
    };

    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, ".git"), "gitdir: /tmp/mock\n", "utf8");
    fs.writeFileSync(path.join(packageRoot, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
    writeBundledPlugin(path.join(bundledRoot, "codex"), "codex", "index.js", {
      bundledDist: true,
      openclawVersion: "2026.4.26",
      pluginSdkVersion: "2026.4.26",
    });
    writeBundledPlugin(path.join(sourceRoot, "whatsapp"), "whatsapp", "index.ts", {
      openclawVersion: "2026.4.26",
    });

    const index = loadInstalledPluginIndex({ config: {}, env, stateDir });
    expect(index.plugins.map((plugin) => plugin.pluginId)).toEqual(["codex", "whatsapp"]);
    expect(index.plugins.map((plugin) => plugin.rootDir)).toEqual([
      fs.realpathSync(path.join(bundledRoot, "codex")),
      fs.realpathSync(path.join(sourceRoot, "whatsapp")),
    ]);
    expect(requirePluginRecord(index.plugins, "codex").packageBuild).toEqual({
      bundledDist: true,
      openclawVersion: "2026.4.26",
      pluginSdkVersion: "2026.4.26",
    });
    expect(requirePluginRecord(index.plugins, "whatsapp").packageBuild).toEqual({
      openclawVersion: "2026.4.26",
    });
    writePersistedInstalledPluginIndexSync(index, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({ config: {}, env, stateDir });

    expect(result.source).toBe("persisted");
    expect(result.diagnostics).toStrictEqual([]);
    expect(result.snapshot.plugins.map((plugin) => plugin.pluginId)).toEqual(["codex", "whatsapp"]);
    expect(requirePluginRecord(result.snapshot.plugins, "codex").packageBuild).toEqual({
      bundledDist: true,
    });
    expect(requirePluginRecord(result.snapshot.plugins, "whatsapp").packageBuild).toEqual({});
  });

  it("keeps missing disabled bundled records under the trusted bundled root", () => {
    const tempRoot = makeTempDir();
    const bundledRoot = path.join(tempRoot, "dist", "extensions");
    const pluginRoot = path.join(bundledRoot, "whatsapp");
    const stateDir = path.join(tempRoot, "state");
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.4.26",
      VITEST: "true",
    };
    const config = { plugins: { entries: { whatsapp: { enabled: false } } } };
    writeBundledPlugin(pluginRoot, "whatsapp", "index.js");
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.ts"),
      "export const stateMigrations = [];\n",
      "utf8",
    );
    const index = loadInstalledPluginIndex({ config, env, stateDir });
    const persistedPlugin = requirePluginRecord(index.plugins, "whatsapp");
    expect(persistedPlugin.doctorContractHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(persistedPlugin.doctorContractFile).toBeDefined();
    writePersistedInstalledPluginIndexSync(index, { stateDir });
    fs.rmSync(pluginRoot, { recursive: true });

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expect(result.source).toBe("persisted");
    expect(result.diagnostics).toEqual([]);
    expect(result.snapshot.plugins.map((plugin) => plugin.pluginId)).toEqual(["whatsapp"]);
    expect(result.snapshot.plugins[0]?.enabled).toBe(false);
    expect(result.snapshot.plugins[0]?.doctorContractHash).toBe(persistedPlugin.doctorContractHash);
  });

  it("invalidates disabled installed records when their Doctor contract disappears", () => {
    const tempRoot = makeTempDir();
    const bundledRoot = path.join(tempRoot, "dist", "extensions");
    const pluginRoot = path.join(bundledRoot, "whatsapp");
    const stateDir = path.join(tempRoot, "state");
    const contractPath = path.join(pluginRoot, "doctor-contract-api.ts");
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.4.26",
      VITEST: "true",
    };
    const config = { plugins: { entries: { whatsapp: { enabled: false } } } };
    writeBundledPlugin(pluginRoot, "whatsapp", "index.js");
    fs.writeFileSync(contractPath, "export const stateMigrations = [];\n", "utf8");
    const index = loadInstalledPluginIndex({ config, env, stateDir });
    writePersistedInstalledPluginIndexSync(index, { stateDir });
    fs.rmSync(contractPath);

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expect(result.source).toBe("derived");
    expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
  });

  it("keeps missing disabled inventory beside unchanged configured plugins", () => {
    const tempRoot = makeTempDir();
    const liveRoot = path.join(tempRoot, "live");
    const missingRoot = path.join(tempRoot, "missing");
    const stateDir = path.join(tempRoot, "state");
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {
      plugins: {
        load: { paths: [liveRoot, missingRoot] },
        entries: { missing: { enabled: false } },
      },
    };
    writePackagePlugin(liveRoot, { pluginId: "live" });
    writePackagePlugin(missingRoot, { pluginId: "missing" });
    const index = loadInstalledPluginIndex({ config, env });
    writePersistedInstalledPluginIndexSync(index, { stateDir });
    fs.rmSync(missingRoot, { recursive: true });

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expect(result.source).toBe("persisted");
    expect(result.snapshot.plugins.map((plugin) => plugin.pluginId)).toEqual(["live", "missing"]);
  });

  it("treats a persisted source bundled root as stale once its built peer appears", () => {
    const tempRoot = makeTempDir();
    const packageRoot = path.join(tempRoot, "openclaw");
    const bundledRoot = path.join(packageRoot, "dist", "extensions");
    const sourceRoot = path.join(packageRoot, "extensions");
    const stateDir = path.join(tempRoot, "state");
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.4.26",
      VITEST: "true",
    };

    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    fs.mkdirSync(bundledRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, ".git"), "gitdir: /tmp/mock\n", "utf8");
    fs.writeFileSync(path.join(packageRoot, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
    writeBundledPlugin(path.join(sourceRoot, "whatsapp"), "whatsapp", "index.ts");

    const sourceIndex = loadInstalledPluginIndex({ config: {}, env, stateDir });
    expect(sourceIndex.plugins.map((plugin) => plugin.rootDir)).toEqual([
      fs.realpathSync(path.join(sourceRoot, "whatsapp")),
    ]);
    writePersistedInstalledPluginIndexSync(sourceIndex, { stateDir });
    writeBundledPlugin(path.join(bundledRoot, "whatsapp"), "whatsapp", "index.js");

    const result = loadPluginRegistrySnapshotWithMetadata({ config: {}, env, stateDir });

    expect(result.source).toBe("derived");
    expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
    expect(result.snapshot.plugins.map((plugin) => plugin.rootDir)).toEqual([
      fs.realpathSync(path.join(bundledRoot, "whatsapp")),
    ]);
  });

  it("replaces a persisted built root when its source plugin opts out of bundled output", () => {
    const tempRoot = makeTempDir();
    const packageRoot = path.join(tempRoot, "openclaw");
    const bundledRoot = path.join(packageRoot, "dist", "extensions");
    const sourcePluginDir = path.join(packageRoot, "extensions", "whatsapp");
    const stateDir = path.join(tempRoot, "state");
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.4.26",
      VITEST: "true",
    };

    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, ".git"), "gitdir: /tmp/mock\n", "utf8");
    fs.writeFileSync(path.join(packageRoot, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
    writeBundledPlugin(sourcePluginDir, "whatsapp", "index.ts");
    writeBundledPlugin(path.join(bundledRoot, "whatsapp"), "whatsapp", "index.js");

    const builtIndex = loadInstalledPluginIndex({ config: {}, env, stateDir });
    expect(builtIndex.plugins.map((plugin) => plugin.rootDir)).toEqual([
      fs.realpathSync(path.join(bundledRoot, "whatsapp")),
    ]);
    writePersistedInstalledPluginIndexSync(builtIndex, { stateDir });
    fs.writeFileSync(
      path.join(sourcePluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/whatsapp",
        version: "1.0.0",
        openclaw: { extensions: ["./index.ts"], build: { bundledDist: false } },
      }),
      "utf8",
    );

    const result = loadPluginRegistrySnapshotWithMetadata({ config: {}, env, stateDir });

    expect(result.source).toBe("derived");
    expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
    expect(result.snapshot.plugins.map((plugin) => plugin.rootDir)).toEqual([
      fs.realpathSync(sourcePluginDir),
    ]);
  });

  it("keeps a persisted bind-mounted source overlay when its built peer exists", () => {
    const tempRoot = makeTempDir();
    const packageRoot = path.join(tempRoot, "openclaw");
    const bundledRoot = path.join(packageRoot, "dist", "extensions");
    const sourcePluginDir = path.join(packageRoot, "extensions", "whatsapp");
    const stateDir = path.join(tempRoot, "state");
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.4.26",
      VITEST: "true",
    };

    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    fs.mkdirSync(bundledRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, ".git"), "gitdir: /tmp/mock\n", "utf8");
    fs.writeFileSync(path.join(packageRoot, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
    writeBundledPlugin(sourcePluginDir, "whatsapp", "index.ts");

    const sourceIndex = loadInstalledPluginIndex({ config: {}, env, stateDir });
    writePersistedInstalledPluginIndexSync(sourceIndex, { stateDir });
    writeBundledPlugin(path.join(bundledRoot, "whatsapp"), "whatsapp", "index.js");
    mockLinuxMountInfo([sourcePluginDir]);

    const result = loadPluginRegistrySnapshotWithMetadata({ config: {}, env, stateDir });

    expect(result.source).toBe("persisted");
    expect(result.diagnostics).toStrictEqual([]);
    expect(result.snapshot.plugins.map((plugin) => plugin.rootDir)).toEqual([
      fs.realpathSync(sourcePluginDir),
    ]);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
