import fs from "node:fs/promises";
import path from "node:path";
import { installedPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Plugins CLI uninstall tests cover plugin removal selection and uninstall output.
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { persistClawPackageRef } from "../claws/provenance.js";
import type { ClawAddPlan } from "../claws/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { recordInstalledPluginIndexInstallOwner } from "../plugins/installed-plugin-index-install-owner.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  applyPluginUninstallDirectoryRemovalMock,
  buildPluginDiagnosticsReportMock,
  buildPluginSnapshotReportMock,
  createTestInstalledPluginIndex,
  parseClawHubPluginSpecMock,
  pluginCliConfigMock,
  planPluginUninstallMock,
  PromptInputClosedError,
  promptYesNoMock,
  readPersistedInstalledPluginIndexMock,
  refreshPluginRegistryMock,
  replaceConfigFileMock,
  resetPluginsCliTestState,
  restorePersistedInstalledPluginIndexIfCurrentMock,
  runPluginsCommand,
  runtimeErrors,
  pluginsCliRuntimeLogs,
  setInstalledPluginIndexInstallRecords,
  configWriteMock,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
} from "./plugins-cli-test-helpers.js";

const CLI_STATE_ROOT = "/tmp/openclaw-state";
const ALPHA_INSTALL_PATH = installedPluginRoot(CLI_STATE_ROOT, "alpha");
const ORIGINAL_OPENCLAW_NIX_MODE = process.env.OPENCLAW_NIX_MODE;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function primeUninstallPlan(
  config: OpenClawConfig,
  overrides: {
    actions?: Record<string, boolean>;
    directoryRemoval?: { target: string } | null;
  } = {},
): void {
  planPluginUninstallMock.mockReturnValue({
    ok: true,
    config,
    actions: {
      entry: true,
      install: true,
      allowlist: false,
      denylist: false,
      loadPath: false,
      memorySlot: false,
      contextEngineSlot: false,
      ...overrides.actions,
      directory: overrides.actions?.directory ?? false,
    },
    directoryRemoval: overrides.directoryRemoval ?? null,
  });
}

function expectRuntimeLogIncludes(fragment: string) {
  expect(pluginsCliRuntimeLogs.join("\n")).toContain(fragment);
}

function expectInstallRecordsWrittenWithLease(records: unknown, config: unknown) {
  expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).toHaveBeenCalledWith(
    records,
    expect.objectContaining({
      config,
      filePath: expect.any(String),
      lease: expect.anything(),
    }),
  );
}

function expectLatestUninstallPlanParams(expected: {
  pluginId: string;
  deleteFiles: boolean;
  channelIds?: unknown;
}) {
  const params = planPluginUninstallMock.mock.calls[
    planPluginUninstallMock.mock.calls.length - 1
  ]?.[0] as { pluginId?: string; deleteFiles?: boolean; channelIds?: unknown } | undefined;
  if (params === undefined) {
    throw new Error("expected latest plugin uninstall plan params");
  }
  expect(params.pluginId).toBe(expected.pluginId);
  expect(params.deleteFiles).toBe(expected.deleteFiles);
  if ("channelIds" in expected) {
    expect(params.channelIds).toEqual(expected.channelIds);
  }
}

