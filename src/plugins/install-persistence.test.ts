// Plugin install persistence tests cover saving installed plugin records after install.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyExclusiveSlotSelectionMock,
  buildPluginDiagnosticsReportMock,
  buildPluginSnapshotReportMock,
  clearPluginRegistryLoadCacheMock,
  enablePluginInConfigMock,
  loadPluginManifestRegistryMock,
  planPluginUninstallMock,
  replaceConfigFileMock,
  refreshPluginRegistryMock,
  resetPluginsCliTestState,
  pluginsCliRuntimeLogs,
  setInstalledPluginIndexInstallRecords,
  configWriteMock,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
  applyPluginUninstallDirectoryRemovalMock,
} from "../cli/plugins-cli-test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import { hasRetainedManagedNpmInstallMarker } from "./managed-npm-retention.js";
import { recordPluginManifestInstallOwner } from "./manifest-install-owner.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

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
  expect(pluginsCliRuntimeLogs.join("\n")).toContain(fragment);
}

function createManifestRecord(
  id: string,
  overrides: Partial<PluginManifestRecord> = {},
  owner = id,
): PluginManifestRecord {
  const rootDir = path.join(os.tmpdir(), "openclaw-plugin-fixtures", id);
  return recordPluginManifestInstallOwner(
    {
      id,
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      origin: "config",
      rootDir,
      source: path.join(rootDir, "index.ts"),
      manifestPath: path.join(rootDir, "openclaw.plugin.json"),
      ...overrides,
    },
    owner,
  );
}

const installWriteOptions = {
  assertConfigPathForWrite: () => {},
  expectedConfigPath: "/tmp/openclaw.json",
  ownedConfigPathForWrite: "/tmp/openclaw.json",
};

