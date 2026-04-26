import { beforeEach, describe, expect, it } from "vitest";
import { installedPluginRoot } from "../../test/helpers/bundled-plugin-paths.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildPluginDiagnosticsReport,
  loadConfig,
  promptYesNo,
  refreshPluginRegistry,
  replaceConfigFile,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeErrors,
  runtimeLogs,
  setInstalledPluginIndexInstallRecords,
  uninstallPlugin,
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
      },
    } as OpenClawConfig);
    buildPluginDiagnosticsReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--dry-run"]);

    expect(uninstallPlugin).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expect(runtimeLogs.some((line) => line.includes("Dry run, no changes made."))).toBe(true);
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
    uninstallPlugin.mockResolvedValue({
      ok: true,
      config: nextConfig,
      warnings: [],
      actions: {
        entry: true,
        install: true,
        allowlist: false,
        loadPath: false,
        memorySlot: false,
        directory: false,
      },
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--force", "--keep-files"]);

    expect(promptYesNo).not.toHaveBeenCalled();
    expect(uninstallPlugin).toHaveBeenCalledWith(
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
    uninstallPlugin.mockResolvedValue({
      ok: true,
      config: nextConfig,
      warnings: [],
      actions: {
        entry: true,
        install: true,
        allowlist: false,
        loadPath: false,
        memorySlot: false,
        directory: false,
      },
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
    expect(uninstallPlugin).not.toHaveBeenCalled();
  });
});
