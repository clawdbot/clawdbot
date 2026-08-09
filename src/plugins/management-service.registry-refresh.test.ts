import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clawhubInstall: vi.fn(),
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
  persistInstall: vi.fn(),
  readConfig: vi.fn(),
  refreshRegistry: vi.fn(),
  replaceConfig: vi.fn(),
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

vi.mock("./plugin-metadata-snapshot.js", () => ({
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
  setManagedPluginEnabled,
} = await import("./management-service.js");

const installSnapshot = {
  config: {},
  baseHash: "base-hash",
  writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
};

function mockClawHubWorkboardInstall() {
  mocks.clawhubInstall.mockResolvedValue({
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
  });
}

function metadataSnapshot(enabled: boolean) {
  const manifest = {
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
  };
  return {
    index: {
      plugins: [
        { pluginId: "workboard", packageName: "@openclaw/workboard", origin: "bundled", enabled },
      ],
      installRecords: {},
    },
    byPluginId: new Map([["workboard", manifest]]),
    plugins: [manifest],
    diagnostics: [],
    normalizePluginId: (pluginId: string) => pluginId,
  };
}

describe("plugin management registry refresh", () => {
  beforeEach(() => {
    clearManagedPluginOfficialCatalogCache();
    vi.resetAllMocks();
    mocks.officialCatalog.mockResolvedValue({ source: "hosted", entries: [] });
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
    mocks.metadata.mockReturnValue(metadataSnapshot(false));

    const result = await installManagedPlugin({
      request: { source: "clawhub", packageName: "community/workboard" },
      env: {},
    });

    expect(result).toMatchObject({
      plugin: { id: "workboard", enabled: false },
      warnings: [instruction],
    });
  });

  it("does not forward source-install loggers into private persistence warnings", async () => {
    mockClawHubWorkboardInstall();
    mocks.persistInstall.mockResolvedValue({});
    const logger = { warn: vi.fn() };

    await installManagedPluginSource({
      request: { source: "clawhub", spec: "clawhub:community/workboard" },
      snapshot: installSnapshot,
      env: {},
      logger,
    });

    expect(mocks.clawhubInstall).toHaveBeenCalledWith(expect.objectContaining({ logger }));
    expect(mocks.persistInstall.mock.calls[0]?.[0]).not.toHaveProperty("persistenceLogger");
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
