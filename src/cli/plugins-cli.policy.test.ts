// Plugins CLI policy tests cover plugin command policy checks and warnings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { recordInstalledPluginIndexInstallOwner } from "../plugins/installed-plugin-index-install-owner.js";
import { recordPluginManifestInstallOwner } from "../plugins/manifest-install-owner.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  applyExclusiveSlotSelectionMock,
  createTestInstalledPluginIndex,
  enablePluginInConfigMock,
  loadPluginManifestRegistryMock,
  pluginCliConfigMock,
  replaceConfigFileMock,
  refreshPluginRegistryMock,
  resetPluginsCliTestState,
  runtimeErrors,
  pluginsCliRuntimeLogs,
  promptYesNoMock,
  runPluginsCommand,
  setInstalledPluginIndexInstallRecords,
  configWriteMock,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
} from "./plugins-cli-test-helpers.js";

const inventory = vi.hoisted(() => ({ load: vi.fn(), hostedCatalog: vi.fn() }));

vi.mock("../plugins/plugin-registry-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-registry-snapshot.js")>()),
  loadPluginRegistrySnapshotWithMetadata: (...args: unknown[]) => inventory.load(...args),
}));

vi.mock("../plugins/official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
    inventory.hostedCatalog(...args),
}));

const ORIGINAL_OPENCLAW_NIX_MODE = process.env.OPENCLAW_NIX_MODE;

