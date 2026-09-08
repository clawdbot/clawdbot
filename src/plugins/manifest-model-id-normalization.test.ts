// Verifies model IDs declared by plugin manifests are normalized.
import fs from "node:fs";
import path from "node:path";
import { normalizeConfiguredProviderCatalogModelId } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { normalizeStaticProviderModelId } from "../agents/model-ref-shared.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store-write.js";
import { listOpenClawPluginManifestMetadata } from "./manifest-metadata-scan.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
// Registers the snapshot resolver in the runtime bridge slot. Production and
// jiti load it via the bridge's require fallback; vitest workers lack a CJS TS
// hook, so the no-snapshot fallback path needs the ESM registration.
import {
  projectPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
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

function normalizeDemoModel(modelId = "demo-model"): string {
  return normalizeStaticProviderModelId("demo", modelId);
}

describe("manifest model id normalization", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    clearPluginMetadataLifecycleCaches();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginRuntimeStateForTest();
    clearPluginMetadataLifecycleCaches();
    restoreEnv();
    tempDirs.cleanup();
  });

  it("does not reuse broader normalization policies in a narrowed metadata view", () => {
    const stateDir = tempDirs.make("openclaw-model-id-normalization-");
    const pluginDir = path.join(stateDir, "extensions", "normalizer");
    writeInstallIndex({ stateDir, pluginDir });
    writeNormalizerManifest({ pluginDir, prefix: "scoped" });
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    deleteTestEnvValue("OPENCLAW_HOME");
    setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    deleteTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR");
    const snapshot = resolvePluginMetadataSnapshot({ config: {}, env: process.env });
    const narrowed = projectPluginMetadataSnapshot(snapshot, []);
    setCurrentPluginMetadataSnapshot(snapshot, { config: {}, env: process.env });
    const normalize = (view: typeof snapshot) =>
      withPluginMetadataSnapshotScope(view, () => normalizeDemoModel(), {
        trustConfigIdentity: true,
      });

    expect(normalize(snapshot)).toBe("scoped/demo-model");
    expect(normalize(narrowed)).toBe("demo-model");
    expect(normalizeConfiguredProviderCatalogModelId("demo", "demo-model")).toBe(
      "scoped/demo-model",
    );
    expect(
      normalizeConfiguredProviderCatalogModelId(
        "demo",
        "demo-model",
        narrowed.owners.modelIdNormalizationPolicies,
      ),
    ).toBe("demo-model");
    expect(normalize(snapshot)).toBe("scoped/demo-model");
  });

  it("keeps process metadata stable until the lifecycle owner reloads it", () => {
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
    expect(normalizeDemoModel()).toBe("alpha/demo-model");

    clearPluginMetadataLifecycleCaches();
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
    const readFile = vi.spyOn(fs, "readFileSync");
    const readBytes = vi.spyOn(fs, "readSync");
    const secondRecords = listNormalizerRecords();
    expect(firstRecords).toHaveLength(1);
    expect(secondRecords).toHaveLength(1);
    expect(secondRecords).toEqual(firstRecords);
    expect(secondRecords[0]?.manifest).toBe(firstRecords[0]?.manifest);
    expect(readFile).not.toHaveBeenCalled();
    expect(readBytes).not.toHaveBeenCalled();
  });
});
