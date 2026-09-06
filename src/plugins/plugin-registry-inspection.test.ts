import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs: string[] = [];

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
});

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

function createPackagedCandidate(rootDir: string): PluginCandidate {
  const candidate = createCandidate(rootDir);
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({ name: "demo", version: "1.0.0" }),
    "utf8",
  );
  return { ...candidate, packageDir: rootDir, packageName: "demo", packageVersion: "1.0.0" };
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
    clearPluginMetadataLifecycleCaches();
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
    expect(inspection.differences).toEqual([
      {
        pluginId: "demo",
        persistedSource: sourceCandidate.source,
        derivedSource: builtSource,
      },
    ]);
    expect(inspection.current.plugins[0]?.source).toBe(builtSource);
  });

  it("keeps an older registry fresh when current build metadata is not durable", async () => {
    const stateDir = makeTempDir();
    const pluginDir = makeTempDir();
    createPackagedCandidate(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "demo",
        version: "1.0.0",
        openclaw: {
          extensions: ["./index.ts"],
          build: { openclawVersion: "2026.4.25" },
        },
      }),
      "utf8",
    );
    const env = { ...hermeticEnv(), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = { plugins: { load: { paths: [pluginDir] } } };
    const refreshed = await refreshPluginRegistry({ reason: "manual", stateDir, config, env });
    expect(expectDefined(refreshed.plugins[0], "refreshed plugin").packageBuild).toEqual({
      openclawVersion: "2026.4.25",
    });

    const persisted = expectDefined(
      await readPersistedInstalledPluginIndex({ stateDir }),
      "persisted plugin registry",
    );
    await writePersistedInstalledPluginIndex(
      {
        ...persisted,
        plugins: persisted.plugins.map(({ packageBuild: _packageBuild, ...plugin }) => plugin),
      },
      { stateDir },
    );

    const inspection = await inspectPluginRegistry({ stateDir, config, env });

    expect({
      state: inspection.state,
      refreshReasons: inspection.refreshReasons,
      differencePluginIds: inspection.differences.map((difference) => difference.pluginId),
    }).toEqual({ state: "fresh", refreshReasons: [], differencePluginIds: [] });
  });

  it("inspects package changes with fresh file facts", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "demo");
    const sourceDir = makeTempDir();
    fs.mkdirSync(pluginDir, { recursive: true });
    const candidate = createPackagedCandidate(pluginDir);
    createPackagedCandidate(sourceDir);
    const env = {
      ...hermeticEnv(),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
    };
    const config = { plugins: { entries: { demo: { enabled: true } } } };
    await refreshPluginRegistry({
      reason: "manual",
      stateDir,
      config,
      env,
      installRecords: {
        demo: { source: "path", sourcePath: sourceDir, installPath: pluginDir, version: "1.0.0" },
      },
    });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "demo", version: "2.0.0" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(sourceDir, "package.json"),
      JSON.stringify({ name: "demo", version: "2.0.0" }),
      "utf8",
    );

    const inspection = await inspectPluginRegistry({
      stateDir,
      config,
      env,
    });

    expect(inspection.state).toBe("stale");
    expect(inspection.refreshReasons).toEqual(["stale-package"]);
    expect(inspection.differences).toEqual([
      {
        pluginId: "demo",
        persistedSource: candidate.source,
        derivedSource: candidate.source,
      },
    ]);
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

  it("fails closed when refreshing a copied state root", async () => {
    const sourceStateDir = makeTempDir();
    const copiedStateDir = path.join(makeTempDir(), "copied-state");
    const externalDir = makeTempDir();
    createPackagedCandidate(externalDir);
    const packageName = "openclaw-copied-managed";
    const sourceManagedPath = writeManagedNpmPlugin({
      stateDir: sourceStateDir,
      packageName,
      pluginId: "copied-managed",
      version: "1.0.0",
    });
    const config = { plugins: { load: { paths: [externalDir] } } };

    await refreshPluginRegistry({
      reason: "manual",
      stateDir: sourceStateDir,
      config,
      env: { ...hermeticEnv(), OPENCLAW_STATE_DIR: sourceStateDir },
      installRecords: {
        "copied-managed": {
          source: "npm",
          spec: `${packageName}@1.0.0`,
          installPath: sourceManagedPath,
          resolvedName: packageName,
          resolvedVersion: "1.0.0",
        },
        demo: {
          source: "path",
          sourcePath: externalDir,
          installPath: externalDir,
          version: "1.0.0",
        },
      },
    });
    closeOpenClawStateDatabaseForTest();
    clearPluginMetadataLifecycleCaches();
    fs.cpSync(sourceStateDir, copiedStateDir, { recursive: true });

    expect(fs.existsSync(sourceManagedPath)).toBe(true);
    await expect(
      refreshPluginRegistry({
        reason: "manual",
        stateDir: copiedStateDir,
        config,
        env: { ...hermeticEnv(), OPENCLAW_STATE_DIR: copiedStateDir },
      }),
    ).rejects.toThrow("cannot verify npm install ownership outside the selected state directory");
    const persisted = expectDefined(
      await readPersistedInstalledPluginIndex({ stateDir: copiedStateDir }),
      "copied plugin registry",
    );
    expect(persisted.installRecords["copied-managed"]?.installPath).toBe(sourceManagedPath);
    expect(persisted.installRecords.demo).toMatchObject({
      source: "path",
      sourcePath: externalDir,
      installPath: externalDir,
    });
  });

  it("does not rewrite an external managed npm project", async () => {
    const stateDir = makeTempDir();
    const externalStateDir = makeTempDir();
    const packageName = "openclaw-external-managed";
    const externalInstallPath = writeManagedNpmPlugin({
      stateDir: externalStateDir,
      packageName,
      pluginId: "external-managed",
      version: "1.0.0",
    });
    writeManagedNpmPlugin({
      stateDir,
      packageName,
      pluginId: "external-managed",
      version: "2.0.0",
    });
    await refreshPluginRegistry({
      reason: "manual",
      stateDir,
      env: { ...hermeticEnv(), OPENCLAW_STATE_DIR: stateDir },
      installRecords: {
        "external-managed": {
          source: "npm",
          spec: `${packageName}@1.0.0`,
          installPath: externalInstallPath,
          resolvedName: packageName,
          resolvedVersion: "1.0.0",
        },
      },
    });

    await expect(
      refreshPluginRegistry({
        reason: "manual",
        stateDir,
        env: { ...hermeticEnv(), OPENCLAW_STATE_DIR: stateDir },
      }),
    ).rejects.toThrow("cannot verify npm install ownership outside the selected state directory");
    const persisted = expectDefined(
      await readPersistedInstalledPluginIndex({ stateDir }),
      "external plugin registry",
    );
    expect(persisted.installRecords["external-managed"]?.installPath).toBe(externalInstallPath);
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
