// Verifies model IDs declared by plugin manifests are normalized.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearCurrentPluginMetadataSnapshot,
  resolvePluginMetadataControlPlaneFingerprint,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { listOpenClawPluginManifestMetadata } from "./manifest-metadata-scan.js";
import { normalizeProviderModelIdWithManifest } from "./manifest-model-id-normalization.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

const ORIGINAL_ENV = {
  OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
  OPENCLAW_HOME: process.env.OPENCLAW_HOME,
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS,
  OPENCLAW_BUNDLED_PLUGINS_DIR: process.env.OPENCLAW_BUNDLED_PLUGINS_DIR,
} as const;

const tempDirs: string[] = [];

function restoreOpenClawStateDirEnv(): void {
  const value = ORIGINAL_ENV.OPENCLAW_STATE_DIR;
  if (value === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = value;
  }
}

function restoreOpenClawHomeEnv(): void {
  const value = ORIGINAL_ENV.OPENCLAW_HOME;
  if (value === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = value;
  }
}

function restoreOpenClawDisableBundledPluginsEnv(): void {
  const value = ORIGINAL_ENV.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  if (value === undefined) {
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  } else {
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = value;
  }
}

function restoreOpenClawBundledPluginsDirEnv(): void {
  const value = ORIGINAL_ENV.OPENCLAW_BUNDLED_PLUGINS_DIR;
  if (value === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = value;
  }
}

function restoreEnv(): void {
  restoreOpenClawStateDirEnv();
  restoreOpenClawHomeEnv();
  restoreOpenClawDisableBundledPluginsEnv();
  restoreOpenClawBundledPluginsDirEnv();
}

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-id-normalization-"));
  tempDirs.push(dir);
  return dir;
}

function writeInstallIndex(params: { stateDir: string; pluginDir: string }): void {
  writePersistedInstalledPluginIndexSync(
    {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "test",
      generatedAtMs: 1,
      installRecords: {},
      plugins: [
        {
          pluginId: "normalizer",
          manifestPath: path.join(params.pluginDir, "openclaw.plugin.json"),
          manifestHash: "normalizer-manifest",
          rootDir: params.pluginDir,
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
    },
    { stateDir: params.stateDir },
  );
}

function writeNormalizerManifest(params: { pluginDir: string; prefix: string }): void {
  fs.mkdirSync(params.pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(params.pluginDir, "index.ts"),
    "throw new Error('runtime entry should not load while reading manifests');\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(params.pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "normalizer",
      configSchema: { type: "object" },
      providers: ["demo"],
      modelIdNormalization: {
        providers: {
          demo: {
            prefixWhenBare: params.prefix,
          },
        },
      },
    }),
    "utf-8",
  );
}

