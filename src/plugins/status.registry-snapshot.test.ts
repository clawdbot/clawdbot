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

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-status", tempDirs);
}

function writeManagedNpmPlugin(params: {
  stateDir: string;
  packageName: string;
  pluginId: string;
  version: string;
  dependencySpec?: string;
}): string {
  const npmRoot = path.join(params.stateDir, "npm");
  const rootManifestPath = path.join(npmRoot, "package.json");
  fs.mkdirSync(npmRoot, { recursive: true });
  const rootManifest = fs.existsSync(rootManifestPath)
    ? (JSON.parse(fs.readFileSync(rootManifestPath, "utf8")) as {
        dependencies?: Record<string, string>;
      })
    : {};
  fs.writeFileSync(
    rootManifestPath,
    JSON.stringify(
      {
        ...rootManifest,
        private: true,
        dependencies: {
          ...rootManifest.dependencies,
          [params.packageName]: params.dependencySpec ?? params.version,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const packageDir = path.join(npmRoot, "node_modules", params.packageName);
  fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: params.packageName,
      version: params.version,
      openclaw: { extensions: ["./dist/index.js"] },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(packageDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.pluginId,
      name: "WhatsApp",
      configSchema: { type: "object" },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(packageDir, "dist", "index.js"), "export {};\n", "utf8");
  return packageDir;
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

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
    });
    const staleIndex = loadInstalledPluginIndex({
      config,
      env,
      installRecords: {},
    });
    expect(staleIndex.plugins.some((plugin) => plugin.pluginId === "whatsapp")).toBe(false);
    writePersistedInstalledPluginIndexSync(staleIndex, { stateDir });

    const report = buildPluginRegistrySnapshotReport({
      config,
      env,
    });

    expect(report.registrySource).toBe("derived");
    expect(report.registryDiagnostics).toContainEqual(
      expect.objectContaining({ code: "persisted-registry-stale-source" }),
    );
    expect(report.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "whatsapp",
          name: "WhatsApp",
          source: fs.realpathSync(path.join(whatsappDir, "dist", "index.js")),
          status: "loaded",
        }),
      ]),
    );
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
