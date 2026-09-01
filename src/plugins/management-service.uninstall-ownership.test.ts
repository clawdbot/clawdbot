import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { recordPluginManifestInstallOwner } from "./manifest-install-owner.js";
import { resolvePluginPackageUninstallPlan } from "./uninstall-package-plan.js";

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

const { listManagedPlugins, uninstallManagedPlugin } = await import("./management-service.js");
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
      const manifest = recordPluginManifestInstallOwner(
        { id: pluginId, channels: channelIds },
        pluginId,
      );
      mocks.metadata.mockReturnValue({
        index: {
          plugins: [
            recordInstalledPluginIndexInstallOwner(
              { pluginId, origin: "global", enabled, rootDir: installPath },
              pluginId,
            ),
          ],
          installRecords: { [pluginId]: installRecord },
        },
        byPluginId: new Map([[pluginId, manifest]]),
        normalizePluginId: (rawPluginId: string) => rawPluginId,
      });

      const result = await uninstallManagedPlugin({ pluginId, env: {} });

      const ownedChannelIds = channelIds;
      expect(planPluginUninstall).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId,
          channelIds,
        }),
      );
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

  it("fails closed when an owner record has no authoritative child metadata", async () => {
    const pluginId = "custom-plugin";
    const installPath = "/tmp/openclaw-managed-missing-children";
    const installRecord = { source: "path", sourcePath: installPath, installPath } as const;
    mocks.readConfig.mockResolvedValue({
      snapshot: {
        valid: true,
        parsed: {},
        path: "/tmp/openclaw.json",
        sourceConfig: { plugins: { entries: { [pluginId]: { enabled: true } } } },
        hash: "base-hash",
      },
      writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
    });
    mocks.installRecords.mockResolvedValue({ [pluginId]: installRecord });
    mocks.metadata.mockReturnValue({
      index: {
        plugins: [{ pluginId, origin: "global", enabled: true, rootDir: installPath }],
        installRecords: { [pluginId]: installRecord },
      },
      byPluginId: new Map(),
      normalizePluginId: (rawPluginId: string) => rawPluginId,
    });

    await expect(uninstallManagedPlugin({ pluginId, env: {} })).rejects.toThrow(
      "no authoritative package-owner metadata",
    );
    expect(mocks.commitRecords).not.toHaveBeenCalled();
  });

  it("fails closed when an orphan record path overlaps a discovered plugin", async () => {
    const pluginId = "orphaned-plugin";
    const installPath = "/tmp/openclaw-managed-conflicting-orphan";
    const installRecord = { source: "path", sourcePath: installPath, installPath } as const;
    mocks.readConfig.mockResolvedValue({
      snapshot: {
        valid: true,
        parsed: {},
        path: "/tmp/openclaw.json",
        sourceConfig: {},
        hash: "base-hash",
      },
      writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
    });
    mocks.installRecords.mockResolvedValue({ [pluginId]: installRecord });
    mocks.metadata.mockReturnValue({
      index: {
        plugins: [
          recordInstalledPluginIndexInstallOwner(
            { pluginId: "other", origin: "global", enabled: true, rootDir: installPath },
            "other",
          ),
        ],
        installRecords: { [pluginId]: installRecord },
      },
      byPluginId: new Map(),
      normalizePluginId: (rawPluginId: string) => rawPluginId,
    });

    await expect(uninstallManagedPlugin({ pluginId, env: {} })).rejects.toThrow(
      "no authoritative runtime child list",
    );
    expect(mocks.commitRecords).not.toHaveBeenCalled();
  });

  it("removes an exact orphan owner record with no discovered plugin code", async () => {
    const pluginId = "orphaned-plugin";
    const installRecord = {
      source: "path",
      sourcePath: "/tmp/missing-orphan-source",
      installPath: "/tmp/missing-orphan-install",
    } as const;
    mocks.readConfig.mockResolvedValue({
      snapshot: {
        valid: true,
        parsed: {},
        path: "/tmp/openclaw.json",
        sourceConfig: { plugins: { entries: { [pluginId]: { enabled: true } } } },
        hash: "base-hash",
      },
      writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
    });
    mocks.installRecords.mockResolvedValue({ [pluginId]: installRecord });
    mocks.metadata.mockReturnValue({
      index: {
        plugins: [],
        installRecords: { [pluginId]: installRecord },
      },
      byPluginId: new Map(),
      normalizePluginId: (rawPluginId: string) => rawPluginId,
    });

    const result = await uninstallManagedPlugin({ pluginId, env: {} });

    expect(mocks.commitRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: {},
        nextInstallRecords: {},
      }),
    );
    expect(result.pluginId).toBe(pluginId);
    expect(result.removed).toContain("install record");
  });

  it("resolves a child request to one package owner and removes every sibling policy", async () => {
    const installPath = "/tmp/openclaw-managed-linked-pack";
    const installRecord = { source: "path", sourcePath: installPath, installPath } as const;
    mocks.readConfig.mockResolvedValue({
      snapshot: {
        valid: true,
        parsed: {},
        path: "/tmp/openclaw.json",
        sourceConfig: {
          plugins: {
            allow: ["pack/one", "pack/two", "other"],
            entries: {
              "pack/one": { enabled: true },
              "pack/two": { enabled: false },
              other: { enabled: true },
            },
          },
        },
        hash: "pack-hash",
      },
      writeOptions: { expectedConfigPath: "/tmp/openclaw.json" },
    });
    mocks.installRecords.mockResolvedValue({ pack: installRecord });
    const manifests: Array<[string, { id: string; channels: string[] }]> = [
      ["pack/one", recordPluginManifestInstallOwner({ id: "pack/one", channels: [] }, "pack")],
      ["pack/two", recordPluginManifestInstallOwner({ id: "pack/two", channels: [] }, "pack")],
    ];
    mocks.metadata.mockReturnValue({
      index: {
        plugins: [
          recordInstalledPluginIndexInstallOwner(
            {
              pluginId: "pack/one",
              origin: "global",
              enabled: true,
              rootDir: installPath,
            },
            "pack",
          ),
          recordInstalledPluginIndexInstallOwner(
            {
              pluginId: "pack/two",
              origin: "global",
              enabled: false,
              rootDir: installPath,
            },
            "pack",
          ),
        ],
        installRecords: { pack: installRecord },
      },
      byPluginId: new Map(manifests),
      normalizePluginId: (pluginId: string) => pluginId,
    });

    const result = await uninstallManagedPlugin({ pluginId: "pack/two", env: {} });

    expect(planPluginUninstall).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "pack",
      }),
    );
    expect(
      resolvePluginPackageUninstallPlan(vi.mocked(planPluginUninstall).mock.calls[0]![0]),
    ).toEqual({
      runtimePluginIds: ["pack/one", "pack/two"],
      runtimeLoadPaths: [],
    });
    expect(mocks.commitRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        nextInstallRecords: {},
        nextConfig: {
          plugins: {
            allow: ["other"],
            entries: { other: { enabled: true } },
          },
        },
      }),
    );
    expect(result.pluginId).toBe("pack");
    expect(result.warnings).toContain(
      'Uninstalled package "pack" and all owned plugin entries: pack/one, pack/two.',
    );
  });

  it("marks every child removable through its package install owner", async () => {
    const installRecord = {
      source: "path",
      sourcePath: "/tmp/pack",
      installPath: "/tmp/pack",
    };
    const manifests = ["pack/one", "pack/two"].map((id) => ({
      id,
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      origin: "global",
      rootDir: "/tmp/pack",
      source: `/tmp/pack/${id.endsWith("one") ? "one" : "two"}.js`,
      manifestPath: "/tmp/pack/openclaw.plugin.json",
    }));
    mocks.metadata.mockReturnValue({
      index: {
        plugins: manifests.map((manifest, index) =>
          recordInstalledPluginIndexInstallOwner(
            {
              pluginId: manifest.id,
              packageName: "@acme/pack",
              origin: "global",
              enabled: index === 0,
              rootDir: "/tmp/pack",
            },
            "pack",
          ),
        ),
        installRecords: { pack: installRecord },
      },
      byPluginId: new Map(manifests.map((manifest) => [manifest.id, manifest])),
      diagnostics: [],
      normalizePluginId: (pluginId: string) => pluginId,
    });

    const catalog = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });

    expect(catalog.plugins.map(({ id, removable }) => ({ id, removable }))).toEqual([
      { id: "pack/one", removable: true },
      { id: "pack/two", removable: true },
    ]);
  });
});
