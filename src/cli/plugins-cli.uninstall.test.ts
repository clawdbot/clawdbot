import { beforeEach, describe, expect, it } from "vitest";
import { installedPluginRoot } from "../../test/helpers/bundled-plugin-paths.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyPluginUninstallDirectoryRemoval,
  buildPluginDiagnosticsReport,
  loadConfig,
  planPluginUninstall,
  promptYesNo,
  refreshPluginRegistry,
  replaceConfigFile,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeErrors,
  runtimeLogs,
  setInstalledPluginIndexInstallRecords,
  writeConfigFile,
  writePersistedInstalledPluginIndexInstallRecords,
} from "./plugins-cli-test-helpers.js";

const CLI_STATE_ROOT = "/tmp/openclaw-state";
const ALPHA_INSTALL_PATH = installedPluginRoot(CLI_STATE_ROOT, "alpha");

describe("plugins cli uninstall", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  it("shows uninstall dry-run preview without mutating config", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        entries: {
          alpha: {
            enabled: true,
          },
        },
        installs: {
          alpha: {
            source: "path",
            sourcePath: ALPHA_INSTALL_PATH,
            installPath: ALPHA_INSTALL_PATH,
          },
        },
        slots: {
          contextEngine: "alpha",
        },
      },
    } as OpenClawConfig);
    buildPluginDiagnosticsReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    planPluginUninstall.mockReturnValue({
      ok: true,
      config: {} as OpenClawConfig,
      actions: {
        entry: true,
        install: true,
        allowlist: false,
        denylist: false,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: true,
        directory: false,
      },
      directoryRemoval: null,
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--dry-run"]);

    expect(planPluginUninstall).toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expect(runtimeLogs.some((line) => line.includes("Dry run, no changes made."))).toBe(true);
    expect(runtimeLogs.some((line) => line.includes("context engine slot"))).toBe(true);
  });

  it("uninstalls with --force and --keep-files without prompting", async () => {
    const baseConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
        installs: {
          alpha: {
            source: "path",
            sourcePath: ALPHA_INSTALL_PATH,
            installPath: ALPHA_INSTALL_PATH,
          },
        },
      },
    } as OpenClawConfig;
    const nextConfig = {
      plugins: {
        entries: {},
        installs: {},
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(baseConfig.plugins?.installs ?? {});
    buildPluginDiagnosticsReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    planPluginUninstall.mockReturnValue({
      ok: true,
      config: nextConfig,
      actions: {
        entry: true,
        install: true,
        allowlist: false,
        denylist: false,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: false,
        directory: false,
      },
      directoryRemoval: null,
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--force", "--keep-files"]);

    expect(promptYesNo).not.toHaveBeenCalled();
    expect(planPluginUninstall).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "alpha",
        deleteFiles: false,
      }),
    );
    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({});
    expect(writeConfigFile).toHaveBeenCalledWith({
      plugins: {
        entries: {},
      },
    });
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: {
        plugins: {
          entries: {},
        },
      },
      installRecords: {},
      reason: "source-changed",
    });
  });

  it("restores install records when the config write rejects during uninstall", async () => {
    const installRecords = {
      alpha: {
        source: "path",
        sourcePath: ALPHA_INSTALL_PATH,
        installPath: ALPHA_INSTALL_PATH,
      },
    } as const;
    const baseConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
        installs: installRecords,
      },
    } as OpenClawConfig;
    const nextConfig = {
      plugins: {
        entries: {},
        installs: {},
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(installRecords);
    buildPluginDiagnosticsReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    planPluginUninstall.mockReturnValue({
      ok: true,
      config: nextConfig,
      actions: {
        entry: true,
        install: true,
        allowlist: false,
        denylist: false,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: false,
        directory: false,
      },
      directoryRemoval: null,
    });
    replaceConfigFile.mockRejectedValueOnce(new Error("config changed"));

    await expect(
      runPluginsCommand(["plugins", "uninstall", "alpha", "--force", "--keep-files"]),
    ).rejects.toThrow("config changed");

    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenNthCalledWith(1, {});
    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenNthCalledWith(
      2,
      installRecords,
    );
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expect(applyPluginUninstallDirectoryRemoval).not.toHaveBeenCalled();
  });

  it("removes plugin files only after config and index commit succeeds", async () => {
    const installRecords = {
      alpha: {
        source: "npm",
        spec: "alpha@1.0.0",
        installPath: ALPHA_INSTALL_PATH,
      },
    } as const;
    const baseConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
        installs: installRecords,
      },
    } as OpenClawConfig;
    const nextConfig = {
      plugins: {
        entries: {},
        installs: {},
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(installRecords);
    buildPluginDiagnosticsReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    planPluginUninstall.mockReturnValue({
      ok: true,
      config: nextConfig,
      actions: {
        entry: true,
        install: true,
        allowlist: false,
        denylist: false,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: false,
        directory: false,
      },
      directoryRemoval: { target: ALPHA_INSTALL_PATH },
    });
    applyPluginUninstallDirectoryRemoval.mockResolvedValue({
      directoryRemoved: true,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--force"]);

    const configWriteOrder = writeConfigFile.mock.invocationCallOrder[0] ?? 0;
    const deleteOrder =
      applyPluginUninstallDirectoryRemoval.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    const refreshOrder =
      refreshPluginRegistry.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(configWriteOrder).toBeGreaterThan(0);
    expect(deleteOrder).toBeGreaterThan(configWriteOrder);
    expect(refreshOrder).toBeGreaterThan(deleteOrder);
    expect(applyPluginUninstallDirectoryRemoval).toHaveBeenCalledWith({
      target: ALPHA_INSTALL_PATH,
    });
  });

  it("exits when uninstall target is not managed by plugin install records", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        entries: {},
        installs: {},
      },
    } as OpenClawConfig);
    buildPluginDiagnosticsReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });

    await expect(runPluginsCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain("is not managed by plugins config/install records");
    expect(planPluginUninstall).not.toHaveBeenCalled();
  });
});
