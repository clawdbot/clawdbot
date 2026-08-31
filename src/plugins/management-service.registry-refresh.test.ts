import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPluginCapabilitySummary, computeDeclaredSurfaceHash } from "./capability-summary.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { recordPluginManifestInstallOwner } from "./manifest-install-owner.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const mocks = vi.hoisted(() => ({
  clawhubInstall: vi.fn(),
  gatewayMetadata: vi.fn(),
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
  persistInstall: vi.fn(),
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
  persistPluginInstall: (params: unknown) => mocks.persistInstall(params),
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

const {
  clearManagedPluginOfficialCatalogCache,
  installManagedPlugin,
  installManagedPluginSource,
  inspectManagedPlugin,
  listManagedPlugins,
  setManagedPluginEnabled,
} = await import("./management-service.js");

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

function mockClawHubWorkboardInstall() {
  mocks.clawhubInstall.mockImplementation(
    async (params: {
      onBeforePluginArtifactCommit?: (request: {
        pluginId: string;
        stagedArtifactDir: string;
        mode: "install";
      }) => Promise<void>;
    }) => {
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
      plugins: { entries: { workboard: { enabled: false } } },
    });
    const boot = {
      ...metadataSnapshot(false),
      index: { plugins: [], installRecords: {} },
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
    mocks.persistInstall.mockImplementation(
      async (params: {
        persistenceLogger?: { warn?: (message: string) => void };
        runtime?: { log?: (message: string) => void };
      }) => {
        params.persistenceLogger?.warn?.(instruction);
        params.runtime?.log?.("Installed plugin: workboard");
        params.runtime?.log?.("Restart the gateway to load plugins.");
        return { plugins: { entries: { workboard: { enabled: false } } } };
      },
    );
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
    mocks.persistInstall.mockResolvedValue(config);
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
    mockClawHubWorkboardInstall();
    const instruction =
      'Installed plugin "workboard" without enabling it because it requires configuration first.';
    mocks.persistInstall.mockImplementation(
      async (params: { persistenceLogger?: { warn?: (message: string) => void } }) => {
        params.persistenceLogger?.warn?.(instruction);
        return {};
      },
    );
    const logger = { warn: vi.fn() };

    const result = await installManagedPluginSource({
      request: { source: "clawhub", spec: "clawhub:community/workboard" },
      snapshot: installSnapshot,
      env: {},
      logger,
      acknowledgeCapabilities: emptyArtifactAcknowledgment,
    });

    expect(mocks.clawhubInstall).toHaveBeenCalledWith(expect.objectContaining({ logger }));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, warnings: [instruction] });
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
        recordSource: "path" as const,
        mode: "install" as const,
        link: true,
      },
      snapshot: installSnapshot,
      env: { OPENCLAW_STATE_DIR: stateDir },
    };

    await expect(installManagedPluginSource(params)).rejects.toMatchObject({
      capabilityConsent: {
        pluginId: "linked-plugin",
        reviewToken: emptyArtifactAcknowledgment.reviewToken,
      },
    });
    expect(mocks.persistInstall).not.toHaveBeenCalled();

    mocks.persistInstall.mockResolvedValue({});
    const result = await installManagedPluginSource({
      ...params,
      acknowledgeCapabilities: emptyArtifactAcknowledgment,
    });

    expect(result.ok).toBe(true);
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
