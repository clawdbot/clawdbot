import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import { loadInstalledPluginIndex, type InstalledPluginIndex } from "./installed-plugin-index.js";
import { loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry-snapshot.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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
