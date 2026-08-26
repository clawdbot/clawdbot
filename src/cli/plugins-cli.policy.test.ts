// Plugins CLI policy tests cover plugin command policy checks and warnings.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  buildPluginRegistrySnapshotReportMock,
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

const ORIGINAL_OPENCLAW_NIX_MODE = process.env.OPENCLAW_NIX_MODE;

describe("plugins cli policy mutations", () => {
  const compatibilityPluginIds = [
    { alias: "google-gemini-cli", pluginId: "google" },
    { alias: "minimax-portal-auth", pluginId: "minimax" },
  ] as const;

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

  function mockPluginRegistry(ids: string[]) {
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
      writeOptions: {
        explicitSetPaths: [["plugins", "entries", "alpha"]],
      },
    });
    expect(configWriteMock).toHaveBeenCalledWith(enabledConfig);
    expect(refreshPluginRegistryMock).toHaveBeenCalledWith({
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
      await expect(runPluginsCommand(["plugins", "enable", "alpha"])).rejects.toThrow("__exit__:1");

      expect(runtimeErrors.at(-1)).toContain("--accept-capabilities");
      expect(replaceConfigFileMock).not.toHaveBeenCalled();
      expect(configWriteMock).not.toHaveBeenCalled();
    });
  });

  it("binds explicit enablement approval to the installed artifact's reviewed surface", async () => {
    await withTempDir("openclaw-cli-capability-review-", async (rootDir) => {
      const fixture = createColdPluginFixture({ rootDir, pluginId: "alpha" });
      const { recordPluginManifestInstallOwner } =
        await import("../plugins/manifest-install-owner.js");
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
        plugins: { entries: { alpha: { enabled: false } } },
      } as OpenClawConfig;
      pluginCliConfigMock.mockReturnValue(sourceConfig);
      setInstalledPluginIndexInstallRecords({
        alpha: { source: "npm", spec: "@acme/alpha", installPath: rootDir },
      });
      mockPluginRegistry(["alpha"]);

      await runPluginsCommand(["plugins", "enable", "alpha", "--accept-capabilities"]);

      const { computeDeclaredSurfaceHash, resolvePluginArtifactDeclaredSurface } =
        await import("../plugins/capability-consent.js");
      const acceptedRecord =
        writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock.mock.calls[0]?.[0]?.alpha;
      expect(acceptedRecord?.acceptedSurfaceHash).toBe(
        computeDeclaredSurfaceHash(resolvePluginArtifactDeclaredSurface(rootDir)),
      );
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
    const sourceConfig = { plugins } as OpenClawConfig;
    pluginCliConfigMock.mockReturnValue(sourceConfig);
    enablePluginInConfigMock.mockReturnValue({
      config: sourceConfig,
      enabled: false,
      pluginId: "alpha",
      reason,
    });
    mockPluginRegistry(["alpha"]);

    await expect(runPluginsCommand(["plugins", "enable", "alpha"])).rejects.toThrow("__exit__:1");

    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
    expect(runtimeErrors).toContain(`Plugin "alpha" could not be enabled (${reason}).`);
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
      writeOptions: {
        explicitSetPaths: [["plugins", "entries", "alpha"]],
      },
    });
    expect(refreshPluginRegistryMock).toHaveBeenCalledWith({
      config: nextConfig,
      installRecords: {},
      policyPluginIds: ["alpha"],
      reason: "policy-changed",
    });
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
      enablePluginInConfigMock.mockReturnValue({
        config: enabledConfig,
        enabled: true,
        pluginId,
      });
      mockPluginRegistry([pluginId]);

      await runPluginsCommand(["plugins", "enable", alias]);

      expect(enablePluginInConfigMock).toHaveBeenCalledWith(sourceConfig, pluginId, {
        updateChannelConfig: false,
      });
      expect(replaceConfigFileMock).toHaveBeenCalledWith({
        nextConfig: enabledConfig,
        baseHash: "mock",
        writeOptions: {
          explicitSetPaths: [["plugins", "entries", pluginId]],
        },
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
        nextConfig,
        baseHash: "mock",
        writeOptions: {
          explicitSetPaths: [["plugins", "entries", pluginId]],
        },
      });
    },
  );

  it.each(["enable", "disable"] as const)(
    "rejects %s for a plugin that is not discovered",
    async (command) => {
      mockPluginRegistry(["alpha"]);

      await expect(runPluginsCommand(["plugins", command, "missing-plugin"])).rejects.toThrow(
        "__exit__:1",
      );

      expect(runtimeErrors).toContain(
        "Plugin not found: missing-plugin. Run `openclaw plugins list` to see installed plugins, or `openclaw plugins search missing-plugin` to look for installable plugins.",
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
