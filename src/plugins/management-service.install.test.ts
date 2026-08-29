import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPluginCapabilitySummary, computeDeclaredSurfaceHash } from "./capability-summary.js";
import {
  configSnapshot,
  hostedFeedDiffsEntry,
  metadataSnapshot,
} from "./management-service.test-helpers.js";
import { invokePluginArtifactInstallMock } from "./test-helpers/install-fixtures.js";

const mocks = vi.hoisted(() => ({
  clawhubInstall: vi.fn(),
  installRecords: vi.fn(),
  metadata: vi.fn(),
  npmInstall: vi.fn(),
  officialCatalog: vi.fn(),
  persistInstall: vi.fn(),
  preflight: vi.fn(),
  readConfig: vi.fn(),
  refreshRegistry: vi.fn(),
  replaceConfig: vi.fn(),
  selectWriteOptions: vi.fn((writeOptions: unknown) => writeOptions),
  slotSelection: vi.fn((config: unknown): { config: unknown; warnings: string[] } => ({
    config,
    warnings: [],
  })),
}));

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: (params?: { env?: NodeJS.ProcessEnv }) => {
    if (params?.env?.OPENCLAW_NIX_MODE === "1") {
      throw new Error("Config is managed by Nix");
    }
  },
  readConfigFileSnapshotForWrite: () => mocks.readConfig(),
  replaceConfigFile: (params: unknown) => mocks.replaceConfig(params),
}));

vi.mock("./install-persistence.js", () => ({
  persistPluginInstall: (...args: unknown[]) => mocks.persistInstall(...args),
  resolveInstallConfigMutationPreflights: (...args: unknown[]) => mocks.preflight(...args),
  selectInstallMutationWriteOptions: (writeOptions: unknown) =>
    mocks.selectWriteOptions(writeOptions),
}));

vi.mock("./slot-selection.js", () => ({
  applySlotSelectionForPlugin: (config: unknown) => mocks.slotSelection(config),
}));

vi.mock("./registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: (...args: unknown[]) => mocks.refreshRegistry(...args),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
  resolvePluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
}));

vi.mock("./clawhub.js", () => ({
  installPluginFromClawHub: (params: Parameters<typeof invokePluginArtifactInstallMock>[1]) =>
    invokePluginArtifactInstallMock(mocks.clawhubInstall, params, {
      manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] },
    }),
}));

vi.mock("./install.js", () => ({
  installPluginFromNpmSpec: (...args: unknown[]) => mocks.npmInstall(...args),
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: (...args: unknown[]) => mocks.installRecords(...args),
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
    mocks.officialCatalog(...args),
}));

const { clearManagedPluginOfficialCatalogCache, installManagedPlugin, setManagedPluginEnabled } =
  await import("./management-service.js");

function mockHostedOfficialCatalog(entries: unknown[]) {
  mocks.officialCatalog.mockResolvedValue({
    source: "hosted",
    entries,
    feed: { schemaVersion: 1, id: "test", generatedAt: "now", sequence: 1, entries: [] },
    metadata: { url: "https://clawhub.ai/feed", status: 200, checksum: "hash" },
  });
}

const emptyArtifactAcknowledgment = {
  reviewToken: computeDeclaredSurfaceHash(
    buildPluginCapabilitySummary({ manifest: {}, origin: "global" }).declared,
  ),
};

function mockClawHubInstall(pluginId: string, packageName: string) {
  mocks.clawhubInstall.mockResolvedValue({
    ok: true,
    pluginId,
    targetDir: `/tmp/extensions/${pluginId}`,
    extensions: ["index.js"],
    packageName,
    clawhub: {
      source: "clawhub",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: packageName,
      clawhubFamily: "code-plugin",
    },
  });
}

