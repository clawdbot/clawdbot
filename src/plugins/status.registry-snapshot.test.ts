import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { refreshPluginRegistry } from "./plugin-registry.js";
import { buildPluginRegistrySnapshotReport, buildPluginSnapshotReport } from "./status.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
  createColdPluginHermeticEnv,
  isColdPluginRuntimeLoaded,
} from "./test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-status", tempDirs);
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("buildPluginRegistrySnapshotReport", () => {
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

    const plugin = report.plugins.find((entry) => entry.id === "indexed-demo");
    expect(plugin).toMatchObject({
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

    const plugin = report.plugins.find((entry) => entry.id === "dependency-demo");
    expect(plugin?.dependencyStatus).toMatchObject({
      hasDependencies: true,
      installed: false,
      requiredInstalled: false,
      optionalInstalled: false,
      missing: ["missing-required"],
      missingOptional: ["missing-optional"],
      dependencies: [
        {
          name: "missing-required",
          spec: "1.0.0",
          installed: false,
          optional: false,
        },
        {
          name: "present-required",
          spec: "1.0.0",
          installed: true,
          optional: false,
        },
      ],
      optionalDependencies: [
        {
          name: "missing-optional",
          spec: "1.0.0",
          installed: false,
          optional: true,
        },
      ],
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
    expect(report.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "persisted-demo",
          name: "Persisted Demo",
          description: "Persisted registry metadata",
          version: "2.0.0",
          providerIds: ["persisted-provider"],
          commands: ["persisted-demo"],
          source: fs.realpathSync(fixture.runtimeSource),
          status: "loaded",
        }),
      ]),
    );
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

    expect(report.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "snapshot-demo",
          name: "Snapshot Demo",
          source: fs.realpathSync(fixture.runtimeSource),
          status: "loaded",
          imported: false,
        }),
      ]),
    );
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  });
});
