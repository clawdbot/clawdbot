// Verifies model IDs declared by plugin manifests are normalized.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import { listOpenClawPluginManifestMetadata } from "./manifest-metadata-scan.js";
import { normalizeProviderModelIdWithManifest } from "./manifest-model-id-normalization.js";
// Registers the snapshot resolver in the runtime bridge slot. Production and
// jiti load it via the bridge's require fallback; vitest workers lack a CJS TS
// hook, so the no-snapshot fallback path needs the ESM registration.
import "./plugin-metadata-snapshot.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";

const tempDirs = createTempDirTracker();
const testEnvSnapshot = captureEnv([
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_HOME",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
]);

function restoreEnv(): void {
  testEnvSnapshot.restore();
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

function normalizeDemoModel(modelId = "demo-model"): string | undefined {
  return normalizeProviderModelIdWithManifest({
    provider: "demo",
    context: { provider: "demo", modelId },
  });
}

describe("manifest model id normalization", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    clearPluginMetadataLifecycleCaches();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    clearPluginMetadataLifecycleCaches();
    restoreEnv();
    tempDirs.cleanup();
  });

  it("reflects manifest edits and state directory changes without a prepared snapshot", () => {
    const stateDirA = tempDirs.make("openclaw-model-id-normalization-");
    const pluginDirA = path.join(stateDirA, "extensions", "normalizer");
    writeInstallIndex({ stateDir: stateDirA, pluginDir: pluginDirA });
    writeNormalizerManifest({ pluginDir: pluginDirA, prefix: "alpha" });

    setTestEnvValue("OPENCLAW_STATE_DIR", stateDirA);
    deleteTestEnvValue("OPENCLAW_HOME");
    setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    deleteTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR");

    expect(normalizeDemoModel()).toBe("alpha/demo-model");

    writeNormalizerManifest({ pluginDir: pluginDirA, prefix: "bravo-local" });
    expect(normalizeDemoModel()).toBe("bravo-local/demo-model");

    const stateDirB = tempDirs.make("openclaw-model-id-normalization-");
    const pluginDirB = path.join(stateDirB, "extensions", "normalizer");
    writeInstallIndex({ stateDir: stateDirB, pluginDir: pluginDirB });
    writeNormalizerManifest({ pluginDir: pluginDirB, prefix: "charlie" });

    setTestEnvValue("OPENCLAW_STATE_DIR", stateDirB);
    clearPluginMetadataLifecycleCaches();
    expect(normalizeDemoModel()).toBe("charlie/demo-model");
  });

  it("reuses manifest metadata for the same environment identity", () => {
    const stateDir = tempDirs.make("openclaw-model-id-normalization-");
    const pluginDir = path.join(stateDir, "extensions", "normalizer");
    writeInstallIndex({ stateDir, pluginDir });
    writeNormalizerManifest({ pluginDir, prefix: "alpha" });

    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    deleteTestEnvValue("OPENCLAW_HOME");
    setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    deleteTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR");

    // The scan also lists source-checkout extensions/ manifests when tests run
    // from a repo checkout, so only pin the record for the plugin under test.
    const listNormalizerRecords = () =>
      listOpenClawPluginManifestMetadata(process.env).filter(
        (record) => record.pluginDir === pluginDir,
      );
    const firstRecords = listNormalizerRecords();
    const secondRecords = listNormalizerRecords();
    expect(firstRecords).toHaveLength(1);
    expect(secondRecords).toHaveLength(1);
    expect(secondRecords[0]).toBe(firstRecords[0]);
  });
});
