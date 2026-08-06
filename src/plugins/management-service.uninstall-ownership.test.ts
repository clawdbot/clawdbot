import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  commitRecords: vi.fn(),
  installRecords: vi.fn(),
  metadata: vi.fn(),
  readConfig: vi.fn(),
  refreshRegistry: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: () => undefined,
  readConfigFileSnapshotForWrite: () => mocks.readConfig(),
  replaceConfigFile: vi.fn(),
}));

vi.mock("./install-persistence.js", () => ({
  persistPluginInstall: vi.fn(),
  resolveInstallConfigMutationPreflights: () => ({
    hookMutation: { mode: "allowed" },
    pluginMutation: { mode: "allowed" },
  }),
  selectInstallMutationWriteOptions: (writeOptions: unknown) => writeOptions,
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: (...args: unknown[]) => mocks.installRecords(...args),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
  resolvePluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
}));

vi.mock("./install-record-commit.js", () => ({
  commitPluginInstallRecordsWithConfig: (...args: unknown[]) => mocks.commitRecords(...args),
}));

vi.mock("./registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: (...args: unknown[]) => mocks.refreshRegistry(...args),
}));

vi.mock("./uninstall.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./uninstall.js")>();
  return { ...original, planPluginUninstall: vi.fn(original.planPluginUninstall) };
});

const { uninstallManagedPlugin } = await import("./management-service.js");
const { planPluginUninstall } = await import("./uninstall.js");

describe("plugin management uninstall channel ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { label: "a disabled non-channel plugin", enabled: false, channelIds: [] },
    { label: "an enabled non-channel plugin", enabled: true, channelIds: [] },
    {
      label: "a disabled channel plugin",
      enabled: false,
      channelIds: ["owned-channel", "owned-channel-backup"],
    },
    { label: "an enabled channel plugin", enabled: true, channelIds: ["owned-channel"] },
    { label: "a plugin with unavailable manifest metadata", enabled: false, channelIds: undefined },
  ])(
    "preserves manifest channel ownership when uninstalling $label",
    async ({ enabled, channelIds }) => {
      const pluginId = "custom-plugin";
      const installPath = "/tmp/openclaw-managed-linked-custom-plugin";
      const installRecord = { source: "path", sourcePath: installPath, installPath } as const;
      const channels = {
        [pluginId]: { enabled: true },
        "owned-channel": { enabled: true },
        "owned-channel-backup": { enabled: true },
        discord: { enabled: true },
      };
      mocks.readConfig.mockResolvedValue({
        snapshot: {
          valid: true,
          parsed: {},
          path: "/tmp/openclaw.json",
          sourceConfig: { plugins: { entries: { [pluginId]: { enabled } } }, channels },
          hash: "base-hash",
        },
        writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
      });
      mocks.installRecords.mockResolvedValue({ [pluginId]: installRecord });
      const manifest =
        channelIds === undefined ? undefined : { id: pluginId, channels: channelIds };
      mocks.metadata.mockReturnValue({
        index: {
          plugins: manifest ? [{ pluginId, origin: "global", enabled }] : [],
          installRecords: { [pluginId]: installRecord },
        },
        byPluginId: new Map(manifest ? [[pluginId, manifest]] : []),
        normalizePluginId: (rawPluginId: string) => rawPluginId,
      });

      const result = await uninstallManagedPlugin({ pluginId, env: {} });

      const ownedChannelIds = channelIds ?? [pluginId];
      expect(planPluginUninstall).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId,
          ...(channelIds === undefined ? {} : { channelIds }),
        }),
      );
      if (channelIds === undefined) {
        expect(vi.mocked(planPluginUninstall).mock.calls[0]?.[0]).not.toHaveProperty("channelIds");
      }
      expect(mocks.commitRecords).toHaveBeenCalledWith(
        expect.objectContaining({
          nextConfig: expect.objectContaining({
            channels: Object.fromEntries(
              Object.entries(channels).filter(
                ([channelId]) => !ownedChannelIds.includes(channelId),
              ),
            ),
          }),
          nextInstallRecords: {},
        }),
      );
      expect(result.removed).toEqual([
        "config entry",
        "install record",
        ...(ownedChannelIds.length > 0 ? ["channel config"] : []),
      ]);
    },
  );
});
