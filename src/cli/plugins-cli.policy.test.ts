import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildPluginRegistrySnapshotReport,
  enablePluginInConfig,
  loadConfig,
  refreshPluginRegistry,
  resetPluginsCliTestState,
  runtimeErrors,
  runPluginsCommand,
  writeConfigFile,
} from "./plugins-cli-test-helpers.js";

describe("plugins cli policy mutations", () => {
  const compatibilityPluginIds = [
    { alias: "openai-codex", pluginId: "openai" },
    { alias: "google-gemini-cli", pluginId: "google" },
    { alias: "minimax-portal-auth", pluginId: "minimax" },
  ] as const;

  beforeEach(() => {
    resetPluginsCliTestState();
  });

  function mockPluginRegistry(ids: string[]) {
    buildPluginRegistrySnapshotReport.mockReturnValue({
      plugins: ids.map((id) => ({ id })),
      diagnostics: [],
      registrySource: "derived",
      registryDiagnostics: [],
    });
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
    loadConfig.mockReturnValue(sourceConfig);
    enablePluginInConfig.mockReturnValue({
      config: enabledConfig,
      enabled: true,
      pluginId: "alpha",
    });
    mockPluginRegistry(["alpha"]);

    await runPluginsCommand(["plugins", "enable", "alpha"]);

    expect(enablePluginInConfig).toHaveBeenCalledWith(sourceConfig, "alpha", {
      updateChannelConfig: false,
    });
    expect(writeConfigFile).toHaveBeenCalledWith(enabledConfig);
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: enabledConfig,
      installRecords: {},
      policyPluginIds: ["alpha"],
      reason: "policy-changed",
    });
  });

  it("refreshes the persisted plugin registry after disabling a plugin", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig);
    mockPluginRegistry(["alpha"]);

    await runPluginsCommand(["plugins", "disable", "alpha"]);

    const nextConfig = writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig;
    expect(nextConfig.plugins?.entries?.alpha?.enabled).toBe(false);
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
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
      loadConfig.mockReturnValue(sourceConfig);
      enablePluginInConfig.mockReturnValue({
        config: enabledConfig,
        enabled: true,
      });
      mockPluginRegistry([pluginId]);

      await runPluginsCommand(["plugins", "enable", alias]);

      expect(enablePluginInConfig).toHaveBeenCalledWith(sourceConfig, pluginId, {
        updateChannelConfig: false,
      });
      expect(writeConfigFile).toHaveBeenCalledWith(enabledConfig);
    },
  );

  it.each(compatibilityPluginIds)(
    "disables compatibility id $alias through canonical plugin $pluginId",
    async ({ alias, pluginId }) => {
      loadConfig.mockReturnValue({
        plugins: {
          entries: {
            [pluginId]: { enabled: true },
          },
        },
      } as OpenClawConfig);
      mockPluginRegistry([pluginId]);

      await runPluginsCommand(["plugins", "disable", alias]);

      const nextConfig = writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig;
      expect(nextConfig.plugins?.entries?.[pluginId]?.enabled).toBe(false);
      expect(nextConfig.plugins?.entries?.[alias]).toBeUndefined();
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
        "Plugin not found: missing-plugin. Run `openclaw plugins list` to see installed plugins.",
      );
      expect(enablePluginInConfig).not.toHaveBeenCalled();
      expect(writeConfigFile).not.toHaveBeenCalled();
      expect(refreshPluginRegistry).not.toHaveBeenCalled();
    },
  );

  it("does not create a channel config when disabling a channel plugin by policy", async () => {
    loadConfig.mockReturnValue({} as OpenClawConfig);
    mockPluginRegistry(["twitch"]);

    await runPluginsCommand(["plugins", "disable", "twitch"]);

    const nextConfig = writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig;
    expect(nextConfig.plugins?.entries?.twitch?.enabled).toBe(false);
    expect(nextConfig.channels?.twitch).toBeUndefined();
  });
});
