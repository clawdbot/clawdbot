import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { computeDeclaredSurfaceHash } from "./capability-consent.js";
import { buildPluginCapabilitySummary } from "./capability-summary.js";
import { configSnapshot, metadataSnapshot } from "./management-service.test-helpers.js";

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
  readConfig: vi.fn(),
  records: {} as Record<string, import("../config/types.plugins.js").PluginInstallRecord>,
  replaceConfig: vi.fn(),
  writeRecords: vi.fn(),
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

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: async () => ({ ...mocks.records }),
  writePersistedInstalledPluginIndexInstallRecordsWithLease: async (
    records: Record<string, import("../config/types.plugins.js").PluginInstallRecord>,
    options: unknown,
  ) => {
    mocks.records = { ...records };
    mocks.writeRecords(records, options);
  },
}));

vi.mock("./plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: async (
    _options: unknown,
    run: (lease: {
      assertOwned: () => void;
      assertOwnedInTransaction: () => void;
      signal: AbortSignal;
      databasePath: string;
    }) => Promise<unknown>,
  ) =>
    run({
      assertOwned: () => undefined,
      assertOwnedInTransaction: () => undefined,
      signal: new AbortController().signal,
      databasePath: "/tmp/managed-capability-consent.sqlite",
    }),
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

const {
  clearManagedPluginOfficialCatalogCache,
  listManagedPlugins,
  resolvePluginCapabilityConsent,
  setManagedPluginEnabled,
} = await import("./management-service.js");

function installRecord(overrides: Partial<PluginInstallRecord> = {}): PluginInstallRecord {
  return {
    source: "npm",
    installPath: "/tmp/community-plugin",
    integrity: "sha512-verified-artifact",
    ...overrides,
  };
}

function configureExternalPlugin(
  record: PluginInstallRecord,
  enabled = false,
): ReturnType<typeof metadataSnapshot> {
  mocks.records = { "community-plugin": record };
  const snapshot = metadataSnapshot({
    id: "community-plugin",
    name: "Community Plugin",
    enabled,
    origin: "global",
    installRecord: record,
  });
  mocks.metadata.mockImplementation(() => ({
    ...snapshot,
    index: { ...snapshot.index, installRecords: { ...mocks.records } },
  }));
  return snapshot;
}

