import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyExclusiveSlotSelection,
  buildPluginDiagnosticsReport,
  buildPluginSnapshotReport,
  clearPluginRegistryLoadCache,
  enablePluginInConfig,
  loadPluginManifestRegistry,
  planPluginUninstall,
  replaceConfigFile,
  refreshPluginRegistry,
  resetPluginsCliTestState,
  runtimeLogs,
  setInstalledPluginIndexInstallRecords,
  writeConfigFile,
  writePersistedInstalledPluginIndexInstallRecords,
  applyPluginUninstallDirectoryRemoval,
} from "./plugins-cli-test-helpers.js";

function requireMockCallArg(
  mockFn: { mock: { calls: unknown[][] } },
  label: string,
  index = 0,
): Record<string, unknown> {
  const arg = mockFn.mock.calls[index]?.[0] as Record<string, unknown> | undefined;
  if (!arg) {
    throw new Error(`expected ${label} call #${index + 1}`);
  }
  return arg;
}

function expectRuntimeLogIncludes(fragment: string) {
  expect(runtimeLogs.join("\n")).toContain(fragment);
}

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
    const persistedRecords = requireMockCallArg(
      writePersistedInstalledPluginIndexInstallRecords,
      "writePersistedInstalledPluginIndexInstallRecords",
    );
    expect(persistedRecords.alpha).toEqual({
      source: "npm",
      spec: "alpha@1.0.0",
      installPath: "/tmp/alpha",
      installedAt: "2026-04-25T00:00:00.000Z",
    });
    expect(writeConfigFile).toHaveBeenCalledWith(enabledConfig);
    expect(replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: enabledConfig,
      baseHash: "config-1",
      writeOptions: {
        afterWrite: { mode: "restart", reason: "plugin source changed" },
        unsetPaths: [["plugins", "installs"]],
      },
    });
    const refreshParams = requireMockCallArg(refreshPluginRegistry, "refreshPluginRegistry");
    expect(refreshParams.config).toBe(enabledConfig);
    expect(refreshParams.reason).toBe("source-changed");
    expect((refreshParams.installRecords as Record<string, unknown>).alpha).toEqual({
      source: "npm",
      spec: "alpha@1.0.0",
      installPath: "/tmp/alpha",
      installedAt: "2026-04-25T00:00:00.000Z",
    });
    expect(clearPluginRegistryLoadCache).toHaveBeenCalledTimes(1);
  });

  it("persists installs even when runtime cache invalidation fails", async () => {
    const { persistPluginInstall } = await import("./plugins-install-persist.js");
    const baseConfig = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig;
    enablePluginInConfig.mockReturnValue({ config: enabledConfig });
    clearPluginRegistryLoadCache.mockImplementation(() => {
      throw new Error("cache unavailable");
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
    expect(refreshPluginRegistry).toHaveBeenCalledTimes(1);
    expectRuntimeLogIncludes("Plugin runtime cache invalidation failed");
  });

  it("removes a replaced managed install directory before refreshing the registry", async () => {
    const { persistPluginInstall } = await import("./plugins-install-persist.js");
    const baseConfig = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledConfig = {
      plugins: {
        entries: {
          codex: { enabled: true },
        },
      },
    } as OpenClawConfig;
    enablePluginInConfig.mockReturnValue({ config: enabledConfig });
    setInstalledPluginIndexInstallRecords({
      codex: {
        source: "clawhub",
        spec: "clawhub:@openclaw/codex",
        installPath: "/tmp/openclaw/extensions/codex",
      },
    });
    planPluginUninstall.mockReturnValueOnce({
      ok: true,
      config: {} as OpenClawConfig,
      pluginId: "codex",
      actions: {
        entry: false,
        install: true,
        allowlist: false,
        denylist: false,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: false,
        channelConfig: false,
        directory: false,
      },
      directoryRemoval: {
        target: "/tmp/openclaw/extensions/codex",
      },
    });
    applyPluginUninstallDirectoryRemoval.mockResolvedValueOnce({
      directoryRemoved: true,
      warnings: [],
    });

    await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
      },
      pluginId: "codex",
      install: {
        source: "npm",
        spec: "@openclaw/codex",
        installPath: "/tmp/openclaw/npm/node_modules/@openclaw/codex",
      },
    });

    expect(planPluginUninstall).toHaveBeenCalledWith({
      config: {
        plugins: {
          installs: {
            codex: {
              source: "clawhub",
              spec: "clawhub:@openclaw/codex",
              installPath: "/tmp/openclaw/extensions/codex",
            },
          },
        },
      },
      pluginId: "codex",
      deleteFiles: true,
    });
    expect(applyPluginUninstallDirectoryRemoval).toHaveBeenCalledWith({
      target: "/tmp/openclaw/extensions/codex",
    });
    const cleanupOrder =
      applyPluginUninstallDirectoryRemoval.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    const refreshOrder = refreshPluginRegistry.mock.invocationCallOrder[0] ?? 0;
    expect(cleanupOrder).toBeLessThan(refreshOrder);
    expect(runtimeLogs.join("\n")).toContain(
      "Removed previous plugin install directory: /tmp/openclaw/extensions/codex",
    );
  });

  it("preserves replaced install directories when the new install path overlaps", async () => {
    const { persistPluginInstall } = await import("./plugins-install-persist.js");
    const baseConfig = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledConfig = {
      plugins: {
        entries: {
          codex: { enabled: true },
        },
      },
    } as OpenClawConfig;
    enablePluginInConfig.mockReturnValue({ config: enabledConfig });
    setInstalledPluginIndexInstallRecords({
      codex: {
        source: "npm",
        spec: "@openclaw/codex",
        installPath: "/tmp/openclaw/npm/node_modules/@openclaw/codex",
      },
    });

    await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
      },
      pluginId: "codex",
      install: {
        source: "npm",
        spec: "@openclaw/codex@latest",
        installPath: "/tmp/openclaw/npm/node_modules/@openclaw/codex",
      },
    });

    expect(planPluginUninstall).not.toHaveBeenCalled();
    expect(applyPluginUninstallDirectoryRemoval).not.toHaveBeenCalled();
  });

  it("warns when an installed npm plugin remains shadowed by a config-selected source", async () => {
    const { persistPluginInstall } = await import("./plugins-install-persist.js");
    const baseConfig = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledConfig = {
      plugins: {
        entries: {
          discord: { enabled: true },
        },
      },
    } as OpenClawConfig;
    enablePluginInConfig.mockReturnValue({ config: enabledConfig });
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "config",
          source: "/tmp/openclaw-upstream/extensions/discord/index.ts",
          status: "error",
        },
      ],
      diagnostics: [],
    });

    const next = await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
      },
      pluginId: "discord",
      install: {
        source: "npm",
        spec: "@openclaw/discord",
        installPath: "/tmp/openclaw/npm/node_modules/@openclaw/discord/index.ts",
      },
    });

    expect(next).toEqual(enabledConfig);
    expect(buildPluginSnapshotReport).toHaveBeenCalledWith({
      config: enabledConfig,
      effectiveOnly: true,
      onlyPluginIds: ["discord"],
    });
    expect(runtimeLogs.join("\n")).toContain(
      'Warning: installed plugin "discord" is not the active source',
    );
    expect(runtimeLogs.join("\n")).toContain(
      "active config source: /tmp/openclaw-upstream/extensions/discord/index.ts",
    );
    expect(runtimeLogs.join("\n")).toContain(
      "installed npm source: /tmp/openclaw/npm/node_modules/@openclaw/discord/index.ts",
    );
    expect(runtimeLogs.join("\n")).toContain("openclaw plugins doctor");
  });

  it("does not warn when the config-selected source is inside the npm install path", async () => {
    const { persistPluginInstall } = await import("./plugins-install-persist.js");
    const baseConfig = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledConfig = {
      plugins: {
        entries: {
          discord: { enabled: true },
        },
      },
    } as OpenClawConfig;
    enablePluginInConfig.mockReturnValue({ config: enabledConfig });
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "config",
          source: "/tmp/openclaw/npm/node_modules/@openclaw/discord/dist/index.js",
          status: "loaded",
        },
      ],
      diagnostics: [],
    });

    await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
      },
      pluginId: "discord",
      install: {
        source: "npm",
        spec: "@openclaw/discord",
        installPath: "/tmp/openclaw/npm/node_modules/@openclaw/discord",
      },
    });

    expect(runtimeLogs.join("\n")).not.toContain("is not the active source");
  });

  it("invalidates runtime cache even when registry refresh fails", async () => {
    const { persistPluginInstall } = await import("./plugins-install-persist.js");
    const baseConfig = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig;
    enablePluginInConfig.mockReturnValue({ config: enabledConfig });
    refreshPluginRegistry.mockRejectedValueOnce(new Error("registry unavailable"));

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
    expect(refreshPluginRegistry).toHaveBeenCalledTimes(1);
    expect(clearPluginRegistryLoadCache).toHaveBeenCalledTimes(1);
    expectRuntimeLogIncludes("Plugin registry refresh failed");
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
    expect(
      requireMockCallArg(loadPluginManifestRegistry, "loadPluginManifestRegistry").config,
    ).toBe(enabledConfig);
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
    expect(
      requireMockCallArg(loadPluginManifestRegistry, "loadPluginManifestRegistry").config,
    ).toBe(enabledConfig);
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
    expect(
      requireMockCallArg(loadPluginManifestRegistry, "loadPluginManifestRegistry").config,
    ).toBe(enabledConfig);
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
    const persistedRecords = requireMockCallArg(
      writePersistedInstalledPluginIndexInstallRecords,
      "writePersistedInstalledPluginIndexInstallRecords",
    );
    expect(persistedRecords["memory-lancedb"]).toEqual({
      source: "path",
      spec: "memory-lancedb",
      sourcePath: "/app/dist/extensions/memory-lancedb",
      installPath: "/app/dist/extensions/memory-lancedb",
      installedAt: "2026-04-25T00:00:00.000Z",
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
