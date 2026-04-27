import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyExclusiveSlotSelection,
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
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
      },
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

  it("removes stale denylist entries before enabling installed plugins", async () => {
    const { persistPluginInstall } = await import("./plugins-install-persist.js");
    const baseConfig = {
      plugins: {
        deny: ["alpha", "other"],
      },
    } as OpenClawConfig;
    const enabledConfig = {
      plugins: {
        deny: ["other"],
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig;
    enablePluginInConfig.mockImplementation((...args: unknown[]) => {
      const [cfg, pluginId] = args as [OpenClawConfig, string];
      expect(pluginId).toBe("alpha");
      expect(cfg.plugins?.deny).toEqual(["other"]);
      return { config: enabledConfig };
    });

    const next = await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
      },
      pluginId: "alpha",
      install: {
        source: "npm",
        spec: "alpha@1.0.0",
        installPath: "/tmp/alpha",
      },
    });

    expect(next).toEqual(enabledConfig);
  });

  it("can persist an install record without enabling a plugin that needs config first", async () => {
    const { persistPluginInstall } = await import("./plugins-install-persist.js");
    const baseConfig = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;

    const next = await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
      },
      pluginId: "memory-lancedb",
      enable: false,
      install: {
        source: "path",
        spec: "memory-lancedb",
        sourcePath: "/app/dist/extensions/memory-lancedb",
        installPath: "/app/dist/extensions/memory-lancedb",
      },
    });

    expect(next).toEqual(baseConfig);
    expect(enablePluginInConfig).not.toHaveBeenCalled();
    expect(applyExclusiveSlotSelection).not.toHaveBeenCalled();
    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({
      "memory-lancedb": expect.objectContaining({
        source: "path",
        sourcePath: "/app/dist/extensions/memory-lancedb",
      }),
    });
    expect(writeConfigFile).toHaveBeenCalledWith(baseConfig);
  });

  it("does not add disabled installs to restrictive allowlists", async () => {
    const { persistPluginInstall } = await import("./plugins-install-persist.js");
    const baseConfig = {
      plugins: {
        allow: ["memory-core"],
        deny: ["memory-lancedb"],
      },
    } as OpenClawConfig;

    const next = await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
      },
      pluginId: "memory-lancedb",
      enable: false,
      install: {
        source: "path",
        spec: "memory-lancedb",
        sourcePath: "/app/dist/extensions/memory-lancedb",
        installPath: "/app/dist/extensions/memory-lancedb",
      },
    });

    expect(next.plugins?.allow).toEqual(["memory-core"]);
    expect(next.plugins?.deny).toEqual(["memory-lancedb"]);
    expect(next.plugins?.entries?.["memory-lancedb"]).toBeUndefined();
  });
});
