import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPluginCapabilitySummary, computeDeclaredSurfaceHash } from "./capability-summary.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { configSnapshot } from "./management-service.test-helpers.js";
import { recordPluginManifestInstallOwner } from "./manifest-install-owner.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const mocks = vi.hoisted(() => ({
  clawhubInstall: vi.fn(),
  gatewayMetadata: vi.fn(),
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
  persistInstall: vi.fn<typeof import("./install-persistence.js").persistPluginInstall>(),
  readConfig: vi.fn(),
  refreshRegistry: vi.fn(),
  replaceConfig: vi.fn(),
}));

vi.mock("./current-plugin-metadata-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./current-plugin-metadata-state.js")>()),
  getProcessGatewayPluginMetadataSnapshot: () => mocks.gatewayMetadata(),
}));

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: () => undefined,
  readConfigFileSnapshotForWrite: () => mocks.readConfig(),
  replaceConfigFile: (params: unknown) => mocks.replaceConfig(params),
}));

vi.mock("./install-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install-persistence.js")>()),
  persistPluginInstall: mocks.persistInstall,
  resolveInstallConfigMutationPreflights: () => ({
    hookMutation: { mode: "allowed" },
    pluginMutation: { mode: "allowed" },
  }),
  selectInstallMutationWriteOptions: (writeOptions: unknown) => writeOptions,
}));

vi.mock("./clawhub.js", () => ({
  installPluginFromClawHub: (params: unknown) => mocks.clawhubInstall(params),
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: async () => ({}),
}));

vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
  resolvePluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
    mocks.officialCatalog(...args),
}));

vi.mock("./registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: (...args: unknown[]) => mocks.refreshRegistry(...args),
}));

vi.mock("./slot-selection.js", () => ({
  applySlotSelectionForPlugin: (config: unknown) => ({ config, warnings: [] }),
}));

const { clearManagedPluginOfficialCatalogCache } = await import("./management-catalog.js");
const { installManagedPlugin, setManagedPluginEnabled } = await import("./management-mutations.js");
const { inspectManagedPlugin, listManagedPlugins } = await import("./management-service.js");

const installSnapshot = {
  config: {},
  baseHash: "base-hash",
  writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
};

const trackedArtifactDirs: string[] = [];
const emptyArtifactAcknowledgment = {
  reviewToken: computeDeclaredSurfaceHash(
    buildPluginCapabilitySummary({ manifest: {}, origin: "global" }).declared,
  ),
};

function mockClawHubWorkboardInstall(sourceWarning?: string) {
  mocks.clawhubInstall.mockImplementation(
    async (params: {
      logger?: { warn?: (message: string) => void };
      onBeforePluginArtifactCommit?: (request: {
        pluginId: string;
        stagedArtifactDir: string;
        mode: "install";
      }) => Promise<void>;
    }) => {
      if (sourceWarning) {
        params.logger?.warn?.(sourceWarning);
      }
      const artifactDir = makeTrackedTempDir("managed-registry-consent", trackedArtifactDirs);
      createColdPluginFixture({
        rootDir: artifactDir,
        pluginId: "workboard",
        manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] },
      });
      await params.onBeforePluginArtifactCommit?.({
        pluginId: "workboard",
        stagedArtifactDir: artifactDir,
        mode: "install",
      });
      return {
        ok: true,
        pluginId: "workboard",
        targetDir: "/tmp/workboard",
        extensions: ["index.js"],
        packageName: "community/workboard",
        clawhub: {
          source: "clawhub",
          clawhubUrl: "https://clawhub.ai",
          clawhubPackage: "community/workboard",
          clawhubFamily: "code-plugin",
        },
      };
    },
  );
}

function metadataSnapshot(enabled: boolean, installed = false) {
  const installOwner = installed ? "workboard" : undefined;
  const manifest = recordPluginManifestInstallOwner(
    {
      id: "workboard",
      name: "Workboard",
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      origin: "bundled",
      rootDir: "/tmp/workboard",
      source: "/tmp/workboard/index.ts",
      manifestPath: "/tmp/workboard/openclaw.plugin.json",
    },
    installOwner,
  );
  return {
    index: {
      plugins: [
        recordInstalledPluginIndexInstallOwner(
          {
            pluginId: "workboard",
            packageName: "@openclaw/workboard",
            origin: "bundled",
            rootDir: "/tmp/workboard",
            enabled,
          },
          installOwner,
        ),
      ],
      installRecords: installed
        ? {
            workboard: {
              source: "clawhub",
              spec: "clawhub:community/workboard",
              installPath: "/tmp/workboard",
            },
          }
        : {},
    },
    manifestRegistry: { plugins: [manifest], diagnostics: [] },
    byPluginId: new Map([["workboard", manifest]]),
    plugins: [manifest],
    diagnostics: [],
    normalizePluginId: (pluginId: string) => pluginId,
  };
}

