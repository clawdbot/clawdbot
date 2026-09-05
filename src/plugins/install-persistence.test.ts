// Plugin install persistence tests cover saving installed plugin records after install.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  buildPluginSnapshotReportMock,
  clearPluginRegistryLoadCacheMock,
  enablePluginInConfigMock,
  planPluginUninstallMock,
  replaceConfigFileMock,
  restorePersistedInstalledPluginIndexIfCurrentMock,
  refreshPluginRegistryMock,
  resetPluginsCliTestState,
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

  it.each(["live", "path-denied", "authority-denied"] as const)(
    "preserves config path and delegated authority guards when %s",
    async (state) => {
      const { selectInstallMutationWriteOptions } = await import("./install-persistence.js");
      const calls: string[] = [];
      const failure = new Error("config mutation is no longer authorized");
      const writeOptions = selectInstallMutationWriteOptions(
        {
          assertConfigPathForWrite: () => {
            calls.push("path");
            if (state === "path-denied") {
              throw failure;
            }
          },
        },
        () => {
          calls.push("authority");
          if (state === "authority-denied") {
            throw failure;
          }
        },
      );
      if (state === "live") {
        writeOptions.assertConfigPathForWrite?.();
      } else {
        let caught: unknown;
        try {
          writeOptions.assertConfigPathForWrite?.();
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(failure);
      }
      expect(calls).toEqual(state === "path-denied" ? ["path"] : ["path", "authority"]);
    },
  );

  it("adds installed plugins to restrictive allowlists before enabling", async () => {
    const { persistPluginInstall } = await import("./install-persistence.js");
    const envSnapshotForRestore = { OPENCLAW_GATEWAY_PORT: "18789" };
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

    const { config: next } = await persistPluginInstall({
      snapshot: {
        config: baseConfig,
        baseHash: "config-1",
        writeOptions: {
          assertConfigPathForWrite: installWriteOptions.assertConfigPathForWrite,
          expectedConfigPath: "/tmp/openclaw.json",
          ownedConfigPathForWrite: "/tmp/openclaw.json",
          envSnapshotForRestore,
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
        auditOrigin: "plugin-install",
        assertConfigPathForWrite: installWriteOptions.assertConfigPathForWrite,
        expectedConfigPath: "/tmp/openclaw.json",
        ownedConfigPathForWrite: "/tmp/openclaw.json",
        envSnapshotForRestore,
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
    expect(clearPluginRegistryLoadCacheMock).not.toHaveBeenCalled();
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
    expect(applyPluginUninstallDirectoryRemovalMock).toHaveBeenCalledWith(
      { target: "/tmp/openclaw/extensions/codex" },
      undefined,
    );
    const cleanupOrder =
      applyPluginUninstallDirectoryRemovalMock.mock.invocationCallOrder[0] ??
      Number.MAX_SAFE_INTEGER;
    const refreshOrder = refreshPluginRegistryMock.mock.invocationCallOrder[0] ?? 0;
    expect(cleanupOrder).toBeLessThan(refreshOrder);
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

  it.each(["live", "closed"] as const)(
    "cleans replaced npm projects after runtime application only when authority is %s",
    async (authority) => {
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

      const runtimeStarted = createDeferred();
      const releaseRuntime = createDeferred();
      let runtimeSettled = false;
      let authorityOpen = true;
      const failure = new Error("Delegated authority closed after runtime application");
      const beforePersistentApply = () => {
        if (!authorityOpen) {
          throw failure;
        }
      };
      const application = { operationId: "installed", generation: 2, pluginIds: ["codex"] };
      const write = { persistedHash: "installed-write", persistedSourceConfig: enabledConfig };
      configWriteMock.mockResolvedValue(write);
      applyPluginUninstallDirectoryRemovalMock.mockImplementationOnce(async () => {
        expect(runtimeSettled).toBe(true);
        return { directoryRemoved: true, warnings: [] };
      });
      try {
        const pending = persistPluginInstall({
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
          applyRuntime: async (params) => {
            expect(params.write).toBe(write);
            runtimeStarted.resolve();
            await releaseRuntime.promise;
            runtimeSettled = true;
            authorityOpen = authority === "live";
            return application;
          },
          beforePersistentApply,
        });
        const outcome = pending.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        try {
          await Promise.race([runtimeStarted.promise, pending]);
          expect(configWriteMock).toHaveBeenCalledWith(enabledConfig);
          expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
          expect(fs.existsSync(previousInstallPath)).toBe(true);
        } finally {
          releaseRuntime.resolve();
          await outcome;
        }
        const settled = await outcome;
        if (authority === "closed") {
          expect(settled.ok).toBe(false);
          if (!settled.ok) {
            expect(settled.error).toBe(failure);
          }
          expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
          expect(fs.existsSync(previousInstallPath)).toBe(true);
        } else {
          expect(settled).toMatchObject({ ok: true, value: { application } });
        }
        expect(
          requireMockCallArg(
            writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
            "writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock",
          ).codex,
        ).toEqual(expect.objectContaining({ installPath: nextInstallPath }));

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
        if (authority === "live") {
          expect(applyPluginUninstallDirectoryRemovalMock).toHaveBeenCalledWith(
            {
              target: previousInstallPath,
              cleanup: {
                kind: "npm",
                npmRoot: previousProjectRoot,
                packageName: "@openclaw/codex",
                rootKind: "isolated-project",
              },
            },
            beforePersistentApply,
          );
        }
        expect(hasRetainedManagedNpmInstallMarker(previousInstallPath)).toBe(false);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );

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

    const { config: next, warnings } = await persistPluginInstall({
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
    expect(warnings).toEqual([
      'Installed plugin "discord" is shadowed by a configured plugin source. Run `openclaw plugins doctor`.',
    ]);
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

    const { warnings } = await persistPluginInstall({
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

    expect(warnings).toEqual([]);
  });

  it("reports registry refresh failure while preserving the active runtime cache", async () => {
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

    const { config: next, warnings } = await persistPluginInstall({
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
    expect(clearPluginRegistryLoadCacheMock).not.toHaveBeenCalled();
    expect(warnings).toEqual([
      "Plugin registry refresh failed. Run `openclaw plugins registry --refresh`.",
    ]);
  });
});
