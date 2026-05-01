import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyExclusiveSlotSelection,
  buildPluginDiagnosticsReport,
  enablePluginInConfig,
  loadPluginManifestRegistry,
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

  it("scopes runtime kind lookup to the selected plugin when metadata omits kind", async () => {
    const { persistPluginInstall } = await import("./plugins-install-persist.js");
    const baseConfig = {
      plugins: {
        entries: {
          "legacy-memory-a": { enabled: true },
        },
      },
    } as OpenClawConfig;
    const enabledConfig = {
      plugins: {
        entries: {
          "legacy-memory-a": { enabled: true },
          "legacy-memory": { enabled: true },
        },
      },
    } as OpenClawConfig;
    enablePluginInConfig.mockReturnValue({ config: enabledConfig });
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "legacy-memory" }],
      diagnostics: [],
    });
    buildPluginDiagnosticsReport.mockReturnValueOnce({
      plugins: [{ id: "legacy-memory", kind: "memory" }],
      diagnostics: [],
    });
    applyExclusiveSlotSelection.mockImplementation(((params: {
      config: OpenClawConfig;
      selectedId: string;
      selectedKind?: string;
      registry?: { plugins: Array<{ id: string; kind?: string }> };
    }) => {
      expect(params.selectedId).toBe("legacy-memory");
      expect(params.selectedKind).toBe("memory");
      expect(params.registry?.plugins).toEqual([{ id: "legacy-memory", kind: "memory" }]);
      return {
        config: {
          ...params.config,
          plugins: {
            ...params.config.plugins,
            slots: {
              ...params.config.plugins?.slots,
              memory: "legacy-memory",
            },
          },
        },
        warnings: [],
        changed: true,
      };
    }) as (...args: unknown[]) => unknown);

    const next = await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
      },
      pluginId: "legacy-memory",
      install: {
        source: "path",
        sourcePath: "/tmp/legacy-memory",
        installPath: "/tmp/legacy-memory",
      },
    });

    expect(buildPluginDiagnosticsReport).toHaveBeenCalledTimes(1);
    expect(buildPluginDiagnosticsReport).toHaveBeenCalledWith({
      config: enabledConfig,
      onlyPluginIds: ["legacy-memory"],
    });
    expect(loadPluginManifestRegistry).toHaveBeenCalledWith({
      config: enabledConfig,
      includeDisabled: true,
      pluginIds: ["legacy-memory"],
    });
    expect(next.plugins?.entries?.["legacy-memory-a"]?.enabled).toBe(true);
    expect(next.plugins?.slots?.memory).toBe("legacy-memory");
  });

  it("uses cold metadata for manifest-kind slot selection without loading runtime siblings", async () => {
    const { persistPluginInstall } = await import("./plugins-install-persist.js");
    const baseConfig = {
      plugins: {
        entries: {
          "legacy-memory-a": { enabled: true },
        },
      },
    } as OpenClawConfig;
    const enabledConfig = {
      plugins: {
        entries: {
          "legacy-memory-a": { enabled: true },
          "memory-b": { enabled: true },
        },
      },
    } as OpenClawConfig;
    enablePluginInConfig.mockReturnValue({ config: enabledConfig });
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "memory-b", kind: "memory" }],
      diagnostics: [],
    });
    applyExclusiveSlotSelection.mockImplementation(((params: {
      config: OpenClawConfig;
      selectedId: string;
      selectedKind?: string;
      registry?: { plugins: Array<{ id: string; kind?: string }> };
    }) => {
      expect(params.selectedId).toBe("memory-b");
      expect(params.selectedKind).toBe("memory");
      expect(params.registry?.plugins).toEqual([{ id: "memory-b", kind: "memory" }]);
      return {
        config: {
          ...params.config,
          plugins: {
            ...params.config.plugins,
            slots: {
              ...params.config.plugins?.slots,
              memory: "memory-b",
            },
          },
        },
        warnings: [],
        changed: true,
      };
    }) as (...args: unknown[]) => unknown);

    const next = await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
      },
      pluginId: "memory-b",
      install: {
        source: "path",
        sourcePath: "/tmp/memory-b",
        installPath: "/tmp/memory-b",
      },
    });

    expect(buildPluginDiagnosticsReport).not.toHaveBeenCalled();
    expect(loadPluginManifestRegistry).toHaveBeenCalledWith({
      config: enabledConfig,
      includeDisabled: true,
      pluginIds: ["memory-b"],
    });
    expect(next.plugins?.entries?.["legacy-memory-a"]?.enabled).toBe(true);
    expect(next.plugins?.slots?.memory).toBe("memory-b");
  });

  it("does not load every plugin runtime for non-slot installs without manifest kind", async () => {
    const { persistPluginInstall } = await import("./plugins-install-persist.js");
    const baseConfig = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledConfig = {
      plugins: {
        entries: {
          plain: { enabled: true },
        },
      },
    } as OpenClawConfig;
    enablePluginInConfig.mockReturnValue({ config: enabledConfig });
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "plain" }],
      diagnostics: [],
    });
    buildPluginDiagnosticsReport.mockReturnValue({
      plugins: [{ id: "plain" }],
      diagnostics: [],
    });
    applyExclusiveSlotSelection.mockReturnValue({
      config: enabledConfig,
      warnings: [],
      changed: false,
    });

    const next = await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
      },
      pluginId: "plain",
      install: {
        source: "path",
        sourcePath: "/tmp/plain",
        installPath: "/tmp/plain",
      },
    });

    expect(buildPluginDiagnosticsReport).toHaveBeenCalledTimes(1);
    expect(buildPluginDiagnosticsReport).toHaveBeenCalledWith({
      config: enabledConfig,
      onlyPluginIds: ["plain"],
    });
    expect(loadPluginManifestRegistry).toHaveBeenCalledWith({
      config: enabledConfig,
      includeDisabled: true,
      pluginIds: ["plain"],
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
