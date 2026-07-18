// Plugin management service tests cover cold state, catalog identity, and guarded mutations.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyUninstall: vi.fn(),
  clawhubInstall: vi.fn(),
  commitRecords: vi.fn(),
  installRecords: vi.fn(),
  metadata: vi.fn(),
  npmInstall: vi.fn(),
  officialCatalog: vi.fn(),
  persistInstall: vi.fn(),
  preflight: vi.fn(),
  providerAuthChoices: vi.fn(),
  readConfig: vi.fn(),
  recommendedInstalls: vi.fn(),
  refreshRegistry: vi.fn(),
  replaceConfig: vi.fn(),
  planUninstall: vi.fn(),
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
}));

vi.mock("./clawhub.js", () => ({
  installPluginFromClawHub: (...args: unknown[]) => mocks.clawhubInstall(...args),
}));

vi.mock("./install.js", () => ({
  installPluginFromNpmSpec: (...args: unknown[]) => mocks.npmInstall(...args),
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  // Keep the pure config/record helpers real; only record IO is stubbed.
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: (...args: unknown[]) => mocks.installRecords(...args),
}));

vi.mock("./uninstall.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./uninstall.js")>()),
  applyPluginUninstallDirectoryRemoval: (...args: unknown[]) => mocks.applyUninstall(...args),
  planPluginUninstall: (...args: unknown[]) => mocks.planUninstall(...args),
}));

vi.mock("./install-record-commit.js", () => ({
  commitPluginInstallRecordsWithConfig: (...args: unknown[]) => mocks.commitRecords(...args),
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
    mocks.officialCatalog(...args),
}));

vi.mock("./provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoices: (...args: unknown[]) => mocks.providerAuthChoices(...args),
}));

vi.mock("./recommended-tool-installs.js", () => ({
  listRecommendedToolInstalls: (...args: unknown[]) => mocks.recommendedInstalls(...args),
}));

const {
  clearManagedPluginOfficialCatalogCache,
  installManagedPlugin,
  listManagedPlugins,
  resolveManagedPluginIconUrl,
  resolveManagedSetupCatalogIconUrl,
  setManagedPluginEnabled,
  uninstallManagedPlugin,
} = await import("./management-service.js");

function configSnapshot(config: Record<string, unknown> = {}) {
  return {
    snapshot: {
      valid: true,
      parsed: {},
      path: "/tmp/openclaw.json",
      sourceConfig: config,
      hash: "base-hash",
    },
    writeOptions: {
      expectedConfigPath: "/tmp/openclaw.json",
      includeFileHashesForWrite: { "/tmp/plugins.json": "include-hash" },
      includeFileTargetsForWrite: { "/tmp/plugins.json": "/tmp/plugins.json" },
    },
  };
}

function metadataSnapshot(params: {
  enabled: boolean;
  id?: string;
  name?: string;
  origin?: "bundled" | "global";
  installRecord?: Record<string, unknown>;
  icon?: string;
}) {
  const id = params.id ?? "workboard";
  const manifest = {
    id,
    name: params.name ?? "Workboard",
    description: "Coordinate agent work in a shared board.",
    catalog: { featured: true, order: 10 },
    ...(params.icon ? { icon: params.icon } : {}),
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: params.origin ?? "bundled",
    rootDir: `/tmp/${id}`,
    source: `/tmp/${id}/index.ts`,
    manifestPath: `/tmp/${id}/openclaw.plugin.json`,
  };
  return {
    index: {
      plugins: [
        {
          pluginId: id,
          packageName: `@openclaw/${id}`,
          origin: params.origin ?? "bundled",
          enabled: params.enabled,
        },
      ],
      installRecords: params.installRecord ? { [id]: params.installRecord } : {},
    },
    byPluginId: new Map([[id, manifest]]),
    plugins: [manifest],
    diagnostics: [],
    normalizePluginId: (pluginId: string) => pluginId,
  };
}

function emptyMetadataSnapshot() {
  return {
    index: { plugins: [], installRecords: {} },
    byPluginId: new Map(),
    plugins: [],
    diagnostics: [],
    normalizePluginId: (pluginId: string) => pluginId,
  };
}