describe("plugin management registry refresh", () => {
  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
    cleanupTrackedTempDirs(trackedArtifactDirs);
  });

  beforeEach(() => {
    clearManagedPluginOfficialCatalogCache();
    vi.resetAllMocks();
    mocks.officialCatalog.mockResolvedValue({ source: "hosted", entries: [] });
  });

  it("returns the installed candidate without replacing the running Gateway inventory", async () => {
    mockClawHubWorkboardInstall();
    mocks.readConfig.mockResolvedValue({
      snapshot: {
        valid: true,
        parsed: {},
        path: "/tmp/openclaw.json",
        sourceConfig: {},
        hash: "base-hash",
      },
      writeOptions: installSnapshot.writeOptions,
    });
    mocks.persistInstall.mockResolvedValue({
      config: { plugins: { entries: { workboard: { enabled: false } } } },
      warnings: [],
    });
    const boot = {
      ...metadataSnapshot(false),
      index: { plugins: [], installRecords: {} },
      manifestRegistry: { plugins: [], diagnostics: [] },
      plugins: [],
      byPluginId: new Map(),
    };
    mocks.gatewayMetadata.mockReturnValue(boot);
    mocks.metadata.mockImplementation((params: { allowCurrent?: boolean }) =>
      params.allowCurrent === false ? metadataSnapshot(false, true) : boot,
    );

    const result = await installManagedPlugin({
      request: {
        source: "clawhub",
        packageName: "community/workboard",
        acknowledgeCapabilities: emptyArtifactAcknowledgment,
      },
      env: {},
    });

    expect(result.plugin).toMatchObject({ id: "workboard", installed: true, enabled: false });
    mocks.metadata.mockClear();
    expect((await listManagedPlugins({ config: {}, env: {} })).plugins).toEqual([
      expect.objectContaining({ id: "workboard", installed: true, enabled: false }),
    ]);
    expect(
      (await inspectManagedPlugin({ config: {}, pluginId: "workboard", env: {} })).plugin,
    ).toMatchObject({ id: "workboard", installed: true });
    expect(mocks.metadata).not.toHaveBeenCalled();
    expect(mocks.gatewayMetadata()).toBe(boot);

    mocks.gatewayMetadata.mockReturnValue({ ...boot });
    expect((await listManagedPlugins({ config: {}, env: {} })).plugins).toEqual([]);
  });

  it.each([true, false])(
    "reports registry refresh warnings after a committed enabled=%s mutation",
    async (enabled) => {
      mocks.readConfig.mockResolvedValue({
        snapshot: {
          valid: true,
          parsed: {},
          path: "/tmp/openclaw.json",
          sourceConfig: { plugins: { entries: { workboard: { enabled: !enabled } } } },
          hash: "base-hash",
        },
        writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
      });
      mocks.replaceConfig.mockResolvedValue({});
      mocks.metadata
        .mockReturnValueOnce(metadataSnapshot(!enabled))
        .mockReturnValueOnce(metadataSnapshot(enabled));
      mocks.refreshRegistry.mockImplementation(
        async (params: { logger?: { warn?: (message: string) => void } }) => {
          params.logger?.warn?.("Plugin registry refresh failed: registry unavailable");
        },
      );

      const result = await setManagedPluginEnabled({ pluginId: "workboard", enabled, env: {} });

      expect(mocks.replaceConfig).toHaveBeenCalledOnce();
      expect(result.plugin.enabled).toBe(enabled);
      expect(result.warnings).toEqual(["Plugin registry refresh failed: registry unavailable"]);
    },
  );

  it("returns setup instructions after an administrative plugin installs disabled", async () => {
    const instruction =
      'Installed plugin "workboard" without enabling it because it requires configuration first.';
    mockClawHubWorkboardInstall();
    mocks.readConfig.mockResolvedValue({
      snapshot: {
        valid: true,
        parsed: {},
        path: "/tmp/openclaw.json",
        sourceConfig: {},
        hash: "base-hash",
      },
      writeOptions: installSnapshot.writeOptions,
    });
    mocks.persistInstall.mockResolvedValue({
      config: { plugins: { entries: { workboard: { enabled: false } } } },
      warnings: [instruction],
    });
    mocks.metadata.mockReturnValue(metadataSnapshot(false, true));

    const result = await installManagedPlugin({
      request: {
        source: "clawhub",
        packageName: "community/workboard",
        acknowledgeCapabilities: emptyArtifactAcknowledgment,
      },
      env: {},
    });

    expect(result).toMatchObject({
      plugin: { id: "workboard", enabled: false },
      warnings: [instruction],
    });
  });

  it("keeps an ownerless managed install and returns the partial-scope action", async () => {
    const config = {
      agents: {
        ownership: "explicit" as const,
        entries: {
          main: { workspace: "/tmp/main-workspace" },
          gadget: { workspace: "/tmp/gadget-workspace" },
        },
      },
    };
    mockClawHubWorkboardInstall();
    mocks.readConfig.mockResolvedValue({
      snapshot: {
        valid: true,
        parsed: config,
        path: "/tmp/openclaw.json",
        sourceConfig: config,
        hash: "base-hash",
      },
      writeOptions: installSnapshot.writeOptions,
    });
    mocks.persistInstall.mockResolvedValue({ config, warnings: [] });
    mocks.metadata.mockReturnValue(metadataSnapshot(false, true));

    const result = await installManagedPlugin({
      request: {
        source: "clawhub",
        packageName: "community/workboard",
        acknowledgeCapabilities: emptyArtifactAcknowledgment,
      },
      env: {},
    });

    expect(result.plugin.id).toBe("workboard");
    expect(result.warnings).toContainEqual(
      expect.stringContaining("set agents.defaults.systemAgent.agentId"),
    );
  });

  it("returns persistence warnings without forwarding them to source-install loggers", async () => {
    const sourceWarning = "Source install completed with a package warning.";
    mockClawHubWorkboardInstall(sourceWarning);
    const instruction =
      'Installed plugin "workboard" without enabling it because it requires configuration first.';
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.persistInstall.mockResolvedValue({ config: {}, warnings: [instruction] });
    mocks.metadata.mockReturnValue(metadataSnapshot(false, true));
    const logger = { warn: vi.fn() };

    const result = await installManagedPlugin({
      request: {
        source: "clawhub",
        packageName: "community/workboard",
        acknowledgeCapabilities: emptyArtifactAcknowledgment,
      },
      env: {},
      logger,
    });

    expect(mocks.clawhubInstall).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      plugin: { id: "workboard", installed: true },
      warnings: [sourceWarning, instruction],
    });
  });

  it("requires artifact consent before a linked source is enabled or recorded", async () => {
    const artifactDir = makeTrackedTempDir("managed-linked-consent", trackedArtifactDirs);
    const stateDir = makeTrackedTempDir("managed-linked-state", trackedArtifactDirs);
    createColdPluginFixture({
      rootDir: artifactDir,
      pluginId: "linked-plugin",
      manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] },
    });
    const params = {
      request: {
        source: "local" as const,
        path: artifactDir,
        mode: "install" as const,
        link: true,
      },
      env: { OPENCLAW_STATE_DIR: stateDir },
    };

    mocks.readConfig.mockResolvedValue(configSnapshot());
    await expect(installManagedPlugin(params)).rejects.toMatchObject({
      capabilityConsent: {
        pluginId: "linked-plugin",
        reviewToken: emptyArtifactAcknowledgment.reviewToken,
      },
    });
    expect(mocks.persistInstall).not.toHaveBeenCalled();

    mocks.persistInstall.mockResolvedValue({ config: {}, warnings: [] });
    const { loadPluginMetadataSnapshot } = await vi.importActual<
      typeof import("./plugin-metadata-snapshot.js")
    >("./plugin-metadata-snapshot.js");
    mocks.metadata.mockImplementation((request: Parameters<typeof loadPluginMetadataSnapshot>[0]) =>
      loadPluginMetadataSnapshot({
        ...request,
        index: loadInstalledPluginIndex({
          config: request.config,
          env: request.env,
          installRecords: {
            "linked-plugin": {
              source: "path",
              installPath: artifactDir,
              sourcePath: artifactDir,
            },
          },
        }),
      }),
    );
    const result = await installManagedPlugin({
      ...params,
      request: { ...params.request, acknowledgeCapabilities: emptyArtifactAcknowledgment },
    });

    expect(result.plugin).toMatchObject({ id: "linked-plugin", installed: true });
    expect(mocks.persistInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        install: expect.objectContaining({
          installPath: artifactDir,
          acceptedSurfaceHash: emptyArtifactAcknowledgment.reviewToken,
        }),
        snapshot: expect.objectContaining({
          config: expect.objectContaining({
            plugins: expect.objectContaining({ load: { paths: [artifactDir] } }),
          }),
        }),
      }),
    );
  });
});