describe("plugins cli policy mutations", () => {
  let readInstallRecords: (typeof import("../plugins/installed-plugin-index-record-reader.js"))["loadInstalledPluginIndexInstallRecordsSync"];
  const compatibilityPluginIds = [
    { alias: "google-gemini-cli", pluginId: "google" },
    { alias: "minimax-portal-auth", pluginId: "minimax" },
  ] as const;

  beforeEach(async () => {
    resetPluginsCliTestState();
    // Resolve after the shared CLI fixture registers its record-IO mock.
    ({ loadInstalledPluginIndexInstallRecordsSync: readInstallRecords } =
      await import("../plugins/installed-plugin-index-record-reader.js"));
    clearPluginMetadataLifecycleCaches();
    inventory.load.mockReset();
    inventory.hostedCatalog.mockReset();
    inventory.hostedCatalog.mockRejectedValue(
      new Error("Toggle must not fetch the hosted catalog"),
    );
    const enable =
      await vi.importActual<typeof import("../plugins/enable.js")>("../plugins/enable.js");
    const slots =
      await vi.importActual<typeof import("../plugins/slots.js")>("../plugins/slots.js");
    enablePluginInConfigMock.mockImplementation((config, pluginId, options) =>
      enable.enableExplicitlySelectedPluginInConfig(
        config as OpenClawConfig,
        pluginId as string,
        options as Parameters<typeof enable.enableExplicitlySelectedPluginInConfig>[2],
      ),
    );
    applyExclusiveSlotSelectionMock.mockImplementation((params) =>
      slots.applyExclusiveSlotSelection(
        params as Parameters<typeof slots.applyExclusiveSlotSelection>[0],
      ),
    );
    mockPluginRegistry([]);
  });

  afterEach(() => {
    expect(inventory.hostedCatalog).not.toHaveBeenCalled();
    clearPluginMetadataLifecycleCaches();
    if (ORIGINAL_OPENCLAW_NIX_MODE === undefined) {
      delete process.env.OPENCLAW_NIX_MODE;
    } else {
      process.env.OPENCLAW_NIX_MODE = ORIGINAL_OPENCLAW_NIX_MODE;
    }
  });

  function mockPluginRegistry(
    ids: string[],
    kinds: Record<string, "memory" | "context-engine"> = {},
  ) {
    inventory.load.mockImplementation(({ config }: { config: OpenClawConfig }) => {
      const installRecords = readInstallRecords();
      const installedManifests = loadPluginManifestRegistryMock({
        installRecords,
      }) as PluginManifestRegistry;
      const plugins = ids.map((id): PluginManifestRecord => {
        const installed = installedManifests.plugins.find((plugin) => plugin.id === id);
        return (
          installed ?? {
            id,
            origin: "bundled",
            rootDir: `/tmp/bundled-${id}`,
            source: `/tmp/bundled-${id}/index.js`,
            manifestPath: `/tmp/bundled-${id}/openclaw.plugin.json`,
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            ...(kinds[id] ? { kind: kinds[id] } : {}),
            legacyPluginIds: compatibilityPluginIds
              .filter((entry) => entry.pluginId === id)
              .map((entry) => entry.alias),
          }
        );
      });
      return {
        source: "derived",
        diagnostics: [],
        manifestRegistry: { plugins, diagnostics: [] },
        snapshot: createTestInstalledPluginIndex({
          policyHash: JSON.stringify(config.plugins ?? {}),
          installRecords,
          plugins: plugins.map((plugin) =>
            recordInstalledPluginIndexInstallOwner(
              {
                pluginId: plugin.id,
                rootDir: plugin.rootDir,
                source: plugin.source,
                manifestPath: plugin.manifestPath,
                manifestHash: "fixture",
                origin: plugin.origin,
                enabled: config.plugins?.entries?.[plugin.id]?.enabled ?? false,
                startup: { sidecar: false, memory: plugin.kind === "memory", agentHarnesses: [] },
                compat: [],
              },
              Object.hasOwn(installRecords, plugin.id) ? plugin.id : undefined,
            ),
          ),
        }),
      };
    });
  }

  function requireFirstWrittenConfig(): OpenClawConfig {
    const call = configWriteMock.mock.calls[0];
    if (!call) {
      throw new Error("expected configWriteMock to be called");
    }
    const [config] = call;
    if (!config) {
      throw new Error("expected configWriteMock to receive a config");
    }
    return config;
  }

  function requirePluginEntries(
    config: OpenClawConfig,
  ): NonNullable<NonNullable<OpenClawConfig["plugins"]>["entries"]> {
    if (!config.plugins?.entries) {
      throw new Error("expected plugin entries in config");
    }
    return config.plugins.entries;
  }

  it("refreshes the persisted plugin registry after enabling a plugin", async () => {
    const sourceConfig = {} as OpenClawConfig;
    const enabledConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig;
    pluginCliConfigMock.mockReturnValue(sourceConfig);
    mockPluginRegistry(["alpha"]);

    await runPluginsCommand(["plugins", "enable", "alpha"]);

    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      sourceConfig: enabledConfig,
      baseHash: "mock",
      writeOptions: expect.objectContaining({
        explicitSetPaths: [["plugins", "entries", "alpha"]],
      }),
    });
    expect(configWriteMock).toHaveBeenCalledWith(enabledConfig);
    expect(refreshPluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: enabledConfig,
        installRecords: {},
        policyPluginIds: ["alpha"],
        reason: "policy-changed",
      }),
    );
    expect(runtimeErrors).toEqual([]);
  });

  it("rejects enabling an unconsented installed plugin without --accept-capabilities", async () => {
    await withTempDir("openclaw-cli-capability-consent-", async (rootDir) => {
      createColdPluginFixture({ rootDir, pluginId: "alpha" });
      const sourceConfig = {
        plugins: { entries: { alpha: { enabled: false } } },
      } as OpenClawConfig;
      pluginCliConfigMock.mockReturnValue(sourceConfig);
      setInstalledPluginIndexInstallRecords({
        alpha: { source: "npm", spec: "@acme/alpha", installPath: rootDir },
      });
      expect(readInstallRecords().alpha?.installPath).toBe(rootDir);
      mockPluginRegistry(["alpha"]);
      await expect(runPluginsCommand(["plugins", "enable", "alpha"])).rejects.toThrow("__exit__:1");

      expect(runtimeErrors.at(-1)).toContain("--accept-capabilities");
      expect(replaceConfigFileMock).not.toHaveBeenCalled();
      expect(configWriteMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      name: "binds explicit approval for a disabled installed plugin",
      enabled: false,
      commandArgs: ["plugins", "enable", "alpha", "--accept-capabilities"],
      expectsConsent: true,
    },
    {
      name: "records explicit capability consent for an already-enabled installed plugin",
      enabled: true,
      commandArgs: ["plugins", "enable", "alpha", "--accept-capabilities"],
      expectsConsent: true,
    },
    {
      name: "preserves no-option re-enable compatibility for an already-enabled installed plugin",
      enabled: true,
      commandArgs: ["plugins", "enable", "alpha"],
      expectsConsent: false,
    },
  ])("$name", async ({ commandArgs, enabled, expectsConsent }) => {
    await withTempDir("openclaw-cli-capability-consent-enabled-", async (rootDir) => {
      const fixture = createColdPluginFixture({ rootDir, pluginId: "alpha" });
      loadPluginManifestRegistryMock.mockReturnValue({
        plugins: [
          recordPluginManifestInstallOwner(
            {
              id: "alpha",
              channels: [fixture.channelId],
              providers: [fixture.providerId],
              cliBackends: [],
              skills: [],
              hooks: [],
              origin: "global",
              rootDir,
              source: fixture.runtimeSource,
              manifestPath: `${rootDir}/openclaw.plugin.json`,
            },
            "alpha",
          ),
        ],
        diagnostics: [],
      });
      const sourceConfig = {
        plugins: { entries: { alpha: { enabled } } },
      } as OpenClawConfig;
      pluginCliConfigMock.mockReturnValue(sourceConfig);
      setInstalledPluginIndexInstallRecords({
        alpha: { source: "npm", spec: "@acme/alpha", installPath: rootDir },
      });
      expect(readInstallRecords().alpha?.installPath).toBe(rootDir);
      mockPluginRegistry(["alpha"]);

      await runPluginsCommand(commandArgs);

      const { resolvePluginArtifactDeclaredSurface } =
        await import("../plugins/capability-artifact.js");
      const { computeDeclaredSurfaceHash } = await import("../plugins/capability-summary.js");
      if (expectsConsent) {
        const acceptedRecord =
          writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock.mock.calls[0]?.[0]?.alpha;
        expect(acceptedRecord?.acceptedSurfaceHash).toBe(
          computeDeclaredSurfaceHash(resolvePluginArtifactDeclaredSurface(rootDir)),
        );
      } else {
        expect(
          writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
        ).not.toHaveBeenCalled();
      }
      expect(replaceConfigFileMock).toHaveBeenCalledOnce();
      expect(promptYesNoMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      policy: "globally disabled plugins",
      plugins: { enabled: false },
      reason: "plugins disabled",
    },
    {
      policy: "a plugin denylist",
      plugins: { deny: ["alpha"] },
      reason: "blocked by denylist",
    },
    {
      policy: "a restrictive plugin allowlist",
      plugins: { allow: ["other-plugin"] },
      reason: "blocked by allowlist",
    },
  ])("fails without mutations when $policy blocks enablement", async ({ plugins, reason }) => {
    await withTempDir("openclaw-cli-blocked-capability-consent-", async (rootDir) => {
      const fixture = createColdPluginFixture({
        rootDir,
        pluginId: "alpha",
        manifest: { kind: "memory" },
      });
      const sourceConfig: OpenClawConfig = {
        plugins: {
          ...plugins,
          entries: { alpha: { enabled: false } },
          slots: { memory: "previous" },
        },
      };
      const originalConfig = structuredClone(sourceConfig);
      const records = {
        alpha: { source: "npm" as const, spec: "@acme/alpha", installPath: rootDir },
      };
      pluginCliConfigMock.mockReturnValue(sourceConfig);
      setInstalledPluginIndexInstallRecords(records);
      loadPluginManifestRegistryMock.mockReturnValue({
        plugins: [
          recordPluginManifestInstallOwner(
            {
              id: "alpha",
              kind: "memory",
              origin: "global",
              rootDir,
              source: fixture.runtimeSource,
              manifestPath: `${rootDir}/openclaw.plugin.json`,
              channels: [fixture.channelId],
              providers: [fixture.providerId],
              cliBackends: [],
              skills: [],
              hooks: [],
            },
            "alpha",
          ),
        ],
        diagnostics: [],
      });
      expect(readInstallRecords().alpha?.installPath).toBe(rootDir);
      mockPluginRegistry(["alpha"]);

      await expect(
        runPluginsCommand(["plugins", "enable", "alpha", "--accept-capabilities"]),
      ).rejects.toThrow("__exit__:1");

      expect(replaceConfigFileMock).not.toHaveBeenCalled();
      expect(configWriteMock).not.toHaveBeenCalled();
      expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
      expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
      expect(readInstallRecords()).toEqual(records);
      expect(sourceConfig).toEqual(originalConfig);
      expect(runtimeErrors).toContain(`Plugin "alpha" could not be enabled (${reason}).`);
      expect(pluginsCliRuntimeLogs).not.toContain(
        `Plugin "alpha" could not be enabled (${reason}).`,
      );
    });
  });

  it("refuses plugin enablement in Nix mode before config mutation", async () => {
    const previous = process.env.OPENCLAW_NIX_MODE;
    process.env.OPENCLAW_NIX_MODE = "1";
    try {
      await expect(runPluginsCommand(["plugins", "enable", "alpha"])).rejects.toThrow(
        "OPENCLAW_NIX_MODE=1",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_NIX_MODE;
      } else {
        process.env.OPENCLAW_NIX_MODE = previous;
      }
    }

    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("refreshes the persisted plugin registry after disabling a plugin", async () => {
    pluginCliConfigMock.mockReturnValue({
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig);
    mockPluginRegistry(["alpha"]);

    await runPluginsCommand(["plugins", "disable", "alpha"]);

    const nextConfig = requireFirstWrittenConfig();
    const entries = requirePluginEntries(nextConfig);
    expect(entries.alpha).toEqual({ enabled: false });
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      sourceConfig: nextConfig,
      baseHash: "mock",
      writeOptions: expect.objectContaining({
        explicitSetPaths: [["plugins", "entries", "alpha"]],
      }),
    });
    expect(refreshPluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: nextConfig,
        installRecords: {},
        policyPluginIds: ["alpha"],
        reason: "policy-changed",
      }),
    );
    expect(runtimeErrors).toEqual([]);
  });

  it.each(compatibilityPluginIds)(
    "enables compatibility id $alias through canonical plugin $pluginId",
    async ({ alias, pluginId }) => {
      const sourceConfig = {} as OpenClawConfig;
      const enabledConfig = {
        plugins: {
          entries: {
            [pluginId]: { enabled: true },
          },
        },
      } as OpenClawConfig;
      pluginCliConfigMock.mockReturnValue(sourceConfig);
      mockPluginRegistry([pluginId]);

      await runPluginsCommand(["plugins", "enable", alias]);

      expect(replaceConfigFileMock).toHaveBeenCalledWith({
        sourceConfig: enabledConfig,
        baseHash: "mock",
        writeOptions: expect.objectContaining({
          explicitSetPaths: [["plugins", "entries", pluginId]],
        }),
      });
      expect(configWriteMock).toHaveBeenCalledWith(enabledConfig);
    },
  );

  it.each(compatibilityPluginIds)(
    "disables compatibility id $alias through canonical plugin $pluginId",
    async ({ alias, pluginId }) => {
      pluginCliConfigMock.mockReturnValue({
        plugins: {
          entries: {
            [pluginId]: { enabled: true },
          },
        },
      } as OpenClawConfig);
      mockPluginRegistry([pluginId]);

      await runPluginsCommand(["plugins", "disable", alias]);

      const nextConfig = requireFirstWrittenConfig();
      const entries = requirePluginEntries(nextConfig);
      expect(entries[pluginId]).toEqual({ enabled: false });
      expect(entries[alias]).toBeUndefined();
      expect(replaceConfigFileMock).toHaveBeenCalledWith({
        sourceConfig: nextConfig,
        baseHash: "mock",
        writeOptions: expect.objectContaining({
          explicitSetPaths: [["plugins", "entries", pluginId]],
        }),
      });
    },
  );

  it.each(
    ["enable", "disable"].flatMap((command) =>
      ["missing-plugin", "alpha-provider", "alpha-channel"].map((id) => ({ command, id })),
    ),
  )("rejects $command for undiscovered plugin id $id", async ({ command, id }) => {
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [
        {
          id: "alpha",
          origin: "bundled",
          rootDir: "/tmp/bundled-alpha",
          source: "/tmp/bundled-alpha/index.js",
          manifestPath: "/tmp/bundled-alpha/openclaw.plugin.json",
          providers: ["alpha-provider"],
          channels: ["alpha-channel"],
          cliBackends: [],
          skills: [],
          hooks: [],
        },
      ],
      diagnostics: [],
    });
    mockPluginRegistry(["alpha"]);

    await expect(runPluginsCommand(["plugins", command, id])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors).toContain(
      `Plugin not found: ${id}. Run \`openclaw plugins list\` to see installed plugins, or \`openclaw plugins search ${id}\` to look for installable plugins.`,
    );
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
  });

  it("persists exclusive-slot selection and reports its warning without fetching a hosted catalog", async () => {
    pluginCliConfigMock.mockReturnValue({
      plugins: {
        entries: { alpha: { enabled: false }, previous: { enabled: true } },
        slots: { memory: "previous" },
      },
    });
    mockPluginRegistry(["alpha", "previous"], { alpha: "memory", previous: "memory" });

    await runPluginsCommand(["plugins", "enable", "alpha"]);

    expect(requireFirstWrittenConfig().plugins).toMatchObject({
      entries: { alpha: { enabled: true } },
      slots: { memory: "alpha" },
    });
    expect(pluginsCliRuntimeLogs.join("\n")).toContain(
      'Exclusive slot "memory" switched from "previous" to "alpha".',
    );
    expect(inventory.hostedCatalog).not.toHaveBeenCalled();
  });

  it("does not create a channel config when disabling a channel plugin by policy", async () => {
    pluginCliConfigMock.mockReturnValue({} as OpenClawConfig);
    mockPluginRegistry(["twitch"]);

    await runPluginsCommand(["plugins", "disable", "twitch"]);

    const nextConfig = requireFirstWrittenConfig();
    const entries = requirePluginEntries(nextConfig);
    expect(entries.twitch).toEqual({ enabled: false });
    expect(nextConfig.channels?.twitch).toBeUndefined();
  });
});
