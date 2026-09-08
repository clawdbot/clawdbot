// Channel auth CLI tests cover channel auth command routing and credential prompts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { materializePluginAutoEnableCandidates } from "../config/plugin-auto-enable.apply.js";
import { makeRegistry } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runChannelLogin, runChannelLogout } from "./channel-auth.js";

const mocks = vi.hoisted(() => ({
  resolveAgentWorkspaceDir: vi.fn(),
  getChannelPluginCatalogEntry: vi.fn(),
  listChannelPluginCatalogEntries: vi.fn(),
  resolveChannelDefaultAccountId: vi.fn(),
  getLoadedChannelPlugin: vi.fn(),
  listChannelPlugins: vi.fn(),
  normalizeChannelId: vi.fn(),
  loadConfig: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  replaceConfigFile: vi.fn(),
  commitConfigWithPendingPluginInstalls: vi.fn(),
  setVerbose: vi.fn(),
  callGateway: vi.fn(),
  createClackPrompter: vi.fn(),
  ensureChannelSetupPluginInstalled: vi.fn(),
  loadChannelSetupPluginRegistrySnapshotForChannel: vi.fn(),
  login: vi.fn(),
  logoutAccount: vi.fn(),
  resolveAccount: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("../channels/plugins/catalog.js", () => ({
  getChannelPluginCatalogEntry: mocks.getChannelPluginCatalogEntry,
  listRawChannelPluginCatalogEntries: mocks.listChannelPluginCatalogEntries,
}));

vi.mock("../channels/plugins/helpers.js", () => ({
  resolveChannelDefaultAccountId: mocks.resolveChannelDefaultAccountId,
}));

vi.mock("../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: mocks.getLoadedChannelPlugin,
  listChannelPlugins: mocks.listChannelPlugins,
  normalizeChannelId: mocks.normalizeChannelId,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.loadConfig,
  loadConfig: mocks.loadConfig,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: await mocks.readConfigFileSnapshot(),
    writeOptions: {},
  }),
  replaceConfigFile: mocks.replaceConfigFile,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../globals.js", () => ({
  setVerbose: mocks.setVerbose,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../plugins/install-record-commit.js", () => ({
  commitConfigWithPendingPluginInstalls: mocks.commitConfigWithPendingPluginInstalls,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("../commands/channel-setup/plugin-install.js", () => ({
  ensureChannelSetupPluginInstalled: mocks.ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel:
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel,
}));

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

function readFirstCallArg(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [arg] = mock.mock.calls[0] ?? [];
  if (!arg || typeof arg !== "object") {
    throw new Error("expected first call argument object");
  }
  return arg as Record<string, unknown>;
}

function readFirstLogMessage(runtime: { log: ReturnType<typeof vi.fn> }): string {
  const [message] = runtime.log.mock.calls[0] ?? [];
  return String(message);
}

function gatewayRequestError(message: string, gatewayCode: string): Error {
  const error = new Error(message) as Error & { gatewayCode: string };
  error.name = "GatewayClientRequestError";
  error.gatewayCode = gatewayCode;
  return error;
}

function findCallArg(
  mock: ReturnType<typeof vi.fn>,
  predicate: (arg: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  for (const [arg] of mock.mock.calls) {
    if (arg && typeof arg === "object" && predicate(arg as Record<string, unknown>)) {
      return arg as Record<string, unknown>;
    }
  }
  return undefined;
}

describe("channel-auth", () => {
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const plugin = {
    id: "whatsapp",
    auth: { login: mocks.login },
    gateway: { startAccount: vi.fn(), logoutAccount: mocks.logoutAccount },
    config: {
      listAccountIds: vi.fn().mockReturnValue(["default"]),
      resolveAccount: mocks.resolveAccount,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.normalizeChannelId.mockReturnValue("whatsapp");
    mocks.getLoadedChannelPlugin.mockReturnValue(plugin);
    mocks.getChannelPluginCatalogEntry.mockReturnValue(undefined);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([]);
    mocks.loadConfig.mockReturnValue({ channels: { whatsapp: {} } });
    mocks.readConfigFileSnapshot.mockImplementation(async () => ({
      hash: "config-1",
      valid: true,
      sourceConfig: mocks.loadConfig(),
    }));
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.replaceConfigFile.mockImplementation(async ({ sourceConfig }) => {
      mocks.loadConfig.mockReturnValue(sourceConfig);
    });
    mocks.commitConfigWithPendingPluginInstalls.mockImplementation(
      async ({
        sourceConfig,
        baseHash,
      }: {
        sourceConfig: { plugins?: { installs?: Record<string, unknown> } };
        baseHash?: string;
      }) => {
        if (
          !sourceConfig.plugins?.installs ||
          Object.keys(sourceConfig.plugins.installs).length === 0
        ) {
          await mocks.replaceConfigFile({
            sourceConfig,
            ...(baseHash !== undefined ? { baseHash } : {}),
          });
          return {
            config: sourceConfig,
            installRecords: {},
            movedInstallRecords: false,
          };
        }
        const { installs: _installs, ...plugins } = sourceConfig.plugins;
        const strippedConfig =
          Object.keys(plugins).length > 0
            ? { ...sourceConfig, plugins }
            : Object.fromEntries(Object.entries(sourceConfig).filter(([key]) => key !== "plugins"));
        await mocks.replaceConfigFile({
          sourceConfig: strippedConfig,
          ...(baseHash !== undefined ? { baseHash } : {}),
          writeOptions: { unsetPaths: [["plugins", "installs"]] },
        });
        return {
          config: strippedConfig,
          installRecords: sourceConfig.plugins.installs,
          movedInstallRecords: true,
        };
      },
    );
    mocks.callGateway.mockResolvedValue({ cleared: true, loggedOut: true });
    mocks.listChannelPlugins.mockReturnValue([plugin]);
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/workspace");
    mocks.resolveChannelDefaultAccountId.mockReturnValue("default-account");
    mocks.createClackPrompter.mockReturnValue({} as object);
    mocks.ensureChannelSetupPluginInstalled.mockResolvedValue({
      cfg: { channels: { whatsapp: {} } },
      installed: true,
      pluginId: "whatsapp",
    });
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue({
      channels: [{ plugin }],
      channelSetups: [],
    });
    mocks.resolveAccount.mockReturnValue({ id: "resolved-account" });
    mocks.login.mockResolvedValue(undefined);
    mocks.logoutAccount.mockResolvedValue({ cleared: true, loggedOut: true });
  });

  it.each([
    ["login", runChannelLogin, mocks.login],
    ["logout", runChannelLogout, mocks.logoutAccount],
  ] as const)(
    "uses source intent and the active runtime snapshot for %s",
    async (_mode, run, action) => {
      const sourceConfig: OpenClawConfig = { channels: { whatsapp: {} } };
      mocks.readConfigFileSnapshot.mockResolvedValue({
        hash: "config-1",
        valid: true,
        sourceConfig,
      });
      const runtimeConfig: OpenClawConfig = {
        ...sourceConfig,
        agents: { defaults: { maxConcurrent: 4 } },
        plugins: { entries: { "memory-core": { config: {} } } },
      };
      mocks.loadConfig.mockReturnValue(runtimeConfig);
      mocks.callGateway.mockRejectedValue(new Error("gateway unreachable"));

      await run({ channel: "whatsapp" }, runtime);

      expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
        config: sourceConfig,
        env: process.env,
      });
      expect(readFirstCallArg(action).cfg).toBe(runtimeConfig);
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["login", runChannelLogin, mocks.login],
    ["logout", runChannelLogout, mocks.logoutAccount],
  ] as const)("uses runtime account callbacks when inferring %s", async (_mode, run, action) => {
    const sourceConfig: OpenClawConfig = {
      channels: { whatsapp: { accounts: { work: { authDir: "~/wa-work", enabled: true } } } },
    };
    const runtimeConfig: OpenClawConfig = {
      channels: {
        whatsapp: { accounts: { work: { authDir: "/runtime/wa-work", enabled: true } } },
      },
      agents: { defaults: { maxConcurrent: 4 } },
    };
    const listAccountIds = vi.fn((cfg: OpenClawConfig) =>
      Object.keys(cfg.channels?.whatsapp?.accounts ?? {}),
    );
    const resolveAccount = vi.fn(
      (cfg: OpenClawConfig, accountId: string) => cfg.channels?.whatsapp?.accounts?.[accountId],
    );
    const isEnabled = vi.fn(
      (account: { enabled?: boolean } | undefined, cfg: OpenClawConfig) =>
        cfg.channels?.whatsapp?.enabled !== false && account?.enabled !== false,
    );
    const selectedPlugin = { ...plugin, config: { listAccountIds, resolveAccount, isEnabled } };
    mocks.listChannelPlugins.mockReturnValue([selectedPlugin]);
    mocks.getLoadedChannelPlugin.mockReturnValue(selectedPlugin);
    mocks.readConfigFileSnapshot.mockResolvedValue({ hash: "config-1", valid: true, sourceConfig });
    mocks.loadConfig.mockReturnValue(runtimeConfig);
    mocks.callGateway.mockRejectedValue(new Error("gateway unreachable"));

    await run({ account: "work" }, runtime);

    expect(readFirstCallArg(action).cfg).toBe(runtimeConfig);
    expect(listAccountIds.mock.calls[0]?.[0]).toBe(runtimeConfig);
    expect(resolveAccount.mock.calls[0]?.[0]).toBe(runtimeConfig);
    expect(isEnabled.mock.calls[0]?.[1]).toBe(runtimeConfig);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("keeps repeated credential-free logout free of runtime-only plugin activation writes", async () => {
    const sourceConfig: OpenClawConfig = {
      channels: { whatsapp: { enabled: false } },
      plugins: { allow: ["whatsapp"], entries: { whatsapp: { enabled: true } } },
    };
    mocks.readConfigFileSnapshot.mockResolvedValue({ hash: "config-1", valid: true, sourceConfig });
    mocks.applyPluginAutoEnable.mockImplementation(({ config }: { config: OpenClawConfig }) =>
      materializePluginAutoEnableCandidates({
        config,
        candidates: [],
        manifestRegistry: makeRegistry([{ id: "memory-core", channels: [], origin: "bundled" }]),
      }),
    );
    mocks.callGateway.mockRejectedValue(new Error("gateway unreachable"));
    mocks.logoutAccount.mockResolvedValue({ cleared: false, loggedOut: true });
    mocks.loadConfig.mockReturnValue(sourceConfig);

    await runChannelLogout({ channel: "whatsapp" }, runtime);

    // Runtime plugin schema defaults can appear on a later invocation.
    const laterRuntimeConfig: OpenClawConfig = {
      ...sourceConfig,
      plugins: {
        ...sourceConfig.plugins,
        entries: { ...sourceConfig.plugins?.entries, "memory-core": { config: {} } },
      },
    };
    mocks.loadConfig.mockReturnValue(laterRuntimeConfig);
    await runChannelLogout({ channel: "whatsapp" }, runtime);

    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.logoutAccount.mock.calls.map(([context]) => context.cfg)).toEqual([
      sourceConfig,
      laterRuntimeConfig,
    ]);
  });

  it("runs login with explicit trimmed account and verbose flag", async () => {
    await runChannelLogin({ channel: "wa", account: "  acct-1  ", verbose: true }, runtime);

    expect(mocks.setVerbose).toHaveBeenCalledWith(true);
    expect(mocks.resolveChannelDefaultAccountId).not.toHaveBeenCalled();
    expectFields(readFirstCallArg(mocks.login), {
      cfg: { channels: { whatsapp: {} } },
      accountId: "acct-1",
      runtime,
      verbose: true,
      channelInput: "wa",
    });
    expect(mocks.callGateway).toHaveBeenCalledWith({
      config: { channels: { whatsapp: {} } },
      method: "channels.start",
      params: {
        channel: "whatsapp",
        accountId: "acct-1",
      },
      mode: "backend",
      clientName: "gateway-client",
      deviceIdentity: null,
    });
  });

  it("skips gateway runtime reconcile in remote mode and warns without failing login", async () => {
    mocks.loadConfig.mockReturnValue({
      gateway: { mode: "remote" },
      channels: { whatsapp: {} },
    });

    await runChannelLogin({ channel: "whatsapp", account: "acct-1" }, runtime);

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(readFirstLogMessage(runtime)).toContain("Gateway is in remote mode");
  });

  it.each([
    { status: "skipped", reason: "unconfigured" },
    { status: "retry", reason: "stop-in-flight" },
  ] as const)("reports a $reason start decision after saving login", async (outcome) => {
    mocks.callGateway.mockResolvedValue({ started: false, outcome });

    await expect(
      runChannelLogin({ channel: "whatsapp", account: "acct-1" }, runtime),
    ).resolves.toBeUndefined();

    expect(mocks.login).toHaveBeenCalledOnce();
    expect(mocks.callGateway).toHaveBeenCalledOnce();
    expect(readFirstLogMessage(runtime)).toContain(`whatsapp/acct-1`);
    expect(readFirstLogMessage(runtime)).toContain(outcome.reason);
    expect(readFirstLogMessage(runtime)).toContain(
      "openclaw channels status --channel whatsapp --probe",
    );
  });

  it.each([true, false])(
    "accepts an older Gateway start response (started=%s)",
    async (started) => {
      mocks.callGateway.mockResolvedValue({ channel: "whatsapp", accountId: "acct-1", started });

      await runChannelLogin({ channel: "whatsapp", account: "acct-1" }, runtime);

      expect(mocks.callGateway).toHaveBeenCalledOnce();
      expect(runtime.log).not.toHaveBeenCalled();
    },
  );

  it("keeps login successful when local gateway runtime reconcile fails", async () => {
    mocks.callGateway.mockRejectedValue(new Error("gateway unreachable"));

    await expect(
      runChannelLogin({ channel: "whatsapp", account: "acct-1" }, runtime),
    ).resolves.toBeUndefined();

    expect(readFirstLogMessage(runtime)).toContain(
      "running gateway did not restart it: gateway unreachable",
    );
  });

  it("requests gateway restart when channels.start fails because plugin is not loaded", async () => {
    mocks.callGateway
      .mockRejectedValueOnce(
        gatewayRequestError("invalid channels.start channel", "INVALID_REQUEST"),
      )
      .mockResolvedValueOnce(undefined);

    await runChannelLogin({ channel: "whatsapp", account: "acct-1" }, runtime);

    expect(mocks.callGateway).toHaveBeenCalledTimes(2);
    expect(mocks.callGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "channels.start",
      }),
    );
    expect(mocks.callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "gateway.restart.request",
        params: { reason: "channel login: load whatsapp" },
      }),
    );
    expect(readFirstLogMessage(runtime)).toContain("Gateway restart requested to load whatsapp");
  });

  it("falls back to generic warning when both channels.start and gateway restart fail", async () => {
    mocks.callGateway
      .mockRejectedValueOnce(
        gatewayRequestError("invalid channels.start channel", "INVALID_REQUEST"),
      )
      .mockRejectedValueOnce(new Error("restart denied"));

    await expect(
      runChannelLogin({ channel: "whatsapp", account: "acct-1" }, runtime),
    ).resolves.toBeUndefined();

    expect(mocks.callGateway).toHaveBeenCalledTimes(2);
    expect(readFirstLogMessage(runtime)).toContain(
      "running gateway did not restart it: invalid channels.start channel",
    );
  });

  it.each([
    ["plain error", new Error("invalid channels.start channel")],
    [
      "plugin start failure",
      gatewayRequestError("plugin failed: unknown channel upstream", "UNAVAILABLE"),
    ],
    [
      "different invalid request",
      gatewayRequestError("unknown channel: whatsapp", "INVALID_REQUEST"),
    ],
  ])("does not restart for %s", async (_label, error) => {
    mocks.callGateway.mockRejectedValue(error);

    await runChannelLogin({ channel: "whatsapp", account: "acct-1" }, runtime);

    expect(mocks.callGateway).toHaveBeenCalledTimes(1);
    expect(readFirstLogMessage(runtime)).toContain("running gateway did not restart it:");
  });

  it("auto-picks the single configured channel that supports login when opts are empty", async () => {
    await runChannelLogin({}, runtime);

    expect(mocks.normalizeChannelId).toHaveBeenCalledWith("whatsapp");
    expectFields(readFirstCallArg(mocks.login), { channelInput: "whatsapp" });
  });

  it("does not auto-pick enabled-only channel stubs when channel is omitted", async () => {
    mocks.loadConfig.mockReturnValue({ channels: { whatsapp: { enabled: false } } });

    await expect(runChannelLogin({}, runtime)).rejects.toThrow(
      "No configured channel supports login.",
    );
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it("auto-picks the single auth-capable channel from the auto-enabled config snapshot", async () => {
    const sourceConfig: OpenClawConfig = {
      channels: { whatsapp: {} },
      plugins: { allow: ["whatsapp"] },
    };
    const autoEnabledCfg = {
      ...sourceConfig,
      channels: { whatsapp: { enabled: true } },
    };
    const runtimeConfig = { ...sourceConfig, agents: { defaults: { maxConcurrent: 4 } } };
    const refreshedRuntimeConfig = {
      ...autoEnabledCfg,
      agents: { defaults: { maxConcurrent: 4 } },
    };
    mocks.readConfigFileSnapshot.mockResolvedValue({ hash: "config-1", valid: true, sourceConfig });
    mocks.loadConfig.mockReturnValue(runtimeConfig);
    mocks.applyPluginAutoEnable.mockImplementation(({ config }: { config: OpenClawConfig }) =>
      materializePluginAutoEnableCandidates({
        config,
        candidates: [{ pluginId: "whatsapp", kind: "channel-configured", channelId: "whatsapp" }],
        manifestRegistry: makeRegistry([
          { id: "whatsapp", channels: ["whatsapp"], origin: "bundled" },
        ]),
      }),
    );
    mocks.resolveAccount.mockImplementation((cfg: OpenClawConfig) => ({
      enabled: cfg.channels?.whatsapp?.enabled === true,
    }));
    mocks.replaceConfigFile.mockImplementation(async () => {
      mocks.loadConfig.mockReturnValue(refreshedRuntimeConfig);
    });

    await runChannelLogin({}, runtime);

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: sourceConfig,
      env: process.env,
    });
    expectFields(readFirstCallArg(mocks.login), {
      cfg: refreshedRuntimeConfig,
      channelInput: "whatsapp",
    });
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      sourceConfig: autoEnabledCfg,
      baseHash: "config-1",
    });
    expect(mocks.resolveAccount.mock.calls[0]?.[0]).toEqual(refreshedRuntimeConfig);
  });

  it("persists auto-enabled config during logout auto-pick too", async () => {
    const autoEnabledCfg = { channels: { whatsapp: {} }, plugins: { allow: ["whatsapp"] } };
    mocks.loadConfig.mockReturnValue({});
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledCfg, changes: ["whatsapp"] });

    await runChannelLogout({}, runtime);

    expectFields(readFirstCallArg(mocks.callGateway), {
      config: autoEnabledCfg,
      method: "channels.logout",
    });
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      sourceConfig: autoEnabledCfg,
      baseHash: "config-1",
    });
  });

  it("ignores configured channels that do not support login when channel is omitted", async () => {
    const telegramPlugin = {
      id: "telegram",
      auth: {},
      gateway: {},
      config: {
        listAccountIds: vi.fn().mockReturnValue(["default"]),
        resolveAccount: vi.fn().mockReturnValue({ enabled: true }),
      },
    };
    mocks.loadConfig.mockReturnValue({ channels: { whatsapp: {}, telegram: {} } });
    mocks.listChannelPlugins.mockReturnValue([telegramPlugin, plugin]);

    await runChannelLogin({}, runtime);

    expect(mocks.normalizeChannelId).toHaveBeenCalledWith("whatsapp");
    expect(mocks.login).toHaveBeenCalledTimes(1);
  });

  it("propagates auth-channel ambiguity when multiple configured channels support login", async () => {
    const zaloPlugin = {
      id: "zalouser",
      auth: { login: vi.fn() },
      gateway: {},
      config: {
        listAccountIds: vi.fn().mockReturnValue(["default"]),
        resolveAccount: vi.fn().mockReturnValue({ enabled: true }),
      },
    };
    mocks.loadConfig.mockReturnValue({ channels: { whatsapp: {}, zalouser: {} } });
    mocks.applyPluginAutoEnable.mockImplementation(({ config }: { config: OpenClawConfig }) =>
      materializePluginAutoEnableCandidates({
        config,
        candidates: [{ pluginId: "whatsapp", kind: "channel-configured", channelId: "whatsapp" }],
        manifestRegistry: makeRegistry([
          { id: "whatsapp", channels: ["whatsapp"], origin: "bundled" },
        ]),
      }),
    );
    mocks.listChannelPlugins.mockReturnValue([plugin, zaloPlugin]);
    mocks.normalizeChannelId.mockImplementation((value) => value);
    mocks.getLoadedChannelPlugin.mockImplementation((value) =>
      value === "whatsapp"
        ? plugin
        : value === "zalouser"
          ? (zaloPlugin as typeof plugin)
          : undefined,
    );

    await expect(runChannelLogin({}, runtime)).rejects.toThrow(
      "Multiple configured channels support login: whatsapp, zalouser.",
    );
    expect(mocks.login).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("ignores plugins with prototype-chain IDs like __proto__", async () => {
    const protoPlugin = {
      id: "__proto__",
      auth: { login: vi.fn() },
      gateway: {},
      config: {
        listAccountIds: vi.fn().mockReturnValue(["default"]),
        resolveAccount: vi.fn().mockReturnValue({ enabled: true }),
      },
    };
    mocks.listChannelPlugins.mockReturnValue([protoPlugin, plugin]);

    await runChannelLogin({}, runtime);

    expect(mocks.normalizeChannelId).toHaveBeenCalledWith("whatsapp");
    expect(mocks.login).toHaveBeenCalledTimes(1);
  });

  it("throws for unsupported channel aliases", async () => {
    mocks.normalizeChannelId.mockImplementation(() => undefined);

    await expect(runChannelLogin({ channel: "bad-channel" }, runtime)).rejects.toThrow(
      'Unsupported channel "bad-channel".',
    );
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it("throws when channel does not support login", async () => {
    mocks.getLoadedChannelPlugin.mockReturnValueOnce({
      auth: {},
      gateway: { logoutAccount: mocks.logoutAccount },
      config: { resolveAccount: mocks.resolveAccount },
    });

    await expect(runChannelLogin({ channel: "whatsapp" }, runtime)).rejects.toThrow(
      'Channel "whatsapp" does not support login. Run `openclaw channels status --channel whatsapp` to inspect supported actions.',
    );
  });

  it("installs a catalog-backed channel plugin on demand for login", async () => {
    const catalogEntry = {
      id: "whatsapp",
      pluginId: "@openclaw/whatsapp",
      meta: {
        id: "whatsapp",
        label: "WhatsApp",
        selectionLabel: "WhatsApp",
        docsPath: "/channels/whatsapp",
        blurb: "wa",
      },
      install: {
        npmSpec: "@openclaw/whatsapp",
      },
    };
    mocks.getLoadedChannelPlugin.mockReturnValueOnce(undefined);
    mocks.listChannelPluginCatalogEntries.mockReturnValueOnce([catalogEntry]);
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel
      .mockReturnValueOnce({
        channels: [],
        channelSetups: [],
      })
      .mockReturnValueOnce({
        channels: [{ plugin }],
        channelSetups: [],
      });

    await runChannelLogin({ channel: "whatsapp" }, runtime);

    expectFields(readFirstCallArg(mocks.ensureChannelSetupPluginInstalled), {
      entry: catalogEntry,
      runtime,
      workspaceDir: "/tmp/workspace",
    });
    expectFields(
      findCallArg(
        mocks.loadChannelSetupPluginRegistrySnapshotForChannel,
        (arg) => arg.pluginId === "whatsapp",
      ),
      {
        channel: "whatsapp",
        pluginId: "whatsapp",
        workspaceDir: "/tmp/workspace",
      },
    );
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      sourceConfig: { channels: { whatsapp: {} } },
      baseHash: "config-1",
    });
    expect(mocks.login).toHaveBeenCalledTimes(1);
  });

  it("strips pending install records before persisting install-on-demand login config", async () => {
    const catalogEntry = {
      id: "whatsapp",
      pluginId: "@openclaw/whatsapp",
      meta: {
        id: "whatsapp",
        label: "WhatsApp",
        selectionLabel: "WhatsApp",
        docsPath: "/channels/whatsapp",
        blurb: "wa",
      },
      install: {
        npmSpec: "@openclaw/whatsapp",
      },
    };
    mocks.getLoadedChannelPlugin.mockReturnValueOnce(undefined);
    mocks.listChannelPluginCatalogEntries.mockReturnValueOnce([catalogEntry]);
    mocks.ensureChannelSetupPluginInstalled.mockResolvedValueOnce({
      cfg: {
        channels: { whatsapp: {} },
        plugins: {
          entries: { whatsapp: { enabled: true } },
          installs: {
            whatsapp: {
              source: "npm",
              spec: "@openclaw/whatsapp",
            },
          },
        },
      },
      installed: true,
      pluginId: "whatsapp",
    });
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel
      .mockReturnValueOnce({
        channels: [],
        channelSetups: [],
      })
      .mockReturnValueOnce({
        channels: [{ plugin }],
        channelSetups: [],
      });

    await runChannelLogin({ channel: "whatsapp" }, runtime);

    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      sourceConfig: {
        channels: { whatsapp: {} },
        plugins: {
          entries: { whatsapp: { enabled: true } },
        },
      },
      baseHash: "config-1",
      writeOptions: { unsetPaths: [["plugins", "installs"]] },
    });
    expectFields(readFirstCallArg(mocks.login), {
      cfg: {
        channels: { whatsapp: {} },
        plugins: {
          entries: { whatsapp: { enabled: true } },
        },
      },
    });
  });

  it("resolves explicit channel login through the catalog when registry normalize misses", async () => {
    mocks.normalizeChannelId.mockReturnValueOnce(undefined).mockReturnValue("whatsapp");
    mocks.getLoadedChannelPlugin.mockReturnValueOnce(undefined);
    mocks.listChannelPluginCatalogEntries.mockReturnValueOnce([
      {
        id: "whatsapp",
        pluginId: "@openclaw/whatsapp",
        meta: {
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp",
          docsPath: "/channels/whatsapp",
          blurb: "wa",
        },
        install: {
          npmSpec: "@openclaw/whatsapp",
        },
      },
    ]);
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel
      .mockReturnValueOnce({
        channels: [],
        channelSetups: [],
      })
      .mockReturnValueOnce({
        channels: [{ plugin }],
        channelSetups: [],
      });

    await runChannelLogin({ channel: "whatsapp" }, runtime);

    const installArg = readFirstCallArg(mocks.ensureChannelSetupPluginInstalled);
    expectFields(installArg, {
      runtime,
      workspaceDir: "/tmp/workspace",
    });
    expectFields(installArg.entry, { id: "whatsapp" });
    expectFields(readFirstCallArg(mocks.login), { channelInput: "whatsapp" });
  });

  it("runs logout through the live gateway with resolved account and explicit account id", async () => {
    await runChannelLogout({ channel: "whatsapp", account: " acct-2 " }, runtime);

    expect(mocks.callGateway).toHaveBeenCalledWith({
      config: { channels: { whatsapp: {} } },
      method: "channels.logout",
      params: {
        channel: "whatsapp",
        accountId: "acct-2",
      },
      mode: "backend",
      clientName: "gateway-client",
      deviceIdentity: null,
    });
    expect(mocks.resolveAccount).not.toHaveBeenCalled();
    expect(mocks.logoutAccount).not.toHaveBeenCalled();
    expect(mocks.setVerbose).not.toHaveBeenCalled();
  });

  it("falls back to local auth cleanup when a local gateway logout is unreachable", async () => {
    mocks.callGateway.mockRejectedValue(new Error("gateway unreachable"));

    await runChannelLogout({ channel: "whatsapp", account: " acct-2 " }, runtime);

    expect(mocks.resolveAccount).toHaveBeenCalledWith({ channels: { whatsapp: {} } }, "acct-2");
    expect(mocks.logoutAccount).toHaveBeenCalledWith({
      cfg: { channels: { whatsapp: {} } },
      accountId: "acct-2",
      account: { id: "resolved-account" },
      runtime,
    });
    expect(readFirstLogMessage(runtime)).toContain(
      "running gateway did not stop it: gateway unreachable",
    );
    expect(mocks.setVerbose).not.toHaveBeenCalled();
  });

  it.each([
    ["gateway", { cleared: true, loggedOut: true }, "Cleared saved auth for whatsapp/acct-2."],
    ["local", { cleared: true, loggedOut: true }, "Cleared saved auth for whatsapp/acct-2."],
    [
      "gateway",
      { cleared: false, loggedOut: true },
      "No saved auth was cleared for whatsapp/acct-2.",
    ],
    [
      "local",
      { cleared: false, loggedOut: true },
      "No saved auth was cleared for whatsapp/acct-2.",
    ],
    [
      "gateway",
      { cleared: true, loggedOut: false },
      "Cleared saved auth for whatsapp/acct-2. Other credentials may still be active.",
    ],
    [
      "local",
      { cleared: false, loggedOut: false },
      "No saved auth was cleared for whatsapp/acct-2. Other credentials may still be active.",
    ],
  ] as const)("reports the completed %s logout result %j", async (route, result, message) => {
    if (route === "local") {
      mocks.callGateway.mockRejectedValue(new Error("gateway unreachable"));
    } else {
      mocks.callGateway.mockResolvedValue(result);
    }
    mocks.logoutAccount.mockResolvedValue(result);

    await runChannelLogout({ channel: "whatsapp", account: "acct-2" }, runtime);

    expect(runtime.log).toHaveBeenLastCalledWith(message);
  });

  it("does not report completion or clear local auth when remote logout fails", async () => {
    mocks.loadConfig.mockReturnValue({ gateway: { mode: "remote" }, channels: { whatsapp: {} } });
    mocks.callGateway.mockRejectedValue(new Error("remote gateway unreachable"));

    await expect(runChannelLogout({ channel: "whatsapp" }, runtime)).rejects.toThrow(
      "remote gateway unreachable",
    );

    expect(mocks.logoutAccount).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("throws when channel does not support logout", async () => {
    mocks.getLoadedChannelPlugin.mockReturnValueOnce({
      auth: { login: mocks.login },
      gateway: {},
      config: { resolveAccount: mocks.resolveAccount },
    });

    await expect(runChannelLogout({ channel: "whatsapp" }, runtime)).rejects.toThrow(
      'Channel "whatsapp" does not support logout. Run `openclaw channels status --channel whatsapp` to inspect supported actions.',
    );
  });

  it.each(
    [
      { account: "", label: "empty" },
      { account: "   ", label: "whitespace" },
    ].flatMap((accountCase) => [
      { ...accountCase, mode: "login" as const },
      { ...accountCase, mode: "logout" as const },
    ]),
  )("rejects a $label --account before $mode resolves the channel", async ({ account, mode }) => {
    // Auto-enable changes make channel resolution persist config, so a late guard is visible.
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: { channels: { whatsapp: {} }, plugins: { allow: ["whatsapp"] } },
      changes: ["whatsapp"],
    });
    const run = mode === "login" ? runChannelLogin : runChannelLogout;
    const action = mode === "login" ? mocks.login : mocks.logoutAccount;

    await expect(run({ channel: "whatsapp", account }, runtime)).rejects.toThrow(
      "--account must not be blank",
    );

    expect(mocks.commitConfigWithPendingPluginInstalls).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.resolveChannelDefaultAccountId).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it.each([
    ["login", runChannelLogin, mocks.login],
    ["logout", runChannelLogout, mocks.logoutAccount],
  ] as const)(
    "still resolves an omitted --account to the plugin default for %s",
    async (_mode, run, action) => {
      mocks.callGateway.mockRejectedValue(new Error("gateway unreachable"));

      await run({ channel: "whatsapp" }, runtime);

      expect(mocks.resolveChannelDefaultAccountId).toHaveBeenCalledTimes(1);
      expectFields(readFirstCallArg(action), { accountId: "default-account" });
    },
  );
});
