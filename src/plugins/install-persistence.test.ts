// Plugin install persistence tests cover saving installed plugin records after install.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildPluginSnapshotReportMock,
  clearPluginRegistryLoadCacheMock,
  enablePluginInConfigMock,
  planPluginUninstallMock,
  replaceConfigFileMock,
  restorePersistedInstalledPluginIndexIfCurrentMock,
  refreshPluginRegistryMock,
  resetPluginsCliTestState,
  pluginsCliRuntimeLogs,
  setInstalledPluginIndexInstallRecords,
  configWriteMock,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
  applyPluginUninstallDirectoryRemovalMock,
} from "../cli/plugins-cli-test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ConfigWriteOptions } from "../config/io.js";
import { hasRetainedManagedNpmInstallMarker } from "./managed-npm-retention.js";
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

  it.each(["before index", "at config publication"])(
    "rejects an expired owner %s and restores tentative state",
    async (phase) => {
      const { persistPluginInstall } = await import("./install-persistence.js");
      const expired = new Error("approved operation owner expired");
      let ownerActive = phase === "at config publication";
      replaceConfigFileMock.mockImplementationOnce(async (...args: unknown[]) => {
        const params = args[0] as { nextConfig: OpenClawConfig; writeOptions: ConfigWriteOptions };
        await Promise.resolve();
        ownerActive = false;
        await params.writeOptions.beforeCommit?.();
        await configWriteMock(params.nextConfig);
      });
      await expect(
        persistPluginInstall({
          snapshot: { config: {}, baseHash: "config-1", writeOptions: installWriteOptions },
          pluginId: "alpha",
          install: { source: "archive", sourcePath: "/tmp/alpha.tgz", installPath: "/tmp/alpha" },
          beforePersistentEffect: async () => {
            if (!ownerActive) {
              throw expired;
            }
          },
        }),
      ).rejects.toBe(expired);
      expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).toHaveBeenCalledTimes(
        phase === "before index" ? 0 : 1,
      );
      expect(restorePersistedInstalledPluginIndexIfCurrentMock).toHaveBeenCalledTimes(
        phase === "before index" ? 0 : 1,
      );
      expect(configWriteMock).not.toHaveBeenCalled();
      expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
    },
  );

  it("labels plugin lifecycle config writes", async () => {
    const { selectInstallMutationWriteOptions } = await import("./install-config-mutation.js");

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
    expect(refreshParams.config).toEqual(enabledConfig);
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
});
