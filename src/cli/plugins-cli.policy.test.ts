// Plugins CLI policy tests cover plugin command policy checks and warnings.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { recordPluginManifestInstallOwner } from "../plugins/manifest-install-owner.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  buildPluginRegistrySnapshotReportMock,
  enablePluginInConfigMock,
  loadPluginManifestRegistryMock,
  pluginCliConfigMock,
  pluginRegistryRefreshInputs,
  replaceConfigFileMock,
  refreshPluginRegistryMock,
  resetPluginsCliTestState,
  pluginsCliRuntimeLogs,
  promptYesNoMock,
  runPluginsCommand,
  setInstalledPluginIndexInstallRecords,
  configWriteMock,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
} from "./plugins-cli-test-helpers.js";

const ORIGINAL_OPENCLAW_NIX_MODE = process.env.OPENCLAW_NIX_MODE;

describe("plugins cli policy mutations", () => {
  const compatibilityPluginIds = [
    {
      alias: "google-gemini-cli",
      pluginId: "google",
      manifestMetadata: { providers: ["google", "google-gemini-cli"] },
    },
    {
      alias: "minimax-portal-auth",
      pluginId: "minimax",
      manifestMetadata: { legacyPluginIds: ["minimax-portal-auth"] },
    },
  ];

  beforeEach(() => {
    resetPluginsCliTestState();
  });

  afterEach(() => {
    if (ORIGINAL_OPENCLAW_NIX_MODE === undefined) {
      delete process.env.OPENCLAW_NIX_MODE;
    } else {
      process.env.OPENCLAW_NIX_MODE = ORIGINAL_OPENCLAW_NIX_MODE;
    }
  });

  function mockPluginRegistry(
    ids: string[],
    manifestMetadata: Partial<Pick<PluginManifestRecord, "providers" | "legacyPluginIds">> = {},
  ) {
    loadPluginManifestRegistryMock.mockImplementation((input: unknown) => {
      const records =
        (input as { installRecords?: Record<string, PluginInstallRecord> })?.installRecords ?? {};
      return {
        plugins: ids.map((id) => {
          const install = records[id];
          const rootDir = install?.installPath ?? install?.sourcePath ?? `/tmp/${id}`;
          const manifest = {
            id,
            rootDir,
            source: `${rootDir}/index.js`,
            manifestPath: `${rootDir}/openclaw.plugin.json`,
            origin: install ? ("global" as const) : ("bundled" as const),
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            ...manifestMetadata,
          };
          return install ? recordPluginManifestInstallOwner(manifest, id) : manifest;
        }),
        diagnostics: [],
      };
    });
    buildPluginRegistrySnapshotReportMock.mockReturnValue({
      plugins: ids.map((id) => ({ id })),
      diagnostics: [],
      registrySource: "derived",
      registryDiagnostics: [],
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
    enablePluginInConfigMock.mockReturnValue({
      config: enabledConfig,
      enabled: true,
      pluginId: "alpha",
    });
    mockPluginRegistry(["alpha"]);

    await runPluginsCommand(["plugins", "enable", "alpha"]);

    expect(enablePluginInConfigMock).toHaveBeenCalledWith(sourceConfig, "alpha", {
      updateChannelConfig: false,
    });
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig: enabledConfig,
      baseHash: "mock",
      writeOptions: expect.objectContaining({
        expectedConfigPath: "/tmp/openclaw-config.json5",
        ownedConfigPathForWrite: "/tmp/openclaw-config.json5",
        explicitSetPaths: [["plugins", "entries", "alpha"]],
      }),
    });
    expect(configWriteMock).toHaveBeenCalledWith(enabledConfig);
    expect(pluginRegistryRefreshInputs()).toContainEqual({
      config: enabledConfig,
      installRecords: {},
      policyPluginIds: ["alpha"],
      reason: "policy-changed",
    });
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
      mockPluginRegistry(["alpha"]);
      await expect(runPluginsCommand(["plugins", "enable", "alpha"])).rejects.toThrow(
        "--accept-capabilities",
      );
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
      buildPluginRegistrySnapshotReportMock.mockReturnValue({
        plugins: [{ id: "alpha", enabled }],
        diagnostics: [],
        registrySource: "derived",
        registryDiagnostics: [],
      });

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
  ])("fails without mutations when $policy blocks enablement", async ({ plugins, reason }) => {
    const sourceConfig = { plugins } as OpenClawConfig;
    pluginCliConfigMock.mockReturnValue(sourceConfig);
    enablePluginInConfigMock.mockReturnValue({
      config: sourceConfig,
      enabled: false,
      pluginId: "alpha",
      reason,
    });
    mockPluginRegistry(["alpha"]);

    await expect(runPluginsCommand(["plugins", "enable", "alpha"])).rejects.toThrow(
      `plugin "alpha" could not be enabled (${reason})`,
    );

    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
    expect(pluginsCliRuntimeLogs).not.toContain(`Plugin "alpha" could not be enabled (${reason}).`);
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

    expect(enablePluginInConfigMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("treats explicit enable as trust for the selected installed plugin", async () => {
    pluginCliConfigMock.mockReturnValue({ plugins: { allow: ["other-plugin"] } });
    mockPluginRegistry(["alpha"]);

    await runPluginsCommand(["plugins", "enable", "alpha"]);

    expect(configWriteMock).toHaveBeenCalledWith({
      plugins: { allow: ["other-plugin", "alpha"] },
    });
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
      nextConfig,
      baseHash: "mock",
      writeOptions: expect.objectContaining({
        expectedConfigPath: "/tmp/openclaw-config.json5",
        ownedConfigPathForWrite: "/tmp/openclaw-config.json5",
        explicitSetPaths: [["plugins", "entries", "alpha"]],
      }),
    });
    expect(pluginRegistryRefreshInputs()).toContainEqual({
      config: nextConfig,
      installRecords: {},
      policyPluginIds: ["alpha"],
      reason: "policy-changed",
    });
  });

  it.each(compatibilityPluginIds)(
    "enables compatibility id $alias through canonical plugin $pluginId",
    async ({ alias, pluginId, manifestMetadata }) => {
      const sourceConfig = {} as OpenClawConfig;
      const enabledConfig = {
        plugins: {
          entries: {
            [pluginId]: { enabled: true },
          },
        },
      } as OpenClawConfig;
      pluginCliConfigMock.mockReturnValue(sourceConfig);
      enablePluginInConfigMock.mockReturnValue({
        config: enabledConfig,
        enabled: true,
        pluginId,
      });
      mockPluginRegistry([pluginId], manifestMetadata);

      await runPluginsCommand(["plugins", "enable", alias]);

      expect(enablePluginInConfigMock).toHaveBeenCalledWith(sourceConfig, pluginId, {
        updateChannelConfig: false,
      });
      expect(replaceConfigFileMock).toHaveBeenCalledWith({
        nextConfig: enabledConfig,
        baseHash: "mock",
        writeOptions: expect.objectContaining({
          expectedConfigPath: "/tmp/openclaw-config.json5",
          ownedConfigPathForWrite: "/tmp/openclaw-config.json5",
          explicitSetPaths: [["plugins", "entries", pluginId]],
        }),
      });
      expect(configWriteMock).toHaveBeenCalledWith(enabledConfig);
    },
  );

  it.each(compatibilityPluginIds)(
    "disables compatibility id $alias through canonical plugin $pluginId",
    async ({ alias, pluginId, manifestMetadata }) => {
      pluginCliConfigMock.mockReturnValue({
        plugins: {
          entries: {
            [pluginId]: { enabled: true },
          },
        },
      } as OpenClawConfig);
      mockPluginRegistry([pluginId], manifestMetadata);

      await runPluginsCommand(["plugins", "disable", alias]);

      const nextConfig = requireFirstWrittenConfig();
      const entries = requirePluginEntries(nextConfig);
      expect(entries[pluginId]).toEqual({ enabled: false });
      expect(entries[alias]).toBeUndefined();
      expect(replaceConfigFileMock).toHaveBeenCalledWith({
        nextConfig,
        baseHash: "mock",
        writeOptions: expect.objectContaining({
          expectedConfigPath: "/tmp/openclaw-config.json5",
          ownedConfigPathForWrite: "/tmp/openclaw-config.json5",
          explicitSetPaths: [["plugins", "entries", pluginId]],
        }),
      });
    },
  );

  it.each(["enable", "disable"] as const)(
    "rejects %s for a plugin that is not discovered",
    async (command) => {
      mockPluginRegistry(["alpha"]);

      await expect(runPluginsCommand(["plugins", command, "missing-plugin"])).rejects.toThrow(
        "plugin not installed: missing-plugin",
      );
      expect(enablePluginInConfigMock).not.toHaveBeenCalled();
      expect(configWriteMock).not.toHaveBeenCalled();
      expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
    },
  );

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
