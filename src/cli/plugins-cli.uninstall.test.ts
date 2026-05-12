import { installedPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyPluginUninstallDirectoryRemoval,
  buildPluginDiagnosticsReport,
  buildPluginSnapshotReport,
  loadConfig,
  planPluginUninstall,
  PromptInputClosedError,
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
const ORIGINAL_OPENCLAW_NIX_MODE = process.env.OPENCLAW_NIX_MODE;

function expectRuntimeLogIncludes(fragment: string) {
  expect(runtimeLogs.some((message) => message.includes(fragment))).toBe(true);
}

function expectLatestUninstallPlanParams(expected: {
  pluginId: string;
  deleteFiles: boolean;
  channelIds?: unknown;
}) {
  const params = planPluginUninstall.mock.calls.at(-1)?.[0] as
    | { pluginId?: string; deleteFiles?: boolean; channelIds?: unknown }
    | undefined;
  expect(params).toBeDefined();
  expect(params?.pluginId).toBe(expected.pluginId);
  expect(params?.deleteFiles).toBe(expected.deleteFiles);
  if ("channelIds" in expected) {
    expect(params?.channelIds).toBe(expected.channelIds);
  }
}

describe("plugins cli uninstall", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  afterEach(() => {
    if (ORIGINAL_OPENCLAW_NIX_MODE === undefined) {
      delete process.env.OPENCLAW_NIX_MODE;
    } else {
      process.env.OPENCLAW_NIX_MODE = ORIGINAL_OPENCLAW_NIX_MODE;
    }
  });

  it("refuses plugin uninstalls in Nix mode before planning file removal", async () => {
    const previous = process.env.OPENCLAW_NIX_MODE;
    process.env.OPENCLAW_NIX_MODE = "1";
    try {
      await expect(runPluginsCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
        "OPENCLAW_NIX_MODE=1",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_NIX_MODE;
      } else {
        process.env.OPENCLAW_NIX_MODE = previous;
      }
    }

    expect(planPluginUninstall).not.toHaveBeenCalled();
    expect(applyPluginUninstallDirectoryRemoval).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
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
    buildPluginSnapshotReport.mockReturnValue({
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

    expect(buildPluginSnapshotReport).toHaveBeenCalledTimes(1);
    expect(buildPluginDiagnosticsReport).not.toHaveBeenCalled();
    expect(planPluginUninstall).toHaveBeenCalledTimes(1);
    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expectRuntimeLogIncludes("Dry run, no changes made.");
    expectRuntimeLogIncludes("context engine slot");
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
    buildPluginSnapshotReport.mockReturnValue({
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
    expectLatestUninstallPlanParams({ pluginId: "alpha", deleteFiles: false });
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

  it("exits cleanly when confirmation input closes before an answer", async () => {
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
    loadConfig.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(baseConfig.plugins?.installs ?? {});
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    planPluginUninstall.mockReturnValue({
      ok: true,
      config: { plugins: { entries: {}, installs: {} } } as OpenClawConfig,
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
    promptYesNo.mockRejectedValueOnce(new PromptInputClosedError());

    await expect(runPluginsCommand(["plugins", "uninstall", "alpha"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors).toContain(
      "Error: plugins uninstall requires confirmation input. Re-run in an interactive TTY or pass --force.",
    );
    expect(writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expect(applyPluginUninstallDirectoryRemoval).not.toHaveBeenCalled();
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
    buildPluginSnapshotReport.mockReturnValue({
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
    buildPluginSnapshotReport.mockReturnValue({
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
    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    expect(applyPluginUninstallDirectoryRemoval).toHaveBeenCalledTimes(1);
    expect(refreshPluginRegistry).toHaveBeenCalledTimes(1);
    expect(deleteOrder).toBeGreaterThan(configWriteOrder);
    expect(refreshOrder).toBeGreaterThan(deleteOrder);
    expect(applyPluginUninstallDirectoryRemoval).toHaveBeenCalledWith({
      target: ALPHA_INSTALL_PATH,
    });
  });

  it("cleans stale policy refs even when plugin is absent from the current registry", async () => {
    const baseConfig = {
      plugins: {
        allow: ["alpha", "beta"],
        deny: ["alpha"],
      },
    } as OpenClawConfig;
    const nextConfig = {
      plugins: {
        allow: ["beta"],
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(baseConfig);
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    planPluginUninstall.mockReturnValue({
      ok: true,
      config: nextConfig,
      actions: {
        entry: false,
        install: false,
        allowlist: true,
        denylist: true,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: false,
        channelConfig: false,
        directory: false,
      },
      directoryRemoval: null,
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--force"]);

    expectLatestUninstallPlanParams({ pluginId: "alpha", deleteFiles: true });
    expect(writeConfigFile).toHaveBeenCalledWith(nextConfig);
    expect(runtimeLogs.at(-2)).toContain('Uninstalled plugin "alpha"');
  });

  it("uninstalls stale enabled entries when plugin is absent from the current registry", async () => {
    const baseConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig;
    const nextConfig = {} as OpenClawConfig;

    loadConfig.mockReturnValue(baseConfig);
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    planPluginUninstall.mockReturnValue({
      ok: true,
      config: nextConfig,
      actions: {
        entry: true,
        install: false,
        allowlist: false,
        denylist: false,
        loadPath: false,
        memorySlot: false,
        contextEngineSlot: false,
        channelConfig: false,
        directory: false,
      },
      directoryRemoval: null,
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--force"]);

    expectLatestUninstallPlanParams({ pluginId: "alpha", deleteFiles: true });
    expect(writeConfigFile).toHaveBeenCalledWith(nextConfig);
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: nextConfig,
      installRecords: {},
      reason: "source-changed",
    });
    expect(runtimeErrors).not.toContain("Plugin not found: alpha");
    expect(runtimeLogs.at(-2)).toContain('Uninstalled plugin "alpha"');
  });

  it("removes installed channel config when plugin code is absent from the current registry", async () => {
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
      channels: {
        alpha: {
          enabled: true,
        },
        discord: {
          enabled: true,
        },
      },
    } as OpenClawConfig;
    const nextConfig = {
      channels: {
        discord: {
          enabled: true,
        },
      },
    } as OpenClawConfig;

    loadConfig.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(installRecords);
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [],
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
        channelConfig: true,
        directory: false,
      },
      directoryRemoval: null,
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--force", "--keep-files"]);

    expectLatestUninstallPlanParams({
      pluginId: "alpha",
      channelIds: undefined,
      deleteFiles: false,
    });
    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith({});
    expect(writeConfigFile).toHaveBeenCalledWith(nextConfig);
    expectRuntimeLogIncludes("channel config (channels.alpha)");
    expect(runtimeLogs.at(-2)).toContain('Uninstalled plugin "alpha"');
  });

  it("exits when uninstall target is not managed by plugin install records", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        entries: {},
        installs: {},
      },
    } as OpenClawConfig);
    buildPluginSnapshotReport.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    planPluginUninstall.mockReturnValue({
      ok: false,
      error: "Plugin not found: alpha",
    });

    await expect(runPluginsCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain("is not managed by plugins config/install records");
    expect(planPluginUninstall).toHaveBeenCalledTimes(1);
  });
});