describe("persistPluginInstall", () => {
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    resetPluginsCliTestState();
  });

  it("labels plugin lifecycle config writes", async () => {
    const { selectInstallMutationWriteOptions } = await import("./install-persistence.js");

    expect(
      selectInstallMutationWriteOptions({
        expectedConfigPath: "/tmp/openclaw.json",
        ownedConfigPathForWrite: "/tmp/openclaw.json",
      }),
    ).toMatchObject({
      auditOrigin: "plugin-install",
      expectedConfigPath: "/tmp/openclaw.json",
      ownedConfigPathForWrite: "/tmp/openclaw.json",
    });
  });

  it("adds installed plugins to restrictive allowlists before enabling", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const baseConfig = {
      plugins: {
        allow: ["memory-core"],
      },
    } as OpenClawConfig;
    const enabledConfig = {
      plugins: {
        allow: ["memory-core", "alpha"],
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig;
    enablePluginInConfigMock.mockImplementation((...args: unknown[]) => {
      const [cfg, pluginId] = args as [OpenClawConfig, string];
      expect(pluginId).toBe("alpha");
      expect(cfg.plugins?.allow).toEqual(["memory-core", "alpha"]);
      return { config: enabledConfig, enabled: true };
    });

    const next = await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
        writeOptions: {
          assertConfigPathForWrite: installWriteOptions.assertConfigPathForWrite,
          expectedConfigPath: "/tmp/openclaw.json",
          ownedConfigPathForWrite: "/tmp/openclaw.json",
          includeFileHashesForWrite: { "/tmp/plugins.json5": "include-1" },
          includeFileTargetsForWrite: { "/tmp/plugins.json5": "/tmp/plugins.json5" },
        },
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
      writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
      "writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock",
    );
    expect(persistedRecords.alpha).toEqual({
      source: "npm",
      spec: "alpha@1.0.0",
      installPath: "/tmp/alpha",
      installedAt: "2026-04-25T00:00:00.000Z",
    });
    expect(configWriteMock).toHaveBeenCalledWith(enabledConfig);
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      nextConfig: enabledConfig,
      baseHash: "config-1",
      writeOptions: {
        assertConfigPathForWrite: installWriteOptions.assertConfigPathForWrite,
        expectedConfigPath: "/tmp/openclaw.json",
        ownedConfigPathForWrite: "/tmp/openclaw.json",
        includeFileHashesForWrite: { "/tmp/plugins.json5": "include-1" },
        includeFileTargetsForWrite: { "/tmp/plugins.json5": "/tmp/plugins.json5" },
        afterWrite: { mode: "restart", reason: "plugin source changed" },
        unsetPaths: [["plugins", "installs"]],
      },
    });
    const refreshParams = requireMockCallArg(
      refreshPluginRegistryMock,
      "refreshPluginRegistryMock",
    );
    expect(refreshParams.config).toBe(enabledConfig);
    expect(refreshParams.reason).toBe("source-changed");
    expect((refreshParams.installRecords as Record<string, unknown>).alpha).toEqual({
      source: "npm",
      spec: "alpha@1.0.0",
      installPath: "/tmp/alpha",
      installedAt: "2026-04-25T00:00:00.000Z",
    });
    expect(clearPluginRegistryLoadCacheMock).toHaveBeenCalledTimes(1);
  });

  it("persists installs even when runtime cache invalidation fails", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
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
    enablePluginInConfigMock.mockReturnValue({ config: enabledConfig, enabled: true });
    clearPluginRegistryLoadCacheMock.mockImplementation(() => {
      throw new Error("cache unavailable");
    });

    const next = await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
        writeOptions: installWriteOptions,
      },
      pluginId: "alpha",
      install: {
        source: "npm",
        spec: "alpha@1.0.0",
        installPath: "/tmp/alpha",
      },
    });

    expect(next).toEqual(enabledConfig);
    expect(refreshPluginRegistryMock).toHaveBeenCalledTimes(1);
    expectRuntimeLogIncludes("Plugin runtime cache invalidation failed");
  });

  it("removes a replaced managed install directory before refreshing the registry", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
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
    enablePluginInConfigMock.mockReturnValue({ config: enabledConfig, enabled: true });
    setInstalledPluginIndexInstallRecords({
      codex: {
        source: "clawhub",
        spec: "clawhub:@openclaw/codex",
        installPath: "/tmp/openclaw/extensions/codex",
      },
    });
    planPluginUninstallMock.mockReturnValueOnce({
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
    applyPluginUninstallDirectoryRemovalMock.mockResolvedValueOnce({
      directoryRemoved: true,
      warnings: [],
    });

    await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
        writeOptions: installWriteOptions,
      },
      pluginId: "codex",
      install: {
        source: "npm",
        spec: "@openclaw/codex",
        installPath: "/tmp/openclaw/npm/node_modules/@openclaw/codex",
      },
    });

    expect(planPluginUninstallMock).toHaveBeenCalledWith(
      expect.objectContaining({
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
      }),
    );
    expect(applyPluginUninstallDirectoryRemovalMock).toHaveBeenCalledWith({
      target: "/tmp/openclaw/extensions/codex",
    });
    const cleanupOrder =
      applyPluginUninstallDirectoryRemovalMock.mock.invocationCallOrder[0] ??
      Number.MAX_SAFE_INTEGER;
    const refreshOrder = refreshPluginRegistryMock.mock.invocationCallOrder[0] ?? 0;
    expect(cleanupOrder).toBeLessThan(refreshOrder);
    expect(pluginsCliRuntimeLogs.join("\n")).toContain(
      "Removed previous plugin install directory: /tmp/openclaw/extensions/codex",
    );
  });

  it("preserves replaced install directories when the new install path overlaps", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
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
    enablePluginInConfigMock.mockReturnValue({ config: enabledConfig, enabled: true });
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
        writeOptions: installWriteOptions,
      },
      pluginId: "codex",
      install: {
        source: "npm",
        spec: "@openclaw/codex@latest",
        installPath: "/tmp/openclaw/npm/node_modules/@openclaw/codex",
      },
    });

    expect(planPluginUninstallMock).not.toHaveBeenCalled();
    expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
  });

  it("preserves replaced npm install directories across generation updates", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
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
    enablePluginInConfigMock.mockReturnValue({ config: enabledConfig, enabled: true });
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-persist-"));
    const previousProjectRoot = path.join(tempRoot, "npm", "projects", "codex-v1");
    const previousInstallPath = path.join(
      previousProjectRoot,
      "node_modules",
      "@openclaw",
      "codex",
    );
    const nextInstallPath = path.join(
      tempRoot,
      "npm",
      "projects",
      "codex-v2",
      "node_modules",
      "@openclaw",
      "codex",
    );
    fs.mkdirSync(previousInstallPath, { recursive: true });
    setInstalledPluginIndexInstallRecords({
      codex: {
        source: "npm",
        spec: "@openclaw/codex@1.0.0",
        installPath: previousInstallPath,
      },
    });
    planPluginUninstallMock.mockReturnValueOnce({
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
        target: previousInstallPath,
        cleanup: {
          kind: "npm",
          npmRoot: previousProjectRoot,
          packageName: "@openclaw/codex",
          rootKind: "isolated-project",
        },
      },
    });

    try {
      await persistPluginInstall({
        snapshot: {
          config: baseConfig,
          baseHash: "config-1",
          writeOptions: installWriteOptions,
        },
        pluginId: "codex",
        install: {
          source: "npm",
          spec: "@openclaw/codex@2.0.0",
          installPath: nextInstallPath,
        },
      });

      expect(planPluginUninstallMock).toHaveBeenCalledWith(
        expect.objectContaining({
          config: {
            plugins: {
              installs: {
                codex: {
                  source: "npm",
                  spec: "@openclaw/codex@1.0.0",
                  installPath: previousInstallPath,
                },
              },
            },
          },
          pluginId: "codex",
          deleteFiles: true,
        }),
      );
      expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
      expect(hasRetainedManagedNpmInstallMarker(previousInstallPath)).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("warns when an installed npm plugin remains shadowed by a config-selected source", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
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
    enablePluginInConfigMock.mockReturnValue({ config: enabledConfig, enabled: true });
    buildPluginSnapshotReportMock.mockReturnValue({
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
        writeOptions: installWriteOptions,
      },
      pluginId: "discord",
      install: {
        source: "npm",
        spec: "@openclaw/discord",
        installPath: "/tmp/openclaw/npm/node_modules/@openclaw/discord/index.ts",
      },
    });

    expect(next).toEqual(enabledConfig);
    expect(buildPluginSnapshotReportMock).toHaveBeenCalledWith({
      config: enabledConfig,
      effectiveOnly: true,
      onlyPluginIds: ["discord"],
    });
    expect(pluginsCliRuntimeLogs.join("\n")).toContain(
      'Warning: installed plugin "discord" is not the active source',
    );
    expect(pluginsCliRuntimeLogs.join("\n")).toContain(
      "active config source: /tmp/openclaw-upstream/extensions/discord/index.ts",
    );
    expect(pluginsCliRuntimeLogs.join("\n")).toContain(
      "installed npm source: /tmp/openclaw/npm/node_modules/@openclaw/discord/index.ts",
    );
    expect(pluginsCliRuntimeLogs.join("\n")).toContain("openclaw plugins doctor");
  });

  it("does not warn when the config-selected source is inside the npm install path", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
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
    enablePluginInConfigMock.mockReturnValue({ config: enabledConfig, enabled: true });
    buildPluginSnapshotReportMock.mockReturnValue({
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
        writeOptions: installWriteOptions,
      },
      pluginId: "discord",
      install: {
        source: "npm",
        spec: "@openclaw/discord",
        installPath: "/tmp/openclaw/npm/node_modules/@openclaw/discord",
      },
    });

    expect(pluginsCliRuntimeLogs.join("\n")).not.toContain("is not the active source");
  });

  it("invalidates runtime cache even when registry refresh fails", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
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
    enablePluginInConfigMock.mockReturnValue({ config: enabledConfig, enabled: true });
    refreshPluginRegistryMock.mockRejectedValueOnce(new Error("registry unavailable"));

    const next = await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
        writeOptions: installWriteOptions,
      },
      pluginId: "alpha",
      install: {
        source: "npm",
        spec: "alpha@1.0.0",
        installPath: "/tmp/alpha",
      },
    });

    expect(next).toEqual(enabledConfig);
    expect(refreshPluginRegistryMock).toHaveBeenCalledTimes(1);
    expect(clearPluginRegistryLoadCacheMock).toHaveBeenCalledTimes(1);
    expectRuntimeLogIncludes("Plugin registry refresh failed");
  });

  it("skips runtime cache invalidation when the caller opts out", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
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
    enablePluginInConfigMock.mockReturnValue({ config: enabledConfig, enabled: true });

    const next = await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
        writeOptions: installWriteOptions,
      },
      pluginId: "alpha",
      install: {
        source: "npm",
        spec: "alpha@1.0.0",
        installPath: "/tmp/alpha",
      },
      invalidateRuntimeCache: false,
    });

    expect(next).toEqual(enabledConfig);
    expect(refreshPluginRegistryMock).toHaveBeenCalledTimes(1);
    expect(clearPluginRegistryLoadCacheMock).not.toHaveBeenCalled();
  });

  it("restores runtime child policy when reinstalling its package owner", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const baseConfig = {
      plugins: {
        allow: ["memory-core"],
        deny: ["demo-plugin-npm", "other"],
      },
    } as OpenClawConfig;
    setInstalledPluginIndexInstallRecords({
      "demo-package": { source: "npm", spec: "@openclaw/demo-package@0.0.1" },
    });
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [createManifestRecord("demo-plugin-npm", {}, "demo-package")],
      diagnostics: [],
    });

    const next = await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
        writeOptions: installWriteOptions,
      },
      pluginId: "demo-package",
      install: {
        source: "npm",
        spec: "@openclaw/demo-package@0.0.1",
        installPath: "/tmp/demo-package",
      },
    });

    expect(next.plugins?.allow).toEqual(["memory-core", "demo-plugin-npm"]);
    expect(next.plugins?.deny).toEqual(["other"]);
    expect(enablePluginInConfigMock).toHaveBeenCalledTimes(1);
  });

  it("scopes runtime kind lookup to the selected plugin when metadata omits kind", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
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
    enablePluginInConfigMock.mockReturnValue({ config: enabledConfig, enabled: true });
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [createManifestRecord("legacy-memory")],
      diagnostics: [],
    });
    buildPluginDiagnosticsReportMock.mockReturnValueOnce({
      plugins: [{ id: "legacy-memory", kind: "memory" }],
      diagnostics: [],
    });
    applyExclusiveSlotSelectionMock.mockImplementation(((params: {
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
        writeOptions: installWriteOptions,
      },
      pluginId: "legacy-memory",
      install: {
        source: "path",
        sourcePath: "/tmp/legacy-memory",
        installPath: "/tmp/legacy-memory",
      },
    });

    expect(buildPluginDiagnosticsReportMock).toHaveBeenCalledTimes(1);
    expect(buildPluginDiagnosticsReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: enabledConfig,
        onlyPluginIds: ["legacy-memory"],
      }),
    );
    expect(
      requireMockCallArg(loadPluginManifestRegistryMock, "loadPluginManifestRegistryMock", 1)
        .config,
    ).toBe(enabledConfig);
    expect(next.plugins?.entries?.["legacy-memory-a"]?.enabled).toBe(true);
    expect(next.plugins?.slots?.memory).toBe("legacy-memory");
  });

  it("uses cold metadata for manifest-kind slot selection without loading runtime siblings", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
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
    enablePluginInConfigMock.mockReturnValue({ config: enabledConfig, enabled: true });
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [createManifestRecord("memory-b", { kind: "memory" })],
      diagnostics: [],
    });
    applyExclusiveSlotSelectionMock.mockImplementation(((params: {
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
        writeOptions: installWriteOptions,
      },
      pluginId: "memory-b",
      install: {
        source: "path",
        sourcePath: "/tmp/memory-b",
        installPath: "/tmp/memory-b",
      },
    });

    expect(buildPluginDiagnosticsReportMock).not.toHaveBeenCalled();
    expect(
      requireMockCallArg(loadPluginManifestRegistryMock, "loadPluginManifestRegistryMock", 1)
        .config,
    ).toBe(enabledConfig);
    expect(next.plugins?.entries?.["legacy-memory-a"]?.enabled).toBe(true);
    expect(next.plugins?.slots?.memory).toBe("memory-b");
  });

  it("does not load every plugin runtime for non-slot installs without manifest kind", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
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
    enablePluginInConfigMock.mockReturnValue({ config: enabledConfig, enabled: true });
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [createManifestRecord("plain")],
      diagnostics: [],
    });
    buildPluginDiagnosticsReportMock.mockReturnValue({
      plugins: [{ id: "plain" }],
      diagnostics: [],
    });
    applyExclusiveSlotSelectionMock.mockReturnValue({
      config: enabledConfig,
      warnings: [],
      changed: false,
    });

    const next = await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
        writeOptions: installWriteOptions,
      },
      pluginId: "plain",
      install: {
        source: "path",
        sourcePath: "/tmp/plain",
        installPath: "/tmp/plain",
      },
    });

    expect(buildPluginDiagnosticsReportMock).toHaveBeenCalledTimes(1);
    expect(buildPluginDiagnosticsReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: enabledConfig,
        onlyPluginIds: ["plain"],
      }),
    );
    expect(
      requireMockCallArg(loadPluginManifestRegistryMock, "loadPluginManifestRegistryMock", 1)
        .config,
    ).toBe(enabledConfig);
    expect(next).toEqual(enabledConfig);
  });

  it("installs a plugin disabled when its required configuration is missing", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const baseConfig = {
      plugins: {
        allow: ["memory-core"],
        deny: ["needs-config"],
        entries: {
          "needs-config": { hooks: { timeoutMs: 5_000 } },
        },
      },
    } as OpenClawConfig;
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [
        recordPluginManifestInstallOwner(
          {
            id: "needs-config",
            manifestPath: "/tmp/needs-config/openclaw.plugin.json",
            configSchema: {
              type: "object",
              required: ["token"],
              properties: { token: { type: "string" } },
            },
          },
          "needs-config",
        ),
      ],
      diagnostics: [],
    });

    const next = await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
        writeOptions: installWriteOptions,
      },
      pluginId: "needs-config",
      install: {
        source: "npm",
        spec: "needs-config@1.0.0",
        installPath: "/tmp/needs-config",
      },
    });

    expect(next).toEqual({
      plugins: {
        allow: ["memory-core", "needs-config"],
        entries: {
          "needs-config": { enabled: false, hooks: { timeoutMs: 5_000 } },
        },
      },
    });
    expect(enablePluginInConfigMock).not.toHaveBeenCalled();
    expect(applyExclusiveSlotSelectionMock).not.toHaveBeenCalled();
    expectRuntimeLogIncludes(
      'Installed plugin "needs-config" without enabling it because it requires configuration first.',
    );
    const persistedRecords = requireMockCallArg(
      writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
      "writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock",
    );
    expect(persistedRecords["needs-config"]).toMatchObject({
      source: "npm",
      spec: "needs-config@1.0.0",
      installPath: "/tmp/needs-config",
    });
  });

  it("rejects invalid authored plugin config even for a disabled install", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    let committed = false;
    const baseConfig = {
      plugins: {
        entries: {
          "needs-config": {
            enabled: false,
            config: null as never,
            hooks: { timeoutMs: 5_000 },
          },
        },
      },
    } as OpenClawConfig;
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [
        recordPluginManifestInstallOwner(
          {
            id: "needs-config",
            manifestPath: "/tmp/needs-config/openclaw.plugin.json",
            configSchema: {
              type: "object",
              required: ["token"],
              properties: { token: { type: "string" } },
            },
          },
          "needs-config",
        ),
      ],
      diagnostics: [],
    });

    await expect(
      persistPluginInstall({
        snapshot: {
          config: baseConfig,
          baseHash: "config-1",
          writeOptions: installWriteOptions,
        },
        pluginId: "needs-config",
        enable: false,
        onCommitted: () => {
          committed = true;
        },
        install: {
          source: "npm",
          spec: "needs-config@1.0.0",
          installPath: "/tmp/needs-config",
        },
      }),
    ).rejects.toThrow("has invalid configured settings");

    expect(committed).toBe(false);
    expect(enablePluginInConfigMock).not.toHaveBeenCalled();
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("can persist an install record without enabling a plugin that needs config first", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const baseConfig = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;

    const next = await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
        writeOptions: installWriteOptions,
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
    expect(enablePluginInConfigMock).not.toHaveBeenCalled();
    expect(applyExclusiveSlotSelectionMock).not.toHaveBeenCalled();
    const persistedRecords = requireMockCallArg(
      writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
      "writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock",
    );
    expect(persistedRecords["memory-lancedb"]).toEqual({
      source: "path",
      spec: "memory-lancedb",
      sourcePath: "/app/dist/extensions/memory-lancedb",
      installPath: "/app/dist/extensions/memory-lancedb",
      installedAt: "2026-04-25T00:00:00.000Z",
    });
    expect(configWriteMock).toHaveBeenCalledWith(baseConfig);
  });

  it("does not add disabled installs to restrictive allowlists", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
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
        writeOptions: installWriteOptions,
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