const hostedDiffsEntry = {
  name: "@openclaw/diffs",
  version: "2.0.0",
  description: "Hosted description",
  openclaw: {
    plugin: { id: "diffs", label: "Hosted Diffs" },
    install: { clawhubSpec: "clawhub:@openclaw/diffs", defaultChoice: "clawhub" },
  },
};

// Mirrors the current default ClawHub feed shape: package identity lives in a
// source candidate while runtime/editorial metadata remains local.
const hostedFeedDiffsEntry = {
  id: "@openclaw/diffs",
  title: "Diffs",
  state: "available",
  featured: true,
  publisher: { id: "openclaw", trust: "official" },
  install: {
    candidates: [
      {
        sourceRef: "public-clawhub",
        package: "@openclaw/diffs",
        version: "2026.6.11",
        integrity: `sha256:${"a".repeat(64)}`,
      },
    ],
  },
};

describe("plugin management service", () => {
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
    mocks.applyUninstall.mockResolvedValue({ directoryRemoved: true, warnings: [] });
    mocks.providerAuthChoices.mockReturnValue([]);
    mocks.recommendedInstalls.mockReturnValue([]);
    mocks.officialCatalog.mockResolvedValue({
      source: "hosted",
      entries: [],
      feed: { schemaVersion: 1, id: "test", generatedAt: "now", sequence: 1, entries: [] },
      metadata: { url: "https://clawhub.ai/feed", status: 200, checksum: "hash" },
    });
  });

  it("keeps bundled curation when the hosted catalog falls back offline", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mocks.officialCatalog.mockResolvedValue({
      source: "bundled-fallback",
      entries: [hostedDiffsEntry],
      error: "offline",
    });

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "diffs",
        name: "Diffs",
        description: "Hosted description",
        version: "2.0.0",
        featured: true,
        order: 40,
        install: { source: "clawhub", packageName: "@openclaw/diffs" },
      }),
    ]);
  });

  it("normalizes package-shaped hosted rows and deduplicates their runtime id", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mocks.officialCatalog.mockResolvedValue({
      source: "hosted",
      entries: [hostedFeedDiffsEntry],
      feed: { schemaVersion: 1, id: "test", generatedAt: "now", sequence: 1, entries: [] },
      metadata: { url: "https://clawhub.ai/feed", status: 200, checksum: "hash" },
    });

    const available = await listManagedPlugins({ config: {}, env: {} });
    expect(available.plugins).toEqual([
      expect.objectContaining({
        id: "diffs",
        name: "Diffs",
        installed: false,
        featured: true,
        order: 40,
        install: { source: "official", pluginId: "diffs" },
      }),
    ]);

    mocks.metadata.mockReturnValue(
      metadataSnapshot({ enabled: true, id: "diffs", name: "Diffs", origin: "global" }),
    );
    const installed = await listManagedPlugins({ config: {}, env: {} });
    expect(installed.plugins).toHaveLength(1);
    expect(installed.plugins[0]).toMatchObject({ id: "diffs", installed: true, enabled: true });
  });

  it("does not transfer bundled endorsement to a package identity impostor", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mocks.officialCatalog.mockResolvedValue({
      source: "hosted",
      entries: [
        {
          ...hostedDiffsEntry,
          name: "community/impostor",
          openclaw: {
            ...hostedDiffsEntry.openclaw,
            install: { clawhubSpec: "clawhub:community/impostor", defaultChoice: "clawhub" },
          },
        },
      ],
      feed: { schemaVersion: 1, id: "test", generatedAt: "now", sequence: 1, entries: [] },
      metadata: { url: "https://clawhub.ai/feed", status: 200, checksum: "hash" },
    });

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins).toEqual([]);
  });

  it("normalizes hosted catalog hints before building the public DTO", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());

    const catalog = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: {
        entries: [
          {
            name: "community/partial",
            openclaw: {
              plugin: { id: "partial", label: "Partial" },
              catalog: { featured: "yes", order: 25 },
            },
          },
          {
            name: "community/invalid",
            openclaw: {
              plugin: { id: "invalid", label: "Invalid" },
              catalog: { featured: "yes", order: "first" },
            },
          },
        ] as never,
      },
    });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "partial",
        order: 25,
      }),
    ]);
    expect(catalog.plugins[0]).not.toHaveProperty("featured");
  });

  it("lists bundled Workboard as installed, default-off, and cold-disabled", async () => {
    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: false }));

    const catalog = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "workboard",
        packageName: "@openclaw/workboard",
        installed: true,
        enabled: false,
        state: "disabled",
        featured: true,
        order: 10,
      }),
    ]);
    expect(catalog.mutationAllowed).toBe(true);
  });

  it("projects and resolves installed manifest icons by plugin identity", async () => {
    const icon = "https://cdn.example.test/workboard.svg";
    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: false, icon }));

    const catalog = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });
    const resolved = await resolveManagedPluginIconUrl({
      config: {},
      env: {},
      pluginId: "workboard",
      officialCatalog: { entries: [] },
    });

    expect(catalog.plugins[0]).toMatchObject({ id: "workboard", hasIcon: true });
    expect(resolved).toBe(icon);
  });

  it("projects and resolves official catalog icons without exposing their URL", async () => {
    const icon = "https://cdn.example.test/firecrawl.svg";
    const officialCatalog = {
      entries: [
        {
          name: "@openclaw/firecrawl",
          description: "Web extraction and crawling.",
          openclaw: {
            plugin: { id: "firecrawl", label: "FireCrawl" },
            catalog: { featured: true, order: 60 },
            icon,
          },
        },
      ],
    };
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());

    const catalog = await listManagedPlugins({ config: {}, env: {}, officialCatalog });
    const resolved = await resolveManagedPluginIconUrl({
      config: {},
      env: {},
      pluginId: "firecrawl",
      officialCatalog,
    });

    expect(catalog.plugins[0]).toMatchObject({ id: "firecrawl", hasIcon: true });
    expect(catalog.plugins[0]).not.toHaveProperty("icon");
    expect(resolved).toBe(icon);
  });

  it("allows only manifest and bundled setup catalog icon URLs", async () => {
    const providerIcon = "https://cdn.example.test/provider.svg";
    const recommendedIcon = "https://cdn.example.test/tool.png";
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mocks.providerAuthChoices.mockReturnValue([{ choiceId: "provider", icon: providerIcon }]);
    mocks.recommendedInstalls.mockReturnValue([{ id: "tool", icon: recommendedIcon }]);
    const resolve = (iconUrl: string) =>
      resolveManagedSetupCatalogIconUrl({ config: {}, env: {}, iconUrl });
    expect(resolve(providerIcon)).toBe(providerIcon);
    expect(resolve(recommendedIcon)).toBe(recommendedIcon);
    expect(resolve("https://untrusted.example/icon.png")).toBeUndefined();
    expect(resolve("http://127.0.0.1/private.png")).toBeUndefined();
    expect(mocks.providerAuthChoices).toHaveBeenCalledWith({
      config: {},
      env: {},
      includeUntrustedWorkspacePlugins: false,
      includeWorkspacePlugins: false,
    });
  });

  it("omits icon capability when neither manifest nor catalog has one", async () => {
    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: false }));

    const catalog = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });
    const resolved = await resolveManagedPluginIconUrl({
      config: {},
      env: {},
      pluginId: "workboard",
      officialCatalog: { entries: [] },
    });

    expect(catalog.plugins[0]).not.toHaveProperty("hasIcon");
    expect(resolved).toBeUndefined();
  });

  it("refuses mutation in Nix mode before reading or writing config", async () => {
    await expect(
      setManagedPluginEnabled({
        pluginId: "workboard",
        enabled: true,
        env: { OPENCLAW_NIX_MODE: "1" },
      }),
    ).rejects.toThrow("managed by Nix");
    expect(mocks.readConfig).not.toHaveBeenCalled();
    expect(mocks.replaceConfig).not.toHaveBeenCalled();
  });

  it("blocks unsupported plugin includes before config mutation", async () => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.preflight.mockReturnValue({
      hookMutation: { mode: "allowed" },
      pluginMutation: { mode: "blocked", reason: "nested plugins include" },
    });

    await expect(
      setManagedPluginEnabled({ pluginId: "workboard", enabled: true, env: {} }),
    ).rejects.toThrow("nested plugins include");
    expect(mocks.replaceConfig).not.toHaveBeenCalled();
  });

  it("preserves config hash and include ownership when enabling Workboard", async () => {
    const prepared = configSnapshot();
    mocks.readConfig.mockResolvedValue(prepared);
    mocks.metadata
      .mockReturnValueOnce(metadataSnapshot({ enabled: false }))
      .mockReturnValueOnce(metadataSnapshot({ enabled: true }));
    mocks.replaceConfig.mockResolvedValue({});
    mocks.refreshRegistry.mockResolvedValue(undefined);

    const result = await setManagedPluginEnabled({
      pluginId: "workboard",
      enabled: true,
      env: {},
    });

    expect(mocks.replaceConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        baseHash: "base-hash",
        writeOptions: prepared.writeOptions,
      }),
    );
    expect(mocks.refreshRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "policy-changed",
        policyPluginIds: ["workboard"],
      }),
    );
    expect(result).toMatchObject({
      plugin: { id: "workboard", enabled: true, state: "enabled" },
      changedPaths: ["plugins"],
    });
  });

  it("adds an admin-selected plugin to an existing restrictive allowlist", async () => {
    const config = {
      plugins: {
        allow: ["memory-core"],
        entries: { workboard: { enabled: false } },
      },
    };
    mocks.readConfig.mockResolvedValue(configSnapshot(config));
    mocks.replaceConfig.mockResolvedValue({});
    mocks.refreshRegistry.mockResolvedValue(undefined);
    mocks.metadata
      .mockReturnValueOnce(metadataSnapshot({ enabled: false }))
      .mockReturnValueOnce(metadataSnapshot({ enabled: true }));

    const result = await setManagedPluginEnabled({
      pluginId: "workboard",
      enabled: true,
      env: {},
    });

    expect(mocks.replaceConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: {
          plugins: {
            allow: ["memory-core", "workboard"],
            entries: { workboard: { enabled: true } },
          },
        },
      }),
    );
    expect(result.changedPaths).toEqual(["plugins.allow[1]", "plugins.entries.workboard.enabled"]);
  });

  it("keeps an explicit deny authoritative for admin enablement", async () => {
    const config = {
      plugins: {
        allow: ["memory-core"],
        deny: ["workboard"],
        entries: { workboard: { enabled: false } },
      },
    };
    mocks.readConfig.mockResolvedValue(configSnapshot(config));
    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: false }));

    await expect(
      setManagedPluginEnabled({ pluginId: "workboard", enabled: true, env: {} }),
    ).rejects.toThrow('plugin "workboard" could not be enabled (blocked by denylist)');
    expect(mocks.replaceConfig).not.toHaveBeenCalled();
  });

  it("does not turn an empty allowlist into a restrictive one", async () => {
    const config = {
      plugins: {
        allow: [],
        entries: { workboard: { enabled: false } },
      },
    };
    mocks.readConfig.mockResolvedValue(configSnapshot(config));
    mocks.replaceConfig.mockResolvedValue({});
    mocks.refreshRegistry.mockResolvedValue(undefined);
    mocks.metadata
      .mockReturnValueOnce(metadataSnapshot({ enabled: false }))
      .mockReturnValueOnce(metadataSnapshot({ enabled: true }));

    await setManagedPluginEnabled({ pluginId: "workboard", enabled: true, env: {} });

    expect(mocks.replaceConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: {
          plugins: {
            allow: [],
            entries: { workboard: { enabled: true } },
          },
        },
      }),
    );
  });

  it("reports exclusive-slot side effects in established plugin config", async () => {
    const config = {
      plugins: {
        entries: { workboard: { enabled: false } },
        slots: { memory: "memory-core" },
      },
    };
    mocks.readConfig.mockResolvedValue(configSnapshot(config));
    mocks.slotSelection.mockImplementation((next) => ({
      config: {
        ...(next as Record<string, unknown>),
        plugins: {
          ...(next as { plugins?: Record<string, unknown> }).plugins,
          slots: { memory: "workboard" },
        },
      },
      warnings: ["Selected workboard for the memory slot."],
    }));
    mocks.replaceConfig.mockResolvedValue({});
    mocks.refreshRegistry.mockResolvedValue(undefined);
    mocks.metadata
      .mockReturnValueOnce(metadataSnapshot({ enabled: false }))
      .mockReturnValueOnce(metadataSnapshot({ enabled: true }));

    const result = await setManagedPluginEnabled({
      pluginId: "workboard",
      enabled: true,
      env: {},
    });

    expect(result.changedPaths).toEqual([
      "plugins.entries.workboard.enabled",
      "plugins.slots.memory",
    ]);
    expect(result.warnings).toEqual(["Selected workboard for the memory slot."]);
  });

  it("pins curated ClawHub installs to the expected runtime id", async () => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.officialCatalog.mockResolvedValue({
      source: "hosted",
      entries: [hostedFeedDiffsEntry],
      feed: { schemaVersion: 1, id: "test", generatedAt: "now", sequence: 1, entries: [] },
      metadata: { url: "https://clawhub.ai/feed", status: 200, checksum: "hash" },
    });
    mocks.clawhubInstall.mockResolvedValue({
      ok: true,
      pluginId: "impostor",
      targetDir: "/tmp/extensions/impostor",
      extensions: ["index.js"],
      packageName: "@openclaw/diffs",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "@openclaw/diffs",
        clawhubFamily: "code-plugin",
      },
    });

    await expect(
      installManagedPlugin({
        request: {
          source: "clawhub",
          packageName: "@openclaw/diffs",
          acknowledgeClawHubRisk: true,
        },
        env: {},
      }),
    ).rejects.toThrow("expected diffs, got impostor");
    expect(mocks.clawhubInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: "clawhub:@openclaw/diffs@2026.6.11",
        expectedPluginId: "diffs",
        expectedIntegrity: `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`,
        acknowledgeClawHubRisk: true,
      }),
    );
    expect(mocks.persistInstall).not.toHaveBeenCalled();
  });

  it("does not pin a runtime id when the hosted entry only exposes its package name", async () => {
    const installRecord = {
      source: "clawhub",
      spec: "clawhub:@openclaw/bluebubbles",
      installPath: "/tmp/extensions/bluebubbles",
    };
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.officialCatalog.mockResolvedValue({
      source: "hosted",
      // Hosted feed row without a declared runtime id: the id falls back to
      // the package name, which must not become an expectedPluginId pin.
      entries: [
        {
          id: "@openclaw/bluebubbles",
          title: "BlueBubbles",
          state: "available",
          publisher: { id: "openclaw", trust: "official" },
          install: {
            candidates: [{ sourceRef: "public-clawhub", package: "@openclaw/bluebubbles" }],
          },
        },
      ],
      feed: { schemaVersion: 1, id: "test", generatedAt: "now", sequence: 1, entries: [] },
      metadata: { url: "https://clawhub.ai/feed", status: 200, checksum: "hash" },
    });
    mocks.clawhubInstall.mockResolvedValue({
      ok: true,
      pluginId: "bluebubbles",
      targetDir: "/tmp/extensions/bluebubbles",
      extensions: ["index.js"],
      packageName: "@openclaw/bluebubbles",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "@openclaw/bluebubbles",
        clawhubFamily: "code-plugin",
      },
    });
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
      request: { source: "clawhub", packageName: "@openclaw/bluebubbles" },
      env: {},
    });

    expect(mocks.clawhubInstall).toHaveBeenCalledWith(
      expect.not.objectContaining({ expectedPluginId: expect.anything() }),
    );
    expect(result.plugin.id).toBe("bluebubbles");
  });

  it("keeps the runtime-id pin when a declared id equals the package name", async () => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.officialCatalog.mockResolvedValue({
      source: "hosted",
      // Unscoped package whose declared plugin id legitimately equals its name.
      entries: [
        {
          id: "sonos",
          title: "Sonos",
          state: "available",
          publisher: { id: "openclaw", trust: "official" },
          openclaw: { plugin: { id: "sonos" } },
          install: { candidates: [{ sourceRef: "public-clawhub", package: "sonos" }] },
        },
      ],
      feed: { schemaVersion: 1, id: "test", generatedAt: "now", sequence: 1, entries: [] },
      metadata: { url: "https://clawhub.ai/feed", status: 200, checksum: "hash" },
    });
    mocks.clawhubInstall.mockResolvedValue({
      ok: true,
      pluginId: "impostor",
      targetDir: "/tmp/extensions/impostor",
      extensions: ["index.js"],
      packageName: "sonos",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "sonos",
        clawhubFamily: "code-plugin",
      },
    });

    await expect(
      installManagedPlugin({
        request: { source: "clawhub", packageName: "sonos", acknowledgeClawHubRisk: true },
        env: {},
      }),
    ).rejects.toThrow("expected sonos, got impostor");
    expect(mocks.clawhubInstall).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPluginId: "sonos" }),
    );
  });

  it("threads hosted ClawHub candidate integrity into official installs", async () => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.officialCatalog.mockResolvedValue({
      source: "hosted",
      entries: [hostedFeedDiffsEntry],
      feed: { schemaVersion: 1, id: "test", generatedAt: "now", sequence: 1, entries: [] },
      metadata: { url: "https://clawhub.ai/feed", status: 200, checksum: "hash" },
    });
    mocks.clawhubInstall.mockResolvedValue({
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
    });
    mocks.persistInstall.mockResolvedValue({});
    mocks.metadata.mockReturnValue(
      metadataSnapshot({ enabled: true, id: "diffs", name: "Diffs", origin: "global" }),
    );

    await installManagedPlugin({
      request: { source: "official", pluginId: "diffs" },
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

  it("removes only the newly installed managed target after persistence conflicts", async () => {
    const conflict = new Error("config changed during plugin install");
    const targetDir = "/tmp/extensions/demo";
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.clawhubInstall.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir,
      extensions: ["index.js"],
      packageName: "community/demo",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "community/demo",
        clawhubFamily: "code-plugin",
      },
    });
    mocks.persistInstall.mockRejectedValue(conflict);
    mocks.planUninstall.mockReturnValue({
      ok: true,
      config: {},
      pluginId: "demo",
      actions: {},
      directoryRemoval: { target: targetDir },
    });

    await expect(
      installManagedPlugin({
        request: { source: "clawhub", packageName: "community/demo" },
        env: {},
      }),
    ).rejects.toBe(conflict);
    expect(mocks.planUninstall).toHaveBeenCalledWith({
      config: {
        plugins: {
          installs: {
            demo: expect.objectContaining({
              source: "clawhub",
              spec: "clawhub:community/demo",
              installPath: targetDir,
            }),
          },
        },
      },
      pluginId: "demo",
      deleteFiles: true,
      extensionsDir: expect.any(String),
    });
    expect(mocks.applyUninstall).toHaveBeenCalledWith({ target: targetDir });
  });

  it("retains a failed install target when the durable record already owns it", async () => {
    const persistenceError = new Error("post-commit refresh failed");
    const targetDir = "/tmp/extensions/demo";
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.clawhubInstall.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir,
      extensions: ["index.js"],
      packageName: "community/demo",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "community/demo",
        clawhubFamily: "code-plugin",
      },
    });
    mocks.persistInstall.mockRejectedValue(persistenceError);
    mocks.installRecords.mockResolvedValue({
      demo: { source: "clawhub", installPath: targetDir },
    });

    await expect(
      installManagedPlugin({
        request: { source: "clawhub", packageName: "community/demo" },
        env: {},
      }),
    ).rejects.toMatchObject({
      message: "post-commit refresh failed",
      warning: expect.stringContaining("retained the managed target"),
      cause: persistenceError,
    });
    expect(mocks.planUninstall).not.toHaveBeenCalled();
    expect(mocks.applyUninstall).not.toHaveBeenCalled();
  });

  it("serializes install and enable mutations through one Gateway lock", async () => {
    let releasePersist: ((config: Record<string, unknown>) => void) | undefined;
    const heldPersist = new Promise<Record<string, unknown>>((resolve) => {
      releasePersist = resolve;
    });
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.clawhubInstall.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: "/tmp/extensions/demo",
      extensions: ["index.js"],
      packageName: "community/demo",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "community/demo",
        clawhubFamily: "code-plugin",
      },
    });
    mocks.persistInstall.mockReturnValueOnce(heldPersist);
    mocks.replaceConfig.mockResolvedValue({});
    mocks.refreshRegistry.mockResolvedValue(undefined);
    mocks.metadata
      .mockReturnValueOnce(metadataSnapshot({ enabled: true, id: "demo", origin: "global" }))
      .mockReturnValueOnce(metadataSnapshot({ enabled: false }))
      .mockReturnValueOnce(metadataSnapshot({ enabled: true }));

    const install = installManagedPlugin({
      request: { source: "clawhub", packageName: "community/demo" },
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
    {
      code: "clawhub_risk_acknowledgement_required",
      expectedKind: "invalid-request",
    },
    {
      code: "clawhub_security_unavailable",
      expectedKind: "unavailable",
    },
  ] as const)("classifies ClawHub failure $code", async ({ code, expectedKind }) => {
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

  it("marks external installs removable and bundled plugins non-removable", async () => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        enabled: true,
        id: "diffs",
        name: "Diffs",
        origin: "global",
        installRecord: { source: "clawhub", installPath: "/tmp/extensions/diffs" },
      }),
    );
    const external = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });
    expect(external.plugins[0]).toMatchObject({ id: "diffs", removable: true });

    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: false }));
    const bundled = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });
    expect(bundled.plugins[0]).toMatchObject({ id: "workboard", removable: false });
  });

  it("uninstalls an external plugin through commit, file removal, and registry refresh", async () => {
    const installRecord = {
      source: "clawhub",
      spec: "clawhub:@openclaw/diffs",
      installPath: "/tmp/extensions/diffs",
    };
    const prepared = configSnapshot({ plugins: { entries: { diffs: { enabled: true } } } });
    mocks.readConfig.mockResolvedValue(prepared);
    mocks.installRecords.mockResolvedValue({ diffs: installRecord });
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        enabled: true,
        id: "diffs",
        name: "Diffs",
        origin: "global",
        installRecord,
      }),
    );
    mocks.planUninstall.mockReturnValue({
      ok: true,
      config: { plugins: { installs: { diffs: installRecord } } },
      pluginId: "diffs",
      actions: {
        entry: true,
        install: true,
        allowlist: false,
        denylist: false,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: false,
        channelConfig: false,
        directory: false,
      },
      directoryRemoval: { target: "/tmp/extensions/diffs" },
    });
    mocks.commitRecords.mockResolvedValue(undefined);
    mocks.applyUninstall.mockResolvedValue({ directoryRemoved: true, warnings: [] });
    mocks.refreshRegistry.mockResolvedValue(undefined);

    const result = await uninstallManagedPlugin({ pluginId: "diffs", env: {} });

    expect(mocks.planUninstall).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "diffs", deleteFiles: true }),
    );
    expect(mocks.commitRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        previousInstallRecords: { diffs: installRecord },
        nextInstallRecords: {},
        baseHash: "base-hash",
        writeOptions: prepared.writeOptions,
      }),
    );
    // Transient install records never persist into the written config document.
    expect(
      expectDefined(
        mocks.commitRecords.mock.calls[0],
        "mocks.commitRecords.mock.calls[0] test invariant",
      )[0].nextConfig.plugins?.installs,
    ).toBeUndefined();
    expect(mocks.applyUninstall).toHaveBeenCalledWith({ target: "/tmp/extensions/diffs" });
    expect(mocks.refreshRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "source-changed", installRecords: {} }),
    );
    expect(result).toMatchObject({
      pluginId: "diffs",
      removed: ["config entry", "install record", "directory"],
    });
  });

  it("refuses to uninstall bundled plugins", async () => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.installRecords.mockResolvedValue({});
    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: false }));

    await expect(uninstallManagedPlugin({ pluginId: "workboard", env: {} })).rejects.toThrow(
      "bundled plugin cannot be uninstalled",
    );
    expect(mocks.commitRecords).not.toHaveBeenCalled();
    expect(mocks.applyUninstall).not.toHaveBeenCalled();
  });

  it("surfaces uninstall plan failures as lifecycle errors", async () => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.installRecords.mockResolvedValue({});
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mocks.planUninstall.mockReturnValue({ ok: false, error: "Plugin not found: ghost" });

    await expect(uninstallManagedPlugin({ pluginId: "ghost", env: {} })).rejects.toThrow(
      "Plugin not found: ghost",
    );
    expect(mocks.commitRecords).not.toHaveBeenCalled();
  });
});
