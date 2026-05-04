import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCurrentPluginMetadataSnapshot,
  resolvePluginMetadataControlPlaneFingerprint,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { listOpenClawPluginManifestMetadata } from "./manifest-metadata-scan.js";
import { normalizeProviderModelIdWithManifest } from "./manifest-model-id-normalization.js";
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

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-id-normalization-"));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function writeInstallIndex(params: { stateDir: string; pluginDir: string }): void {
  const indexPath = path.join(params.stateDir, "plugins", "installs.json");
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(
    indexPath,
    JSON.stringify({
      plugins: [
        {
          id: "normalizer",
          rootDir: params.pluginDir,
          origin: "global",
        },
      ],
    }),
    "utf-8",
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
}): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash({});
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
    configFingerprint: resolvePluginMetadataControlPlaneFingerprint(
      {},
      {
        env: process.env,
        index,
        policyHash,
        workspaceDir: params.workspaceDir,
      },
    ),
    workspaceDir: params.workspaceDir,
    index,
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

describe("manifest model id normalization", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
  });

  afterEach(() => {
    clearCurrentPluginMetadataSnapshot();
    resetPluginRuntimeStateForTest();
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

  it("reflects manifest edits and state-dir changes on the next lookup", () => {
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
    expect(normalizeDemoModel()).toBe("bravo-local/demo-model");

    const stateDirB = makeTempDir();
    const pluginDirB = path.join(stateDirB, "extensions", "normalizer");
    writeInstallIndex({ stateDir: stateDirB, pluginDir: pluginDirB });
    writeNormalizerManifest({ pluginDir: pluginDirB, prefix: "charlie" });

    process.env.OPENCLAW_STATE_DIR = stateDirB;
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
