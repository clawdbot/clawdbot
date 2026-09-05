import { installedPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Plugins CLI uninstall tests cover plugin removal selection and uninstall output.
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { persistClawPackageRef } from "../claws/provenance.js";
import type { ClawAddPlan } from "../claws/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { recordPluginManifestInstallOwner } from "../plugins/manifest-install-owner.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  applyPluginUninstallDirectoryRemovalMock,
  createTestInstalledPluginIndex,
  parseClawHubPluginSpecMock,
  pluginCliConfigMock,
  loadPluginManifestRegistryMock,
  planPluginUninstallMock,
  PromptInputClosedError,
  promptYesNoMock,
  readPersistedInstalledPluginIndexMock,
  refreshPluginRegistryMock,
  pluginRegistryRefreshInputs,
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

function mockUninstallManifestRegistry(
  plugins: { id: string; name?: string; channelIds?: string[]; installOwner?: string }[],
): void {
  loadPluginManifestRegistryMock.mockImplementation((input: unknown) => {
    const installRecords =
      (input as { installRecords?: Record<string, PluginInstallRecord> } | undefined)
        ?.installRecords ?? {};
    return {
      plugins: plugins.map(({ id, name, channelIds, installOwner = id }) => {
        const record = installRecords[installOwner];
        const rootDir =
          record?.installPath ?? record?.sourcePath ?? installedPluginRoot(CLI_STATE_ROOT, id);
        return recordPluginManifestInstallOwner(
          {
            id,
            name,
            channels: channelIds ?? [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            origin: "global",
            rootDir,
            source: `${rootDir}/index.js`,
            manifestPath: `${rootDir}/openclaw.plugin.json`,
          },
          record ? installOwner : undefined,
        );
      }),
      diagnostics: [],
    };
  });
}

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
    setInstalledPluginIndexInstallRecords({
      alpha: { source: "path", sourcePath: ALPHA_INSTALL_PATH, installPath: ALPHA_INSTALL_PATH },
    });
    primeUninstallPlan({} as OpenClawConfig, { actions: { contextEngineSlot: true } });

    await runPluginsCommand(["plugins", "uninstall", "alpha", "--dry-run"]);

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
    expect(pluginRegistryRefreshInputs()).toEqual([
      {
        config: {
          plugins: {
            entries: { alpha: { enabled: false } },
          },
        },
        installRecords: {},
        reason: "source-changed",
      },
    ]);
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
    mockUninstallManifestRegistry([
      { id: "unrelated-plugin", name: "calendar" },
      { id: "calendar", name: "Real Calendar" },
    ]);
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
    mockUninstallManifestRegistry([
      { id: "calendar-one", name: "calendar" },
      { id: "calendar-two", name: "calendar" },
    ]);

    await expect(
      runPluginsCommand(["plugins", "uninstall", "calendar", "--force"]),
    ).rejects.toThrow('Plugin uninstall target "calendar" is ambiguous');
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
    expect(applyPluginUninstallDirectoryRemovalMock.mock.calls[0]?.[0]).toEqual({
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

    await expect(
      runPluginsCommand(["plugins", "uninstall", "pack/one", "--force"]),
    ).rejects.toThrow('Plugin "pack/one" shares package path ownership');
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

    await expect(runPluginsCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
      "is not associated with a tracked package install",
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

    await expect(runPluginsCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
      "is not associated with a tracked package install",
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
    mockUninstallManifestRegistry([
      { id: pluginId, channelIds },
      { id: "shared-channel-owner", channelIds: [pluginId] },
    ]);
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
      const retainedInstallRecords = {
        bridge: {
          source: "path",
          sourcePath: "/tmp/bridge-channel-source",
          installPath: "/tmp/bridge-channel-install",
        },
      } as const;
      const installRecords = {
        ...retainedInstallRecords,
        [pluginId]: {
          source: "path",
          sourcePath: "/tmp/missing-orphan-channel-source",
          installPath: "/tmp/missing-orphan-channel-install",
        },
      } as const;
      pluginCliConfigMock.mockReturnValue({
        channels: {
          [pluginId]: { enabled: true },
          discord: { enabled: true },
        },
      } as OpenClawConfig);
      setInstalledPluginIndexInstallRecords(installRecords);
      mockUninstallManifestRegistry([{ id: "bridge", channelIds: claimed ? [pluginId] : [] }]);
      const actualUninstall =
        await vi.importActual<typeof import("../plugins/uninstall.js")>("../plugins/uninstall.js");
      planPluginUninstallMock.mockImplementation((params) =>
        actualUninstall.planPluginUninstall(
          params as Parameters<typeof actualUninstall.planPluginUninstall>[0],
        ),
      );
      await runPluginsCommand(["plugins", "uninstall", pluginId, "--force", "--keep-files"]);

      expectLatestUninstallPlanParams({
        pluginId,
        channelIds: claimed ? [] : undefined,
        deleteFiles: false,
      });
      const nextConfig = {
        channels: {
          ...(claimed ? { [pluginId]: { enabled: true } } : {}),
          discord: { enabled: true },
        },
        plugins: {
          entries: { [pluginId]: { enabled: false } },
        },
      };
      expectInstallRecordsWrittenWithLease(retainedInstallRecords, nextConfig);
      expect(configWriteMock).toHaveBeenCalledWith(nextConfig);
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
      mockUninstallManifestRegistry([
        { id: "pack/one", name: "One", channelIds: ["chat"], installOwner: "pack" },
      ]);
      const actualUninstall =
        await vi.importActual<typeof import("../plugins/uninstall.js")>("../plugins/uninstall.js");
      planPluginUninstallMock.mockImplementation((params) =>
        actualUninstall.planPluginUninstall(
          params as Parameters<typeof actualUninstall.planPluginUninstall>[0],
        ),
      );
      await runPluginsCommand(["plugins", "uninstall", requestedId, "--force", "--keep-files"]);
      expectInstallRecordsWrittenWithLease(
        {},
        {
          channels: { "pack/one": { enabled: true } },
          plugins: { entries: { "pack/one": { enabled: false } } },
        },
      );
    },
  );

  it("exits when uninstall target is not managed by plugin install records", async () => {
    pluginCliConfigMock.mockReturnValue({
      plugins: {
        entries: {},
        installs: {},
      },
    } as OpenClawConfig);
    planPluginUninstallMock.mockReturnValue({
      ok: false,
      error: "Plugin not found: alpha",
    });

    await expect(runPluginsCommand(["plugins", "uninstall", "alpha", "--force"])).rejects.toThrow(
      "is not associated with a tracked package install",
    );

    expect(planPluginUninstallMock).not.toHaveBeenCalled();
  });
});
