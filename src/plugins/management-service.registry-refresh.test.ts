import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
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
  resolveInstallConfigMutationPreflights: () => ({
    hookMutation: { mode: "allowed" },
    pluginMutation: { mode: "allowed" },
  }),
  selectInstallMutationWriteOptions: (writeOptions: unknown) => writeOptions,
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

const { clearManagedPluginOfficialCatalogCache, setManagedPluginEnabled } =
  await import("./management-service.js");

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
});