describe("plugins cli uninstall", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
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

    expect(planPluginUninstallMock).not.toHaveBeenCalled();
    expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("shows uninstall dry-run preview without mutating config or acquiring write mode", async () => {
    process.env.OPENCLAW_NIX_MODE = "1";
    pluginCliConfigMock.mockReturnValue({
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
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    setInstalledPluginIndexInstallRecords({
      alpha: { source: "path", sourcePath: ALPHA_INSTALL_PATH, installPath: ALPHA_INSTALL_PATH },
    });
    primeUninstallPlan({} as OpenClawConfig, { actions: { contextEngineSlot: true } });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--dry-run"]);

    expect(buildPluginSnapshotReportMock).toHaveBeenCalledTimes(1);
    expect(buildPluginDiagnosticsReportMock).not.toHaveBeenCalled();
    expect(planPluginUninstallMock).toHaveBeenCalledTimes(1);
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
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
        entries: { alpha: { enabled: false } },
        installs: {},
      },
    } as OpenClawConfig;

    pluginCliConfigMock.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(baseConfig.plugins?.installs ?? {});
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    primeUninstallPlan(nextConfig);

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--force", "--keep-files"]);

    expect(promptYesNoMock).not.toHaveBeenCalled();
    expectLatestUninstallPlanParams({ pluginId: "alpha", deleteFiles: false });
    expectInstallRecordsWrittenWithLease(
      {},
      {
        plugins: { entries: { alpha: { enabled: false } } },
      },
    );
    expect(configWriteMock).toHaveBeenCalledWith({
      plugins: {
        entries: { alpha: { enabled: false } },
      },
    });
    expect(replaceConfigFileMock).toHaveBeenCalledWith({
      baseHash: "mock",
      nextConfig: {
        plugins: {
          entries: { alpha: { enabled: false } },
        },
      },
      writeOptions: expect.objectContaining({
        allowConfigSizeDrop: true,
        auditOrigin: "plugin-install",
        afterWrite: { mode: "restart", reason: "plugin source changed" },
        unsetPaths: [["plugins", "installs"]],
      }),
    });
    expect(refreshPluginRegistryMock).toHaveBeenCalledWith({
      config: {
        plugins: {
          entries: { alpha: { enabled: false } },
        },
      },
      installRecords: {},
      reason: "source-changed",
    });
  });

  it("uninstalls the exact plugin id when an earlier plugin uses it as a display name", async () => {
    const baseConfig = {
      plugins: {
        entries: {
          "unrelated-plugin": { enabled: true },
          calendar: { enabled: true },
        },
        installs: {
          "unrelated-plugin": { source: "npm", spec: "unrelated-plugin@1.0.0" },
          calendar: { source: "npm", spec: "calendar@1.0.0" },
        },
      },
    } as OpenClawConfig;
    const nextConfig = {
      plugins: {
        entries: { "unrelated-plugin": { enabled: true } },
        installs: {
          "unrelated-plugin": { source: "npm", spec: "unrelated-plugin@1.0.0" },
        },
      },
    } as OpenClawConfig;

    pluginCliConfigMock.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(baseConfig.plugins?.installs ?? {});
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [
        { id: "unrelated-plugin", name: "calendar" },
        { id: "calendar", name: "Real Calendar" },
      ],
      diagnostics: [],
    });
    primeUninstallPlan(nextConfig);

    await runPluginsCommand(["plugins", "uninstall", "calendar", "--force", "--keep-files"]);

    expectLatestUninstallPlanParams({ pluginId: "calendar", deleteFiles: false });
    expectInstallRecordsWrittenWithLease(
      {
        "unrelated-plugin": { source: "npm", spec: "unrelated-plugin@1.0.0" },
      },
      {
        plugins: {
          entries: { "unrelated-plugin": { enabled: true } },
        },
      },
    );
  });

  it("rejects an ambiguous display name before planning or mutating installed plugins", async () => {
    const baseConfig = {
      plugins: {
        entries: {
          "calendar-one": { enabled: true },
          "calendar-two": { enabled: true },
        },
        installs: {
          "calendar-one": { source: "npm", spec: "calendar-one@1.0.0" },
          "calendar-two": { source: "npm", spec: "calendar-two@1.0.0" },
        },
      },
    } as OpenClawConfig;

    pluginCliConfigMock.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(baseConfig.plugins?.installs ?? {});
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [
        { id: "calendar-one", name: "calendar" },
        { id: "calendar-two", name: "calendar" },
      ],
      diagnostics: [],
    });

    await expect(
      runPluginsCommand(["plugins", "uninstall", "calendar", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain('Plugin uninstall target "calendar" is ambiguous');
    expect(planPluginUninstallMock).not.toHaveBeenCalled();
    expect(promptYesNoMock).not.toHaveBeenCalled();
    expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
  });

  it("warns for a versionless scoped ClawHub spec and proceeds", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-claw-plugin-ref-");
    closeOpenClawStateDatabaseForTest();
    try {
      const { parseClawHubPluginSpec } = await vi.importActual<
        typeof import("../infra/clawhub-spec.js")
      >("../infra/clawhub-spec.js");
      parseClawHubPluginSpecMock.mockImplementation(parseClawHubPluginSpec);
      const installRecord = {
        source: "clawhub" as const,
        spec: "clawhub:@owner/audit",
        version: "2.0.1",
        installPath: ALPHA_INSTALL_PATH,
      };
      const baseConfig = {
        plugins: {
          entries: { alpha: { enabled: true } },
          installs: { alpha: installRecord },
        },
      } as OpenClawConfig;
      pluginCliConfigMock.mockReturnValue(baseConfig);
      setInstalledPluginIndexInstallRecords({ alpha: installRecord });
      buildPluginSnapshotReportMock.mockReturnValue({
        plugins: [{ id: "alpha", name: "alpha" }],
        diagnostics: [],
      });
      primeUninstallPlan({ plugins: { entries: {}, installs: {} } } as OpenClawConfig, {
        actions: { channelConfig: false },
      });
      persistClawPackageRef(
        {
          agent: { finalId: "audit-agent" },
          claw: { name: "@owner/audit-claw" },
        } as ClawAddPlan,
        {
          kind: "plugin",
          source: "clawhub",
          ref: "@owner/audit",
          version: "2.0.1",
          integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        { status: "failed" },
      );

      await runPluginsCommand(["plugins", "uninstall", "alpha", "--force", "--keep-files"]);

      expectRuntimeLogIncludes('Warning: plugin "alpha" is referenced by Claw: @owner/audit-claw.');
      expectRuntimeLogIncludes("Uninstalling it may break those Claws");
      expectInstallRecordsWrittenWithLease({}, { plugins: { entries: {} } });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      closeOpenClawStateDatabaseForTest();
    }
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
    pluginCliConfigMock.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(baseConfig.plugins?.installs ?? {});
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    primeUninstallPlan({ plugins: { entries: {}, installs: {} } } as OpenClawConfig);
    promptYesNoMock.mockRejectedValueOnce(new PromptInputClosedError());

    await expect(runPluginsCommand(["plugins", "uninstall", "alpha"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors).toContain(
      "Error: plugins uninstall requires confirmation input. Re-run in an interactive TTY or pass --force.",
    );
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
    expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
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
    const previousPersistedIndex = createTestInstalledPluginIndex({
      policyHash: "previous-policy",
      installRecords,
    });

    pluginCliConfigMock.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(installRecords);
    readPersistedInstalledPluginIndexMock.mockResolvedValue(previousPersistedIndex);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    primeUninstallPlan(nextConfig);
    replaceConfigFileMock.mockRejectedValueOnce(new Error("config changed"));

    await expect(
      runPluginsCommand(["plugins", "uninstall", "alpha", "--force", "--keep-files"]),
    ).rejects.toThrow("config changed");

    expectInstallRecordsWrittenWithLease({}, { plugins: { entries: {} } });
    expect(restorePersistedInstalledPluginIndexIfCurrentMock).toHaveBeenCalledWith(
      previousPersistedIndex,
      expect.any(Number),
      expect.objectContaining({
        filePath: expect.any(String),
        lease: expect.anything(),
      }),
    );
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
    expect(applyPluginUninstallDirectoryRemovalMock).not.toHaveBeenCalled();
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

    pluginCliConfigMock.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(installRecords);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    primeUninstallPlan(nextConfig, { directoryRemoval: { target: ALPHA_INSTALL_PATH } });
    applyPluginUninstallDirectoryRemovalMock.mockResolvedValue({
      directoryRemoved: true,
      warnings: [],
    });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--force"]);

    const configWriteOrder = configWriteMock.mock.invocationCallOrder[0] ?? 0;
    const deleteOrder =
      applyPluginUninstallDirectoryRemovalMock.mock.invocationCallOrder[0] ??
      Number.MAX_SAFE_INTEGER;
    const finalConfigWriteOrder =
      configWriteMock.mock.invocationCallOrder[1] ?? Number.MAX_SAFE_INTEGER;
    const refreshOrder =
      refreshPluginRegistryMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(configWriteMock).toHaveBeenCalledTimes(2);
    expect(applyPluginUninstallDirectoryRemovalMock).toHaveBeenCalledTimes(1);
    expect(refreshPluginRegistryMock).toHaveBeenCalledTimes(1);
    expect(deleteOrder).toBeGreaterThan(configWriteOrder);
    expect(finalConfigWriteOrder).toBeGreaterThan(deleteOrder);
    expect(refreshOrder).toBeGreaterThan(finalConfigWriteOrder);
    expect(applyPluginUninstallDirectoryRemovalMock).toHaveBeenCalledWith({
      target: ALPHA_INSTALL_PATH,
    });
  });

  it("keeps the install tracked and disabled when directory removal fails", async () => {
    const installPath = tempDirs.make("openclaw-plugin-uninstall-failure-");
    const installRecords = {
      alpha: {
        source: "npm",
        spec: "alpha@1.0.0",
        installPath,
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
    pluginCliConfigMock.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(installRecords);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    primeUninstallPlan({ plugins: { entries: {}, installs: {} } } as OpenClawConfig, {
      directoryRemoval: { target: installPath },
    });
    applyPluginUninstallDirectoryRemovalMock.mockResolvedValue({
      directoryRemoved: false,
      warnings: ["simulated removal failure"],
    });

    await expect(runPluginsCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
      "remains disabled and tracked",
    );

    expect(configWriteMock).toHaveBeenCalledWith({
      plugins: {
        entries: {
          alpha: { enabled: false },
        },
        installs: installRecords,
      },
    });
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "removes owned aliases before deleting files and preserves later edits (retry=%s)",
    async (retry) => {
      const root = await fs.realpath(tempDirs.make("openclaw-cli-uninstall-alias-"));
      const sourcePath = path.join(root, "source");
      const installPath = path.join(root, "extensions", "alpha");
      const aliasPath = path.join(root, "alias");
      const unrelatedPath = path.join(root, "unrelated");
      const addedPath = path.join(root, "added");
      await Promise.all(
        [sourcePath, installPath, unrelatedPath, addedPath].map((dir) =>
          fs.mkdir(dir, { recursive: true }),
        ),
      );
      await fs.symlink(installPath, aliasPath, "dir");
      const installRecords = {
        alpha: { source: "path" as const, sourcePath, installPath },
      };
      let currentConfig: OpenClawConfig = {
        plugins: {
          entries: { alpha: { enabled: true } },
          load: { paths: [aliasPath, unrelatedPath] },
        },
      };
      pluginCliConfigMock.mockImplementation(() => currentConfig);
      configWriteMock.mockImplementation(async (config) => {
        currentConfig = config as OpenClawConfig;
      });
      setInstalledPluginIndexInstallRecords(installRecords);
      buildPluginSnapshotReportMock.mockReturnValue({
        plugins: [
          {
            id: "alpha",
            name: "alpha",
            source: path.join(installPath, "index.js"),
            channelIds: [],
          },
        ],
        diagnostics: [],
      });
      const actual =
        await vi.importActual<typeof import("../plugins/uninstall.js")>("../plugins/uninstall.js");
      planPluginUninstallMock.mockImplementation((params) =>
        actual.planPluginUninstall(params as Parameters<typeof actual.planPluginUninstall>[0]),
      );
      let failRemoval = retry;
      applyPluginUninstallDirectoryRemovalMock.mockImplementation(async (removal) => {
        expect(currentConfig.plugins?.load?.paths).toEqual([unrelatedPath]);
        if (failRemoval) {
          failRemoval = false;
          return { directoryRemoved: false, warnings: ["simulated removal failure"] };
        }
        const result = await actual.applyPluginUninstallDirectoryRemoval(
          removal as Parameters<typeof actual.applyPluginUninstallDirectoryRemoval>[0],
        );
        currentConfig = {
          ...currentConfig,
          logging: { level: "debug" },
          plugins: { ...currentConfig.plugins, load: { paths: [unrelatedPath, addedPath] } },
        };
        return result;
      });
      if (retry) {
        await expect(
          runPluginsCommand(["plugins", "uninstall", "alpha", "--force"]),
        ).rejects.toThrow("remains disabled and tracked");
        expect(currentConfig.plugins?.entries?.alpha).toEqual({ enabled: false });
        expect(
          writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
        ).not.toHaveBeenCalled();
        expect((await fs.stat(installPath)).isDirectory()).toBe(true);
      }

      await runPluginsCommand(["plugins", "uninstall", "alpha", "--force"]);

      expect(currentConfig.plugins?.load?.paths).toEqual([unrelatedPath, addedPath]);
      expect(currentConfig.logging).toEqual({ level: "debug" });
      expect(currentConfig.plugins?.entries?.alpha).toEqual({ enabled: false });
      expect((await fs.stat(sourcePath)).isDirectory()).toBe(true);
      await expect(fs.stat(installPath)).rejects.toMatchObject({ code: "ENOENT" });
      expectInstallRecordsWrittenWithLease({}, currentConfig);
      if (!retry) {
        expectRuntimeLogIncludes("Removed: plugin settings, install record, load path, directory");
      }
    },
  );

  it("rejects stale child-keyed records that claim one package path", async () => {
    const sharedPath = "/tmp/openclaw-ambiguous-uninstall-pack";
    const installRecords = {
      "pack/one": {
        source: "npm" as const,
        spec: "@acme/pack",
        installPath: sharedPath,
      },
      "pack/two": {
        source: "npm" as const,
        spec: "@acme/pack",
        installPath: sharedPath,
      },
    };
    const config = {} as OpenClawConfig;
    pluginCliConfigMock.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(installRecords);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [{ id: "pack/one", name: "pack/one" }],
      diagnostics: [],
    });

    await expect(
      runPluginsCommand(["plugins", "uninstall", "pack/one", "--force"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain('Plugin "pack/one"');
    expect(planPluginUninstallMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("fails closed for stale policy refs without authoritative installed children", async () => {
    const baseConfig = {
      plugins: {
        allow: ["alpha", "beta"],
        deny: ["alpha"],
      },
    } as OpenClawConfig;
    pluginCliConfigMock.mockReturnValue(baseConfig);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    await expect(runPluginsCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
      "__exit__:1",
    );
    expect(planPluginUninstallMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("fails closed for stale enabled entries without authoritative installed children", async () => {
    const baseConfig = {
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig;
    pluginCliConfigMock.mockReturnValue(baseConfig);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });

    await expect(runPluginsCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
      "__exit__:1",
    );
    expect(planPluginUninstallMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "a disabled channel plugin",
      status: "disabled",
      channelIds: ["custom-channel", "custom-channel-backup"],
    },
    { label: "a loaded channel plugin", status: "loaded", channelIds: ["custom-channel"] },
    { label: "a disabled non-channel plugin", status: "disabled", channelIds: [] },
  ])("preserves manifest channel ownership for $label", async ({ status, channelIds }) => {
    const pluginId = "custom-plugin";
    const installRecords = {
      [pluginId]: {
        source: "npm",
        spec: "@acme/custom-plugin@1.0.0",
        installPath: installedPluginRoot(CLI_STATE_ROOT, pluginId),
      },
    } as const;
    const channels = {
      [pluginId]: { enabled: true },
      "custom-channel": { enabled: true },
      "custom-channel-backup": { enabled: true },
      discord: { enabled: true },
    };
    const baseConfig = {
      plugins: {
        entries: {
          [pluginId]: { enabled: status === "loaded" },
        },
        installs: installRecords,
      },
      channels,
    } as OpenClawConfig;

    pluginCliConfigMock.mockReturnValue(baseConfig);
    setInstalledPluginIndexInstallRecords(installRecords);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [
        { id: pluginId, name: pluginId, status, channelIds },
        {
          id: "shared-channel-owner",
          name: "shared-channel-owner",
          status: "loaded",
          channelIds: [pluginId],
        },
      ],
      diagnostics: [],
    });
    const actualUninstall =
      await vi.importActual<typeof import("../plugins/uninstall.js")>("../plugins/uninstall.js");
    planPluginUninstallMock.mockImplementation((params) =>
      actualUninstall.planPluginUninstall(
        params as Parameters<typeof actualUninstall.planPluginUninstall>[0],
      ),
    );

    await runPluginsCommand(["plugins", "uninstall", pluginId, "--force", "--keep-files"]);

    expectLatestUninstallPlanParams({ pluginId, channelIds, deleteFiles: false });
    expectInstallRecordsWrittenWithLease(
      {},
      expect.objectContaining({
        channels: Object.fromEntries(
          Object.entries(channels).filter(([channelId]) => !channelIds.includes(channelId)),
        ),
      }),
    );
    expect(configWriteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: Object.fromEntries(
          Object.entries(channels).filter(([channelId]) => !channelIds.includes(channelId)),
        ),
      }),
    );
    for (const channelId of channelIds) {
      expectRuntimeLogIncludes(`channel config (channels.${channelId})`);
    }
  });

  it.each([false, true])(
    "preserves another channel owner during orphan uninstall: %s",
    async (claimed) => {
      const pluginId = "orphan-channel-plugin";
      const installRecords = {
        [pluginId]: {
          source: "path",
          sourcePath: "/tmp/missing-orphan-channel-source",
          installPath: "/tmp/missing-orphan-channel-install",
        },
      } as const;
      const baseConfig = {
        channels: {
          [pluginId]: { enabled: true },
          discord: { enabled: true },
        },
      } as OpenClawConfig;
      pluginCliConfigMock.mockReturnValue(baseConfig);
      setInstalledPluginIndexInstallRecords(installRecords);
      buildPluginSnapshotReportMock.mockReturnValue({
        plugins: [],
        diagnostics: [],
      });
      const actualUninstall =
        await vi.importActual<typeof import("../plugins/uninstall.js")>("../plugins/uninstall.js");
      planPluginUninstallMock.mockImplementation((params) =>
        actualUninstall.planPluginUninstall(
          params as Parameters<typeof actualUninstall.planPluginUninstall>[0],
        ),
      );
      const installedIndexModule = await import("../plugins/installed-plugin-index.js");
      const indexSpy = vi.spyOn(installedIndexModule, "loadInstalledPluginIndex").mockReturnValue(
        createTestInstalledPluginIndex({
          policyHash: "orphan-channel",
          installRecords,
          plugins: claimed
            ? [
                {
                  pluginId: "bridge",
                  rootDir: "/tmp/bridge",
                  manifestPath: "/tmp/bridge/openclaw.plugin.json",
                  manifestHash: "bridge",
                  origin: "global",
                  enabled: true,
                  startup: { sidecar: false, memory: false, agentHarnesses: [] },
                  packageChannel: { id: pluginId },
                  compat: [],
                },
              ]
            : [],
        }),
      );
      try {
        await runPluginsCommand(["plugins", "uninstall", pluginId, "--force", "--keep-files"]);

        expectLatestUninstallPlanParams({
          pluginId,
          channelIds: claimed ? [] : undefined,
          deleteFiles: false,
        });
        expectInstallRecordsWrittenWithLease(
          {},
          {
            channels: {
              ...(claimed ? { [pluginId]: { enabled: true } } : {}),
              discord: { enabled: true },
            },
            plugins: {
              entries: {
                [pluginId]: { enabled: false },
              },
            },
          },
        );
      } finally {
        indexSpy.mockRestore();
      }
    },
  );

  it.each(["pack", "pack/one"])(
    "cleans declared singleton channels through %s",
    async (requestedId) => {
      const installPath = "/tmp/singleton-pack";
      const installRecords = {
        pack: { source: "path", sourcePath: installPath, installPath },
      } as const;
      pluginCliConfigMock.mockReturnValue({
        channels: { chat: { enabled: true }, "pack/one": { enabled: true } },
      } as OpenClawConfig);
      setInstalledPluginIndexInstallRecords(installRecords);
      buildPluginSnapshotReportMock.mockReturnValue({
        plugins: [{ id: "pack/one", name: "One", status: "loaded", channelIds: ["chat"] }],
        diagnostics: [],
      });
      const actualUninstall =
        await vi.importActual<typeof import("../plugins/uninstall.js")>("../plugins/uninstall.js");
      planPluginUninstallMock.mockImplementation((params) =>
        actualUninstall.planPluginUninstall(
          params as Parameters<typeof actualUninstall.planPluginUninstall>[0],
        ),
      );
      const installedIndexModule = await import("../plugins/installed-plugin-index.js");
      const indexSpy = vi.spyOn(installedIndexModule, "loadInstalledPluginIndex").mockReturnValue(
        createTestInstalledPluginIndex({
          policyHash: "singleton",
          installRecords,
          plugins: [
            recordInstalledPluginIndexInstallOwner(
              {
                pluginId: "pack/one",
                rootDir: installPath,
                manifestPath: `${installPath}/openclaw.plugin.json`,
                manifestHash: "one",
                origin: "global" as const,
                enabled: true,
                startup: { sidecar: false, memory: false, agentHarnesses: [] },
                compat: [],
              },
              "pack",
            ),
          ],
        }),
      );
      try {
        await runPluginsCommand(["plugins", "uninstall", requestedId, "--force", "--keep-files"]);
        expectInstallRecordsWrittenWithLease(
          {},
          {
            channels: { "pack/one": { enabled: true } },
            plugins: { entries: { "pack/one": { enabled: false } } },
          },
        );
      } finally {
        indexSpy.mockRestore();
      }
    },
  );

  it("exits when uninstall target is not managed by plugin install records", async () => {
    pluginCliConfigMock.mockReturnValue({
      plugins: {
        entries: {},
        installs: {},
      },
    } as OpenClawConfig);
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [{ id: "alpha", name: "alpha" }],
      diagnostics: [],
    });
    planPluginUninstallMock.mockReturnValue({
      ok: false,
      error: "Plugin not found: alpha",
    });

    await expect(runPluginsCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain("is not associated with a tracked package install");
    expect(planPluginUninstallMock).not.toHaveBeenCalled();
  });
});
