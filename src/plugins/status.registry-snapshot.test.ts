import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { refreshPluginRegistry } from "./plugin-registry.js";
import { buildPluginRegistrySnapshotReport, buildPluginSnapshotReport } from "./status.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
  createColdPluginHermeticEnv,
  isColdPluginRuntimeLoaded,
} from "./test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-status", tempDirs);
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function requirePlugin(
  plugins: readonly Record<string, unknown>[],
  id: string,
): Record<string, unknown> {
  const plugin = plugins.find((entry) => entry.id === id);
  if (!plugin) {
    throw new Error(`Expected plugin ${id}`);
  }
  return requireRecord(plugin);
}

function requireRecordArray(value: unknown): Record<string, unknown>[] {
  expect(Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>[];
}

function requireNamedEntry(
  entries: readonly Record<string, unknown>[],
  name: string,
): Record<string, unknown> {
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) {
    throw new Error(`Expected entry ${name}`);
  }
  return requireRecord(entry);
}

function expectFields(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
}

describe("buildPluginRegistrySnapshotReport", () => {
  it("keeps recovered managed npm plugins visible when the persisted registry is stale", () => {
    const tempRoot = makeTempDir();
    const stateDir = path.join(tempRoot, "state");
    const env = {
      ...createColdPluginHermeticEnv(tempRoot, {
        bundledPluginsDir: makeTempDir(),
        disablePersistedRegistry: false,
      }),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
    };
    const config = {
      plugins: {
        entries: {
          whatsapp: { enabled: true },
        },
      },
    };
    const whatsappDir = writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/whatsapp",
      pluginId: "whatsapp",
      version: "2026.5.2",
      name: "WhatsApp",
    });
    const staleIndex = loadInstalledPluginIndex({
      config,
      env,
      installRecords: {},
    });
    expect(staleIndex.plugins.map((plugin) => plugin.pluginId)).not.toContain("whatsapp");
    writePersistedInstalledPluginIndexSync(staleIndex, { stateDir });

    const report = buildPluginRegistrySnapshotReport({
      config,
      env,
    });

    expect(report.registrySource).toBe("derived");
    expect(
      report.registryDiagnostics.some(
        (diagnostic) => diagnostic.code === "persisted-registry-stale-source",
      ),
    ).toBe(true);
    expectFields(requirePlugin(report.plugins, "whatsapp"), {
      id: "whatsapp",
      name: "WhatsApp",
      source: fs.realpathSync(path.join(whatsappDir, "dist", "index.js")),
      status: "loaded",
    });
  });

  it("reconstructs list metadata from indexed manifests without importing plugin runtime", () => {
    const fixture = createColdPluginFixture({
      rootDir: makeTempDir(),
      pluginId: "indexed-demo",
      packageName: "@example/openclaw-indexed-demo",
      packageVersion: "9.8.7",
      manifest: {
        id: "indexed-demo",
        name: "Indexed Demo",
        description: "Manifest-backed list metadata",
        version: "1.2.3",
        providers: ["indexed-provider"],
        contracts: {
          speechProviders: ["indexed-speech-provider"],
          realtimeTranscriptionProviders: ["indexed-transcription-provider"],
          realtimeVoiceProviders: ["indexed-voice-provider"],
        },
        commandAliases: [{ name: "indexed-demo" }],
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
    });

    const report = buildPluginRegistrySnapshotReport({
      config: {
        plugins: {
          load: { paths: [fixture.rootDir] },
        },
      },
    });

    expectFields(requirePlugin(report.plugins, "indexed-demo"), {
      id: "indexed-demo",
      name: "Indexed Demo",
      description: "Manifest-backed list metadata",
      version: "9.8.7",
      format: "openclaw",
      providerIds: ["indexed-provider"],
      speechProviderIds: ["indexed-speech-provider"],
      realtimeTranscriptionProviderIds: ["indexed-transcription-provider"],
      realtimeVoiceProviderIds: ["indexed-voice-provider"],
      commands: ["indexed-demo"],
      source: fs.realpathSync(fixture.runtimeSource),
      status: "loaded",
    });
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  });

  it("reports package dependency install state without importing plugin runtime", () => {
    const rootDir = makeTempDir();
    const fixture = createColdPluginFixture({
      rootDir,
      pluginId: "dependency-demo",
      packageJson: {
        dependencies: {
          "missing-required": "1.0.0",
          "present-required": "1.0.0",
        },
        optionalDependencies: {
          "missing-optional": "1.0.0",
        },
      },
      manifest: {
        id: "dependency-demo",
        name: "Dependency Demo",
      },
    });
    fs.mkdirSync(path.join(rootDir, "node_modules", "present-required"), { recursive: true });

    const report = buildPluginRegistrySnapshotReport({
      config: {
        plugins: {
          load: { paths: [fixture.rootDir] },
        },
      },
    });

    const plugin = requirePlugin(report.plugins, "dependency-demo");
    const dependencyStatus = requireRecord(plugin.dependencyStatus);
    expectFields(dependencyStatus, {
      hasDependencies: true,
      installed: false,
      requiredInstalled: false,
      optionalInstalled: false,
      missing: ["missing-required"],
      missingOptional: ["missing-optional"],
    });
    const dependencies = requireRecordArray(dependencyStatus.dependencies);
    expect(dependencies).toHaveLength(2);
    expectFields(requireNamedEntry(dependencies, "missing-required"), {
      name: "missing-required",
      spec: "1.0.0",
      installed: false,
      optional: false,
    });
    expectFields(requireNamedEntry(dependencies, "present-required"), {
      name: "present-required",
      spec: "1.0.0",
      installed: true,
      optional: false,
    });
    const optionalDependencies = requireRecordArray(dependencyStatus.optionalDependencies);
    expect(optionalDependencies).toHaveLength(1);
    expectFields(requireNamedEntry(optionalDependencies, "missing-optional"), {
      name: "missing-optional",
      spec: "1.0.0",
      installed: false,
      optional: true,
    });
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  });

  it("replays persisted list metadata without importing plugin runtime", async () => {
    const fixture = createColdPluginFixture({
      rootDir: makeTempDir(),
      pluginId: "persisted-demo",
      packageName: "@example/openclaw-persisted-demo",
      packageVersion: "2.0.0",
      manifest: {
        id: "persisted-demo",
        name: "Persisted Demo",
        description: "Persisted registry metadata",
        providers: ["persisted-provider"],
        commandAliases: [{ name: "persisted-demo" }],
      },
    });
    const workspaceDir = makeTempDir();
    const config = createColdPluginConfig(fixture.rootDir, fixture.pluginId);
    const env = createColdPluginHermeticEnv(workspaceDir, {
      bundledPluginsDir: makeTempDir(),
      disablePersistedRegistry: false,
    });

    await refreshPluginRegistry({
      config,
      workspaceDir,
      env,
      reason: "manual",
    });
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);

    const report = buildPluginRegistrySnapshotReport({
      config,
      workspaceDir,
      env,
    });

    expect(report.registrySource).toBe("persisted");
    expectFields(requirePlugin(report.plugins, "persisted-demo"), {
      id: "persisted-demo",
      name: "Persisted Demo",
      description: "Persisted registry metadata",
      version: "2.0.0",
      providerIds: ["persisted-provider"],
      commands: ["persisted-demo"],
      source: fs.realpathSync(fixture.runtimeSource),
      status: "loaded",
    });
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  });

  it("builds read-only plugin status snapshots without importing plugin runtime", () => {
    const fixture = createColdPluginFixture({
      rootDir: makeTempDir(),
      pluginId: "snapshot-demo",
      manifest: {
        id: "snapshot-demo",
        name: "Snapshot Demo",
        description: "Status metadata",
        providers: ["snapshot-provider"],
      },
      providerId: "snapshot-provider",
      runtimeMessage: "runtime entry should not load for plugin status snapshot report",
    });
    const workspaceDir = makeTempDir();
    const report = buildPluginSnapshotReport({
      config: createColdPluginConfig(fixture.rootDir, fixture.pluginId),
      workspaceDir,
      env: createColdPluginHermeticEnv(workspaceDir, {
        bundledPluginsDir: makeTempDir(),
      }),
    });

    expectFields(requirePlugin(report.plugins, "snapshot-demo"), {
      id: "snapshot-demo",
      name: "Snapshot Demo",
      source: fs.realpathSync(fixture.runtimeSource),
      status: "loaded",
      imported: false,
    });
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  });
});
