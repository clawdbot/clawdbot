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
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "persisted-registry-stale-source" }),
    );
    expect(result.snapshot.installRecords).toMatchObject({
      whatsapp: {
        source: "npm",
        spec: "@openclaw/whatsapp@2026.5.2",
        installPath: whatsappDir,
        version: "2026.5.2",
        resolvedName: "@openclaw/whatsapp",
        resolvedVersion: "2026.5.2",
        resolvedSpec: "@openclaw/whatsapp@2026.5.2",
      },
    });
    expect(result.snapshot.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "whatsapp",
          origin: "global",
        }),
      ]),
    );
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
    expect(record.manifestFile).toEqual(
      expect.objectContaining({
        size: fs.statSync(path.join(rootDir, "openclaw.plugin.json")).size,
      }),
    );
    expect(record.packageJson.fileSignature).toEqual(
      expect.objectContaining({
        size: fs.statSync(path.join(rootDir, "package.json")).size,
      }),
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
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "persisted-registry-stale-source" }),
    );
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
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "persisted-registry-stale-source" }),
    );
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
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "persisted-registry-stale-source" }),
    );
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
    expect(result.snapshot.diagnostics).not.toContainEqual(
      expect.objectContaining({ source: ghostDir }),
    );
    expect(result.snapshot.plugins).toContainEqual(
      expect.objectContaining({
        pluginId: "lossless-claw",
        origin: "global",
        source: fs.realpathSync(path.join(npmPluginDir, "dist", "index.js")),
      }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "persisted-registry-stale-source" }),
    );
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
    expect(result.snapshot.diagnostics).toContainEqual(
      expect.objectContaining({ source: missingConfiguredPath }),
    );
    expect(result.diagnostics).toStrictEqual([]);
  });
});