function createCurrentSnapshot(params: {
  manifestHash: string;
  prefix: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
}): PluginMetadataSnapshot {
  const config = params.config ?? {};
  const policyHash = resolveInstalledPluginIndexPolicyHash(config);
  const index: InstalledPluginIndex = {
    version: 1,
    hostContractVersion: "test-host",
    compatRegistryVersion: "test-compat",
    migrationVersion: 1,
    policyHash,
    generatedAtMs: 0,
    installRecords: {},
    plugins: [
      {
        pluginId: "normalizer",
        manifestPath: `/tmp/normalizer-${params.manifestHash}/openclaw.plugin.json`,
        manifestHash: params.manifestHash,
        source: `/tmp/normalizer-${params.manifestHash}/index.ts`,
        rootDir: `/tmp/normalizer-${params.manifestHash}`,
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
  return {
    policyHash,
    configFingerprint: resolvePluginMetadataControlPlaneFingerprint(config, {
      env: process.env,
      index,
      policyHash,
      workspaceDir: params.workspaceDir,
    }),
    workspaceDir: params.workspaceDir,
    index,
    registryDiagnostics: [],
    plugins: [
      {
        id: "normalizer",
        modelIdNormalization: {
          providers: {
            demo: {
              prefixWhenBare: params.prefix,
            },
          },
        },
      },
    ],
  } as unknown as PluginMetadataSnapshot;
}

function normalizeDemoModel(modelId = "demo-model"): string | undefined {
  return normalizeProviderModelIdWithManifest({
    provider: "demo",
    context: { provider: "demo", modelId },
  });
}

function normalizeDemoModelWithEnv(
  env: NodeJS.ProcessEnv,
  modelId = "demo-model",
): string | undefined {
  return normalizeProviderModelIdWithManifest({
    provider: "demo",
    env,
    context: { provider: "demo", modelId },
  });
}

describe("manifest model id normalization", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    clearPluginMetadataLifecycleCaches();
  });

  afterEach(() => {
    clearCurrentPluginMetadataSnapshot();
    resetPluginRuntimeStateForTest();
    clearPluginMetadataLifecycleCaches();
    restoreEnv();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes cached policies when the current metadata snapshot changes", () => {
    setCurrentPluginMetadataSnapshot(
      createCurrentSnapshot({
        manifestHash: "alpha",
        prefix: "alpha",
      }),
      { config: {}, env: process.env },
    );

    expect(normalizeDemoModel()).toBe("alpha/demo-model");
    expect(normalizeDemoModel("second-model")).toBe("alpha/second-model");

    setCurrentPluginMetadataSnapshot(
      createCurrentSnapshot({
        manifestHash: "bravo",
        prefix: "bravo",
      }),
      { config: {}, env: process.env },
    );

    expect(normalizeDemoModel()).toBe("bravo/demo-model");
  });

  it("uses workspace-scoped current metadata through the active plugin runtime", () => {
    setActivePluginRegistry(
      createEmptyPluginRegistry(),
      "workspace-a",
      "gateway-bindable",
      "/workspace/a",
    );
    setCurrentPluginMetadataSnapshot(
      createCurrentSnapshot({
        manifestHash: "alpha",
        prefix: "alpha",
        workspaceDir: "/workspace/a",
      }),
      { config: {}, env: process.env },
    );

    expect(normalizeDemoModel()).toBe("alpha/demo-model");
    expect(normalizeDemoModel("second-model")).toBe("alpha/second-model");

    setCurrentPluginMetadataSnapshot(
      createCurrentSnapshot({
        manifestHash: "bravo",
        prefix: "bravo",
        workspaceDir: "/workspace/a",
      }),
      { config: {}, env: process.env },
    );

    expect(normalizeDemoModel()).toBe("bravo/demo-model");
  });

  it("reuses workspace-scoped current metadata for unscoped normalization", () => {
    setCurrentPluginMetadataSnapshot(
      createCurrentSnapshot({
        manifestHash: "alpha",
        prefix: "alpha",
        workspaceDir: "/workspace/a",
      }),
      { config: {}, env: process.env },
    );

    expect(normalizeDemoModel()).toBe("alpha/demo-model");
  });

  it("reuses current metadata when callers omit config", () => {
    const config: OpenClawConfig = { plugins: { allow: ["normalizer"] } };
    setCurrentPluginMetadataSnapshot(
      createCurrentSnapshot({
        manifestHash: "alpha",
        prefix: "alpha",
        config,
      }),
      { config, env: process.env },
    );

    expect(normalizeDemoModel()).toBe("alpha/demo-model");
  });

  it("validates explicit env before reusing current metadata", () => {
    setCurrentPluginMetadataSnapshot(
      createCurrentSnapshot({
        manifestHash: "alpha",
        prefix: "alpha",
      }),
      { config: {}, env: process.env },
    );

    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "normalizer");
    writeInstallIndex({ stateDir, pluginDir });
    writeNormalizerManifest({ pluginDir, prefix: "bravo" });

    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_HOME: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    };

    expect(normalizeDemoModelWithEnv(env)).toBe("bravo/demo-model");
  });

  it("keeps process metadata stable across manifest edits and reflects state-dir changes", () => {
    const stateDirA = makeTempDir();
    const pluginDirA = path.join(stateDirA, "extensions", "normalizer");
    writeInstallIndex({ stateDir: stateDirA, pluginDir: pluginDirA });
    writeNormalizerManifest({ pluginDir: pluginDirA, prefix: "alpha" });

    process.env.OPENCLAW_STATE_DIR = stateDirA;
    process.env.OPENCLAW_HOME = undefined;
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = undefined;

    expect(normalizeDemoModel()).toBe("alpha/demo-model");

    writeNormalizerManifest({ pluginDir: pluginDirA, prefix: "bravo-local" });
    expect(normalizeDemoModel()).toBe("alpha/demo-model");

    const stateDirB = makeTempDir();
    const pluginDirB = path.join(stateDirB, "extensions", "normalizer");
    writeInstallIndex({ stateDir: stateDirB, pluginDir: pluginDirB });
    writeNormalizerManifest({ pluginDir: pluginDirB, prefix: "charlie" });

    process.env.OPENCLAW_STATE_DIR = stateDirB;
    clearPluginMetadataLifecycleCaches();
    expect(normalizeDemoModel()).toBe("charlie/demo-model");
  });

  it("reuses manifest metadata while file fingerprints are unchanged", () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "normalizer");
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    writeInstallIndex({ stateDir, pluginDir });
    writeNormalizerManifest({ pluginDir, prefix: "alpha" });

    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_HOME = undefined;
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = undefined;

    const readFileSyncSpy = vi.spyOn(fs, "readFileSync");

    expect(listOpenClawPluginManifestMetadata(process.env)).toHaveLength(1);
    expect(listOpenClawPluginManifestMetadata(process.env)).toHaveLength(1);

    const manifestReads = readFileSyncSpy.mock.calls.filter(
      ([filePath]) => String(filePath) === manifestPath,
    );
    expect(manifestReads).toHaveLength(1);
    readFileSyncSpy.mockRestore();
  });
});
