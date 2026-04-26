import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  enablePluginInConfig,
  refreshPluginRegistry,
  resetPluginsCliTestState,
  writeConfigFile,
  writePersistedInstalledPluginIndexInstallRecords,
} from "./plugins-cli-test-helpers.js";

describe("persistPluginInstall", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  it("adds installed plugins to restrictive allowlists before enabling", async () => {
    const { persistPluginInstall } = await import("./plugins-install-persist.js");
    const baseConfig = {
      plugins: {
        allow: ["memory-core"],
      },
    } as OpenClawConfig;
    const enabledConfig = {
      plugins: {
        allow: ["alpha", "memory-core"],
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig;
    enablePluginInConfig.mockImplementation((...args: unknown[]) => {
      const [cfg, pluginId] = args as [OpenClawConfig, string];
      expect(pluginId).toBe("alpha");
      expect(cfg.plugins?.allow).toEqual(["alpha", "memory-core"]);
      return { config: enabledConfig };
    });

    const next = await persistPluginInstall({
      config: baseConfig,
      pluginId: "alpha",
      install: {
        source: "npm",
        spec: "alpha@1.0.0",
        installPath: "/tmp/alpha",
      },
    });

    expect(next).toEqual(enabledConfig);
    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({
      alpha: expect.objectContaining({
        source: "npm",
        spec: "alpha@1.0.0",
        installPath: "/tmp/alpha",
      }),
    });
    expect(writeConfigFile).toHaveBeenCalledWith(enabledConfig);
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: enabledConfig,
      installRecords: {
        alpha: expect.objectContaining({
          source: "npm",
          spec: "alpha@1.0.0",
          installPath: "/tmp/alpha",
        }),
      },
      reason: "source-changed",
    });
  });
});
