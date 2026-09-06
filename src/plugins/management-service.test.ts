import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  configSnapshot,
  emptyMetadataSnapshot,
  hostedDiffsEntry,
  hostedFeedDiffsEntry,
  metadataSnapshot,
} from "./management-service.test-helpers.js";

const mocks = vi.hoisted(() => ({
  applyUninstall: vi.fn(),
  clawReferenceWarnings: vi.fn(),
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
  resolvePluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
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

vi.mock("./uninstall-claw-references.js", () => ({
  collectClawPluginUninstallWarnings: (...args: unknown[]) => mocks.clawReferenceWarnings(...args),
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

const { clearManagedPluginOfficialCatalogCache } = await import("./management-catalog.js");
const { listManagedPlugins, resolveManagedPluginIconSource, resolveManagedSetupCatalogIconUrl } =
  await import("./management-service.js");
const { setManagedPluginEnabled, uninstallManagedPlugin } =
  await import("./management-mutations.js");

function mockHostedOfficialCatalog(entries: unknown[]) {
  mocks.officialCatalog.mockResolvedValue({
    source: "hosted",
    entries,
    feed: { schemaVersion: 1, id: "test", generatedAt: "now", sequence: 1, entries: [] },
    metadata: { url: "https://clawhub.ai/feed", status: 200, checksum: "hash" },
  });
}

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
    mocks.clawReferenceWarnings.mockReturnValue([]);
    mockHostedOfficialCatalog([]);
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
    mockHostedOfficialCatalog([hostedFeedDiffsEntry]);

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
    mockHostedOfficialCatalog([
      {
        ...hostedDiffsEntry,
        name: "community/impostor",
        openclaw: {
          ...hostedDiffsEntry.openclaw,
          install: { clawhubSpec: "clawhub:community/impostor", defaultChoice: "clawhub" },
        },
      },
    ]);

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

  it.each([
    {
      name: "reports missing dependencies for a bundled plugin distributed outside the root package",
      packageBuild: { bundledDist: false },
      expectsError: true,
    },
    {
      name: "keeps plain bundled plugins free of package-local dependency health",
      packageBuild: undefined,
      expectsError: false,
    },
  ])("$name", async ({ packageBuild, expectsError }) => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        enabled: true,
        packageBuild,
        packageDependencies: { "missing-runtime": "1.0.0" },
      }),
    );

    const catalog = await listManagedPlugins({
      config: { plugins: { entries: { workboard: { enabled: true } } } },
      env: {},
      officialCatalog: { entries: [] },
    });

    const entry = expectDefined(catalog.plugins[0], "catalog entry");
    if (expectsError) {
      expect(entry.error).toContain("required dependencies are missing: missing-runtime");
    } else {
      expect(entry.error).toBeUndefined();
    }
  });

  it("does not project or resolve installed manifest icon URLs", async () => {
    const icon = "https://cdn.example.test/workboard.svg";
    const config = {
      agents: {
        defaults: { workspace: "~/fallback-workspace" },
        list: [
          { id: "main" },
          { id: "research", default: true, workspace: "~/research-workspace" },
        ],
      },
    };
    const env = { HOME: "/tmp/openclaw-managed-plugin-home" };
    const metadata = metadataSnapshot({ enabled: false });
    const manifest = metadata.byPluginId.get("workboard");
    expect(manifest).toBeDefined();
    if (!manifest) {
      throw new Error("missing workboard manifest fixture");
    }
    metadata.byPluginId.set("workboard", Object.assign(manifest, { icon }));
    mocks.metadata.mockReturnValue(metadata);

    const catalog = await listManagedPlugins({
      config,
      env,
      officialCatalog: { entries: [] },
    });
    const resolved = await resolveManagedPluginIconSource({
      config,
      env,
      pluginId: "workboard",
    });

    expect(catalog.plugins[0]).toMatchObject({ id: "workboard" });
    expect(catalog.plugins[0]).not.toHaveProperty("hasIcon");
    expect(resolved).toBeUndefined();
    expect(mocks.metadata).toHaveBeenNthCalledWith(1, {
      config,
      env,
      workspaceDir: "/tmp/openclaw-managed-plugin-home/research-workspace",
    });
    expect(mocks.metadata).toHaveBeenNthCalledWith(2, {
      config,
      env,
      workspaceDir: "/tmp/openclaw-managed-plugin-home/research-workspace",
    });
  });

  it("does not project or resolve official catalog icon URLs", async () => {
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
    const resolved = await resolveManagedPluginIconSource({
      config: {},
      env: {},
      pluginId: "firecrawl",
    });

    expect(catalog.plugins[0]).toMatchObject({ id: "firecrawl" });
    expect(catalog.plugins[0]).not.toHaveProperty("hasIcon");
    expect(catalog.plugins[0]).not.toHaveProperty("icon");
    expect(resolved).toBeUndefined();
  });

  it("resolves the portable package icon", async () => {
    const iconPath = "/tmp/workboard/assets/icon.png";
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        enabled: false,
        iconPath,
      }),
    );

    const catalog = await listManagedPlugins({
      config: {},
      env: {},
    });
    const resolved = await resolveManagedPluginIconSource({
      config: {},
      env: {},
      pluginId: "workboard",
    });

    expect(catalog.plugins[0]).toMatchObject({ id: "workboard", hasIcon: true });
    expect(resolved).toEqual({ kind: "file", path: iconPath, rootPath: "/tmp/workboard" });
  });

  it("allows only provider-choice and bundled setup catalog icon URLs", async () => {
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

  it("omits icon capability when the package has no local icon", async () => {
    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: false }));

    const catalog = await listManagedPlugins({
      config: {},
      env: {},
      officialCatalog: { entries: [] },
    });
    const resolved = await resolveManagedPluginIconSource({
      config: {},
      env: {},
      pluginId: "workboard",
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
    const env = { HOME: "/tmp/openclaw-managed-toggle-home" };
    const prepared = configSnapshot({
      agents: { defaults: { workspace: "~/managed-toggle-workspace" } },
    });
    mocks.readConfig.mockResolvedValue(prepared);
    mocks.metadata
      .mockReturnValueOnce(metadataSnapshot({ enabled: false }))
      .mockReturnValueOnce(metadataSnapshot({ enabled: true }));
    mocks.replaceConfig.mockResolvedValue({});
    mocks.refreshRegistry.mockResolvedValue(undefined);

    const result = await setManagedPluginEnabled({
      pluginId: "workboard",
      enabled: true,
      env,
    });

    expect(mocks.metadata).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        config: prepared.snapshot.sourceConfig,
        env,
        workspaceDir: "/tmp/openclaw-managed-toggle-home/managed-toggle-workspace",
      }),
    );
    expect(mocks.metadata).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        env,
        workspaceDir: "/tmp/openclaw-managed-toggle-home/managed-toggle-workspace",
      }),
    );
    expect(mocks.replaceConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        baseHash: "base-hash",
        writeOptions: prepared.writeOptions,
      }),
    );
    expect(mocks.refreshRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
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
    const env = { HOME: "/tmp/openclaw-managed-uninstall-home" };
    const installRecord = {
      source: "clawhub",
      spec: "clawhub:@openclaw/diffs",
      installPath: "/tmp/extensions/diffs",
    };
    const prepared = configSnapshot({
      agents: { defaults: { workspace: "~/managed-uninstall-workspace" } },
      plugins: { entries: { diffs: { enabled: true } } },
    });
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
    mocks.clawReferenceWarnings.mockReturnValue([
      'Warning: plugin "diffs" is referenced by Claw: @acme/review.',
    ]);
    mocks.refreshRegistry.mockResolvedValue(undefined);

    const result = await uninstallManagedPlugin({ pluginId: "diffs", env });

    expect(mocks.installRecords).toHaveBeenCalledWith({ env });
    expect(mocks.metadata).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        workspaceDir: "/tmp/openclaw-managed-uninstall-home/managed-uninstall-workspace",
      }),
    );
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
    expect(
      expectDefined(
        mocks.commitRecords.mock.calls[0],
        "mocks.commitRecords.mock.calls[0] test invariant",
      )[0].nextConfig.plugins?.installs,
    ).toBeUndefined();
    expect(mocks.applyUninstall).toHaveBeenCalledWith({ target: "/tmp/extensions/diffs" });
    expect(mocks.refreshRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        reason: "source-changed",
        installRecords: {},
      }),
    );
    expect(result).toMatchObject({
      pluginId: "diffs",
      removed: ["plugin settings", "install record", "directory"],
      warnings: ['Warning: plugin "diffs" is referenced by Claw: @acme/review.'],
    });
  });

  it("refuses to uninstall bundled plugins", async () => {
    mocks.readConfig.mockResolvedValue(configSnapshot());
    mocks.installRecords.mockResolvedValue({});
    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: false }));

    await expect(uninstallManagedPlugin({ pluginId: "workboard", env: {} })).rejects.toThrow(
      "bundled plugin cannot be uninstalled",
    );
    expect([mocks.commitRecords.mock.calls, mocks.applyUninstall.mock.calls]).toEqual([[], []]);
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
