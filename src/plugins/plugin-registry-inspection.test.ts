import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { PluginCandidate } from "./discovery.js";
import {
  refreshPersistedInstalledPluginIndex,
  writePersistedInstalledPluginIndex,
} from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { refreshPluginRegistry } from "./plugin-registry-refresh.js";
import {
  inspectPluginRegistry,
  loadPluginRegistrySnapshotWithMetadata,
} from "./plugin-registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-plugin-registry-inspection", tempDirs);
}

function hermeticEnv(): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_VERSION: "2026.4.25",
    VITEST: "true",
  };
}

function createCandidate(rootDir: string): PluginCandidate {
  const source = path.join(rootDir, "index.ts");
  fs.writeFileSync(source, "export default { register() {} };\n", "utf8");
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({ id: "demo", name: "Demo", configSchema: { type: "object" } }),
    "utf8",
  );
  return { idHint: "demo", source, rootDir, origin: "global" };
}

function createEmptyIndex(stateDir: string): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    installRecords: {
      missing: {
        source: "npm",
        spec: "missing-plugin@1.0.0",
        installPath: path.join(stateDir, "plugins", "missing"),
      },
    },
    plugins: [],
    diagnostics: [],
  };
}

describe("plugin registry inspection", () => {
  it("derives without persisted install records when persisted reads are disabled", async () => {
    const stateDir = makeTempDir();
    const pluginDir = makeTempDir();
    const candidate = createCandidate(pluginDir);
    await writePersistedInstalledPluginIndex(createEmptyIndex(stateDir), { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [candidate],
      env: hermeticEnv(),
      preferPersisted: false,
    });

    expect(result.source).toBe("derived");
    expect(result.snapshot.plugins.map((plugin) => plugin.pluginId)).toEqual(["demo"]);
    expect(result.snapshot.installRecords).not.toHaveProperty("missing");
  });

  it("reports missing, fresh, policy, and manifest freshness from the snapshot selector", async () => {
    const stateDir = makeTempDir();
    const pluginDir = makeTempDir();
    const candidate = createCandidate(pluginDir);
    const env = hermeticEnv();
    const config = {};

    const missing = await inspectPluginRegistry({ stateDir, candidates: [candidate], config, env });
    expect(missing.state).toBe("missing");
    expect(missing.refreshReasons).toEqual(["missing"]);

    await refreshPluginRegistry({
      reason: "manual",
      stateDir,
      candidates: [candidate],
      config,
      env,
    });
    const fresh = await inspectPluginRegistry({ stateDir, candidates: [candidate], config, env });
    expect(fresh.state).toBe("fresh");
    expect(fresh.refreshReasons).toEqual([]);

    const policy = await inspectPluginRegistry({
      stateDir,
      candidates: [candidate],
      config: { plugins: { entries: { demo: { enabled: false } } } },
      env,
    });
    expect(policy.state).toBe("stale");
    expect(policy.refreshReasons).toEqual(["policy-changed"]);

    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        configSchema: { type: "object" },
        providers: ["demo-next"],
      }),
      "utf8",
    );
    const manifest = await inspectPluginRegistry({
      stateDir,
      candidates: [candidate],
      config,
      env,
    });
    expect(manifest.state).toBe("stale");
    expect(manifest.refreshReasons).toEqual(["stale-manifest"]);
  });

  it("agrees with snapshot selection when a packaged runtime entry changes", async () => {
    const stateDir = makeTempDir();
    const pluginDir = makeTempDir();
    const sourceCandidate = createCandidate(pluginDir);
    const env = hermeticEnv();
    await refreshPluginRegistry({
      reason: "manual",
      stateDir,
      candidates: [sourceCandidate],
      env,
    });
    const builtSource = path.join(pluginDir, "index.js");
    fs.writeFileSync(builtSource, "export default { register() {} };\n", "utf8");
    fs.rmSync(sourceCandidate.source);
    const builtCandidate = { ...sourceCandidate, source: builtSource };

    const snapshot = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      candidates: [builtCandidate],
      env,
    });
    const inspection = await inspectPluginRegistry({
      stateDir,
      candidates: [builtCandidate],
      env,
    });

    expect(snapshot.source).toBe("derived");
    expect(snapshot.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "persisted-registry-stale-source",
    ]);
    expect(inspection.state).toBe("stale");
    expect(inspection.refreshReasons).toEqual(["source-changed"]);
    expect(inspection.current.plugins[0]?.source).toBe(builtSource);
  });

  it("uses the configured system-agent workspace for the freshness verdict", async () => {
    const stateDir = makeTempDir();
    const workspaceDir = makeTempDir();
    const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    createCandidate(pluginDir);
    const env = { ...hermeticEnv(), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {
      agents: {
        ownership: "explicit" as const,
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: { workspace: workspaceDir } },
      },
    };
    await refreshPersistedInstalledPluginIndex({
      reason: "manual",
      stateDir,
      config,
      env,
    });

    const listSelection = loadPluginRegistrySnapshotWithMetadata({
      stateDir,
      workspaceDir,
      config,
      env,
    });
    const inspection = await inspectPluginRegistry({ stateDir, config, env });

    expect(listSelection.source).toBe("derived");
    expect(listSelection.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "persisted-registry-stale-source",
    ]);
    expect(inspection.state).toBe("stale");
    expect(inspection.refreshReasons).toEqual(["source-changed"]);
    expect(inspection.current.workspaceDir).toBe(workspaceDir);
    expect(inspection.current.plugins.map((plugin) => plugin.pluginId)).toEqual(["demo"]);

    await refreshPluginRegistry({ reason: "manual", stateDir, config, env });
    const repaired = await inspectPluginRegistry({ stateDir, config, env });
    expect(repaired.state).toBe("fresh");
    expect(repaired.refreshReasons).toEqual([]);
  });

  it("preserves install records when refreshing the persisted registry", async () => {
    const stateDir = makeTempDir();
    await writePersistedInstalledPluginIndex(createEmptyIndex(stateDir), { stateDir });

    await refreshPluginRegistry({ reason: "manual", stateDir, candidates: [], env: hermeticEnv() });

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    expect(persisted?.installRecords.missing).toMatchObject({
      source: "npm",
      spec: "missing-plugin@1.0.0",
      installPath: path.join(stateDir, "plugins", "missing"),
    });
    expect(persisted?.plugins).toEqual([]);
  });
});