describe("managed plugin capability consent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearManagedPluginOfficialCatalogCache();
    mocks.records = {};
    mocks.officialCatalog.mockResolvedValue({ source: "hosted", entries: [] });
    mocks.readConfig.mockResolvedValue(configSnapshot());
  });

  it("exempts release-bundled plugins from durable capability acceptance", async () => {
    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: false }));

    await expect(
      resolvePluginCapabilityConsent({ config: {}, env: {}, pluginId: "workboard" }),
    ).resolves.toBeUndefined();
    expect(mocks.writeRecords).not.toHaveBeenCalled();
  });

  it("rejects enabling an unaccepted external plugin with its complete consent payload", async () => {
    const snapshot = configureExternalPlugin(installRecord());
    const manifest = snapshot.byPluginId.get("community-plugin")!;
    manifest.providers.push("community-provider");

    await expect(
      setManagedPluginEnabled({ pluginId: "community-plugin", enabled: true, env: {} }),
    ).rejects.toMatchObject({
      capabilityConsent: {
        pluginId: "community-plugin",
        name: "Community Plugin",
        declared: { providers: ["community-provider"] },
        source: { kind: "npm", integrity: "sha512-verified-artifact" },
      },
      message: expect.stringContaining("--accept-capabilities"),
    });
    expect(mocks.replaceConfig).not.toHaveBeenCalled();
  });

  it("persists acknowledged acceptance under the lifecycle lease and reuses it", async () => {
    configureExternalPlugin(installRecord());

    await resolvePluginCapabilityConsent({
      config: {},
      env: {},
      pluginId: "community-plugin",
      acknowledge: true,
    });

    const persisted = mocks.records["community-plugin"]!;
    expect(persisted).toMatchObject({
      acceptedSurfaceHash: expect.stringMatching(/^[a-f\d]{64}$/),
      acceptedSurfaceIntegrity: "sha512-verified-artifact",
      acceptedSurfaceAt: expect.any(String),
    });
    expect(mocks.writeRecords).toHaveBeenCalledWith(
      expect.objectContaining({ "community-plugin": persisted }),
      expect.objectContaining({ config: {}, env: {}, lease: expect.any(Object) }),
    );

    await expect(
      resolvePluginCapabilityConsent({ config: {}, env: {}, pluginId: "community-plugin" }),
    ).resolves.toBeUndefined();
    expect(mocks.writeRecords).toHaveBeenCalledTimes(1);
  });

  it("reports newly declared capabilities when the installed manifest outgrows acceptance", async () => {
    const previous = buildPluginCapabilitySummary({ manifest: {}, origin: "global" }).declared;
    const snapshot = configureExternalPlugin(
      installRecord({
        acceptedSurface: previous,
        acceptedSurfaceHash: computeDeclaredSurfaceHash(previous),
        acceptedSurfaceIntegrity: "sha512-verified-artifact",
        acceptedSurfaceAt: "2026-08-25T00:00:00.000Z",
      }),
    );
    snapshot.byPluginId.get("community-plugin")!.providers.push("new-provider");

    await expect(
      resolvePluginCapabilityConsent({ config: {}, env: {}, pluginId: "community-plugin" }),
    ).rejects.toMatchObject({
      capabilityConsent: {
        widened: { providers: ["new-provider"] },
        acceptedAt: "2026-08-25T00:00:00.000Z",
      },
    });
  });

  it("accepts every child manifest under one authoritative package-owner record", async () => {
    const record = installRecord({ installPath: "/tmp/shared-package" });
    mocks.records = { "shared-package": record };
    const snapshot = metadataSnapshot({
      id: "first-child",
      name: "First Child",
      enabled: false,
      origin: "global",
      installRecord: record,
    });
    const first = snapshot.index.plugins[0]!;
    first.installOwner = "shared-package";
    first.rootDir = "/tmp/shared-package/first";
    const firstManifest = snapshot.byPluginId.get("first-child")!;
    firstManifest.providers.push("first-provider");
    firstManifest.rootDir = first.rootDir;
    const secondManifest = {
      ...firstManifest,
      id: "second-child",
      name: "Second Child",
      providers: ["second-provider"],
      channels: ["second-channel"],
      rootDir: "/tmp/shared-package/second",
    };
    snapshot.index.plugins.push({
      ...first,
      pluginId: "second-child",
      rootDir: secondManifest.rootDir,
    });
    snapshot.byPluginId.set("second-child", secondManifest);
    snapshot.plugins.push(secondManifest);
    mocks.metadata.mockImplementation(() => ({
      ...snapshot,
      index: { ...snapshot.index, installRecords: { ...mocks.records } },
    }));

    await resolvePluginCapabilityConsent({
      config: {},
      env: {},
      pluginId: "first-child",
      acknowledge: true,
    });

    expect(mocks.records["shared-package"]?.acceptedSurface).toMatchObject({
      providers: ["first-provider", "second-provider"],
      channels: ["second-channel"],
    });
    await expect(
      resolvePluginCapabilityConsent({ config: {}, env: {}, pluginId: "second-child" }),
    ).resolves.toBeUndefined();
    expect(mocks.writeRecords).toHaveBeenCalledTimes(1);
  });

  it("warns when config directly enables a tracked plugin without current acceptance", async () => {
    configureExternalPlugin(installRecord(), true);

    const catalog = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });

    expect(catalog.diagnostics).toContainEqual({
      level: "warn",
      pluginId: "community-plugin",
      message: expect.stringContaining(
        "openclaw plugins enable community-plugin --accept-capabilities",
      ),
    });
  });
});