describe("managed plugin installation", () => {
  beforeEach(() => {
    clearManagedPluginOfficialCatalogCache();
    for (const mock of Object.values(mocks)) {
      if (typeof mock === "function" && "mockReset" in mock) {
        mock.mockReset();
      }
    }
    mocks.selectWriteOptions.mockImplementation((writeOptions) => writeOptions);
    mocks.preflight.mockReturnValue({
      hookMutation: { mode: "allowed" },
      pluginMutation: { mode: "allowed" },
    });
    mocks.slotSelection.mockImplementation((config) => ({ config, warnings: [] }));
    mocks.installRecords.mockResolvedValue({});
    mockHostedOfficialCatalog([]);
  });

  it("pins curated ClawHub installs to the expected runtime id", async () => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mockHostedOfficialCatalog([hostedFeedDiffsEntry]);
    mockClawHubInstall("impostor", "@openclaw/diffs");

    await expect(
      installManagedPlugin({
        request: {
          source: "clawhub",
          packageName: "@openclaw/diffs",
        },
        env: {},
      }),
    ).rejects.toThrow("expected diffs, got impostor");
    expect(mocks.clawhubInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:@openclaw/diffs@2026.6.11",
        expectedPluginId: "diffs",
        expectedIntegrity: `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`,
      }),
    );
    expect(mocks.persistInstall).not.toHaveBeenCalled();
  });

  it("resolves hosted-only beta installs without pinning the package name as a runtime id", async () => {
    const installRecord = {
      source: "clawhub",
      spec: "clawhub:@openclaw/bluebubbles",
      installPath: "/tmp/extensions/bluebubbles",
    };
    mocks.readConfig.mockResolvedValue(configSnapshot({ update: { channel: "beta" } }));
    // Package identity without a declared runtime id must not become an expectedPluginId pin.
    mockHostedOfficialCatalog([
      {
        id: "@openclaw/bluebubbles",
        title: "BlueBubbles",
        state: "available",
        publisher: { id: "openclaw", trust: "official" },
        install: {
          candidates: [{ sourceRef: "public-clawhub", package: "@openclaw/bluebubbles" }],
        },
      },
    ]);
    mockClawHubInstall("bluebubbles", "@openclaw/bluebubbles");
    mocks.persistInstall.mockResolvedValue({});
    mocks.refreshRegistry.mockResolvedValue(undefined);
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        enabled: false,
        id: "bluebubbles",
        name: "BlueBubbles",
        origin: "global",
        installRecord,
      }),
    );

    const result = await installManagedPlugin({
      request: {
        source: "clawhub",
        packageName: "@openclaw/bluebubbles",
        acknowledgeCapabilities: emptyArtifactAcknowledgment,
      },
      env: {},
    });

    expect(mocks.clawhubInstall).toHaveBeenCalledWith(
      expect.not.objectContaining({ expectedPluginId: expect.anything() }),
    );
    expect(mocks.clawhubInstall).toHaveBeenCalledWith(
      expect.objectContaining({ spec: "clawhub:@openclaw/bluebubbles@beta" }),
    );
    expect(mocks.persistInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        install: expect.objectContaining({ spec: "clawhub:@openclaw/bluebubbles" }),
      }),
    );
    expect(result.plugin.id).toBe("bluebubbles");
  });

  it("keeps the runtime-id pin when a declared id equals the package name", async () => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    // An unscoped package can legitimately declare its package name as the runtime id.
    mockHostedOfficialCatalog([
      {
        id: "sonos",
        title: "Sonos",
        state: "available",
        publisher: { id: "openclaw", trust: "official" },
        openclaw: { plugin: { id: "sonos" } },
        install: { candidates: [{ sourceRef: "public-clawhub", package: "sonos" }] },
      },
    ]);
    mockClawHubInstall("impostor", "sonos");

    await expect(
      installManagedPlugin({
        request: { source: "clawhub", packageName: "sonos" },
        env: {},
      }),
    ).rejects.toThrow("expected sonos, got impostor");
    expect(mocks.clawhubInstall).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPluginId: "sonos" }),
    );
  });

  it("threads hosted ClawHub candidate integrity into official installs", async () => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mockHostedOfficialCatalog([hostedFeedDiffsEntry]);
    mockClawHubInstall("diffs", "@openclaw/diffs");
    mocks.persistInstall.mockResolvedValue({});
    mocks.metadata.mockReturnValue(
      metadataSnapshot({ enabled: true, id: "diffs", name: "Diffs", origin: "global" }),
    );

    await installManagedPlugin({
      request: {
        source: "official",
        pluginId: "diffs",
        acknowledgeCapabilities: emptyArtifactAcknowledgment,
      },
      env: {},
    });

    expect(mocks.clawhubInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:@openclaw/diffs@2026.6.11",
        expectedPluginId: "diffs",
        expectedIntegrity: `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`,
      }),
    );
  });

  it("approves every install-policy warning in an acknowledged Gateway install", async () => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mockHostedOfficialCatalog([hostedFeedDiffsEntry]);
    mocks.clawhubInstall.mockImplementation(async (params: unknown) => {
      const callback = expectDefined(
        (
          params as {
            onInstallPolicyWarning?: (request: {
              targetName: string;
              targetType: "plugin";
              requestMode: "install";
              reason: string;
            }) => Promise<{ status: "approved" | "declined" }>;
          }
        ).onInstallPolicyWarning,
        "install policy acknowledgement callback",
      );
      await expect(
        callback({
          targetName: "diffs",
          targetType: "plugin",
          requestMode: "install",
          reason: "Review package metadata",
        }),
      ).resolves.toEqual({ status: "approved" });
      await expect(
        callback({
          targetName: "diffs",
          targetType: "plugin",
          requestMode: "install",
          reason: "Review installed dependencies",
        }),
      ).resolves.toEqual({ status: "approved" });
      return {
        ok: true,
        pluginId: "diffs",
        targetDir: "/tmp/extensions/diffs",
        extensions: ["index.js"],
        packageName: "@openclaw/diffs",
        clawhub: {
          source: "clawhub",
          clawhubUrl: "https://clawhub.ai",
          clawhubPackage: "@openclaw/diffs",
          clawhubFamily: "code-plugin",
        },
      };
    });
    mocks.persistInstall.mockResolvedValue({});
    mocks.metadata.mockReturnValue(
      metadataSnapshot({ enabled: true, id: "diffs", name: "Diffs", origin: "global" }),
    );

    await installManagedPlugin({
      request: {
        source: "official",
        pluginId: "diffs",
        acknowledgeInstallPolicyWarning: true,
        acknowledgeCapabilities: emptyArtifactAcknowledgment,
      },
      env: {},
    });
  });

  it("serializes install and enable mutations through one Gateway lock", async () => {
    let releasePersist: ((config: Record<string, unknown>) => void) | undefined;
    const heldPersist = new Promise<Record<string, unknown>>((resolve) => {
      releasePersist = resolve;
    });
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mockClawHubInstall("demo", "community/demo");
    mocks.persistInstall.mockReturnValueOnce(heldPersist);
    mocks.replaceConfig.mockResolvedValue({});
    mocks.refreshRegistry.mockResolvedValue(undefined);
    mocks.metadata
      .mockReturnValueOnce(metadataSnapshot({ enabled: true, id: "demo", origin: "global" }))
      .mockReturnValueOnce(metadataSnapshot({ enabled: false }))
      .mockReturnValueOnce(metadataSnapshot({ enabled: true }));

    const install = installManagedPlugin({
      request: {
        source: "clawhub",
        packageName: "community/demo",
        acknowledgeCapabilities: emptyArtifactAcknowledgment,
      },
      env: {},
    });
    await vi.waitFor(() => expect(mocks.persistInstall).toHaveBeenCalledTimes(1));
    const enable = setManagedPluginEnabled({ pluginId: "workboard", enabled: true, env: {} });
    await Promise.resolve();

    expect(mocks.readConfig).toHaveBeenCalledTimes(1);
    releasePersist?.({});
    await install;
    await enable;
    expect(mocks.readConfig).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["clawhub_risk_acknowledgement_required", "invalid-request"],
    ["clawhub_security_unavailable", "unavailable"],
  ] as const)("classifies ClawHub failure %s", async (code, expectedKind) => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.clawhubInstall.mockResolvedValue({
      ok: false,
      error: "ClawHub install failed",
      code,
      version: "1.2.3",
      warning: "Review the release",
    });

    await expect(
      installManagedPlugin({
        request: { source: "clawhub", packageName: "community/plugin" },
        env: {},
      }),
    ).rejects.toMatchObject({
      kind: expectedKind,
      code,
      version: "1.2.3",
      warning: "Review the release",
    });
  });
});
