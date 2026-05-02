import { beforeEach, describe, expect, it, vi } from "vitest";
import { runChannelLogin, runChannelLogout } from "./channel-auth.js";

const mocks = vi.hoisted(() => ({
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  getChannelPluginCatalogEntry: vi.fn(),
  listChannelPluginCatalogEntries: vi.fn(),
  resolveChannelDefaultAccountId: vi.fn(),
  getChannelPlugin: vi.fn(),
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
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));

vi.mock("../channels/plugins/catalog.js", () => ({
  getChannelPluginCatalogEntry: mocks.getChannelPluginCatalogEntry,
  listChannelPluginCatalogEntries: mocks.listChannelPluginCatalogEntries,
}));

vi.mock("../channels/plugins/helpers.js", () => ({
  resolveChannelDefaultAccountId: mocks.resolveChannelDefaultAccountId,
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  listChannelPlugins: mocks.listChannelPlugins,
  normalizeChannelId: mocks.normalizeChannelId,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.loadConfig,
  loadConfig: mocks.loadConfig,
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
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

vi.mock("./plugins-install-record-commit.js", () => ({
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
    mocks.getChannelPlugin.mockReturnValue(plugin);
    mocks.getChannelPluginCatalogEntry.mockReturnValue(undefined);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([]);
    mocks.loadConfig.mockReturnValue({ channels: { whatsapp: {} } });
    mocks.readConfigFileSnapshot.mockResolvedValue({ hash: "config-1" });
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.replaceConfigFile.mockResolvedValue(undefined);
    mocks.commitConfigWithPendingPluginInstalls.mockImplementation(
      async ({
        nextConfig,
        baseHash,
      }: {
        nextConfig: { plugins?: { installs?: Record<string, unknown> } };
        baseHash?: string;
      }) => {
        if (
          !nextConfig.plugins?.installs ||
          Object.keys(nextConfig.plugins.installs).length === 0
        ) {
          await mocks.replaceConfigFile({
            nextConfig,
            ...(baseHash !== undefined ? { baseHash } : {}),
          });
          return {
            config: nextConfig,
            installRecords: {},
            movedInstallRecords: false,
          };
        }
        const { installs: _installs, ...plugins } = nextConfig.plugins;
        const strippedConfig =
          Object.keys(plugins).length > 0
            ? { ...nextConfig, plugins }
            : Object.fromEntries(Object.entries(nextConfig).filter(([key]) => key !== "plugins"));
        await mocks.replaceConfigFile({
          nextConfig: strippedConfig,
          ...(baseHash !== undefined ? { baseHash } : {}),
          writeOptions: { unsetPaths: [["plugins", "installs"]] },
        });
        return {
          config: strippedConfig,
          installRecords: nextConfig.plugins.installs,
          movedInstallRecords: true,
        };
      },
    );
    mocks.callGateway.mockResolvedValue({ ok: true });
    mocks.listChannelPlugins.mockReturnValue([plugin]);
    mocks.resolveDefaultAgentId.mockReturnValue("main");
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
    mocks.logoutAccount.mockResolvedValue(undefined);
  });

  it("runs login with explicit trimmed account and verbose flag", async () => {
    await runChannelLogin({ channel: "wa", account: "  acct-1  ", verbose: true }, runtime);

    expect(mocks.setVerbose).toHaveBeenCalledWith(true);
    expect(mocks.resolveChannelDefaultAccountId).not.toHaveBeenCalled();
    expect(mocks.login).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: { channels: { whatsapp: {} } },
        accountId: "acct-1",
        runtime,
        verbose: true,
        channelInput: "wa",
      }),
    );
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
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Gateway is in remote mode"));
  });

  it("keeps login successful when local gateway runtime reconcile fails", async () => {
    mocks.callGateway.mockRejectedValue(new Error("gateway unreachable"));

    await expect(
      runChannelLogin({ channel: "whatsapp", account: "acct-1" }, runtime),
    ).resolves.toBeUndefined();

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("running gateway did not restart it: gateway unreachable"),
    );
  });

  it("auto-picks the single configured channel that supports login when opts are empty", async () => {
    await runChannelLogin({}, runtime);

    expect(mocks.normalizeChannelId).toHaveBeenCalledWith("whatsapp");
    expect(mocks.login).toHaveBeenCalledWith(
      expect.objectContaining({
        channelInput: "whatsapp",
      }),
    );
  });

  it("does not auto-pick enabled-only channel stubs when channel is omitted", async () => {
    mocks.loadConfig.mockReturnValue({ channels: { whatsapp: { enabled: false } } });

    await expect(runChannelLogin({}, runtime)).rejects.toThrow(
      "Channel is required (no configured channels support login).",
    );
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it("auto-picks the single auth-capable channel from the auto-enabled config snapshot", async () => {
    const autoEnabledCfg = { channels: { whatsapp: {} }, plugins: { allow: ["whatsapp"] } };
    mocks.loadConfig.mockReturnValue({});
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledCfg, changes: ["whatsapp"] });

    await runChannelLogin({}, runtime);

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
    expect(mocks.login).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: autoEnabledCfg,
        channelInput: "whatsapp",
      }),
    );
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: autoEnabledCfg,
      baseHash: "config-1",
    });
  });

  it("persists auto-enabled config during logout auto-pick too", async () => {
    const autoEnabledCfg = { channels: { whatsapp: {} }, plugins: { allow: ["whatsapp"] } };
    mocks.loadConfig.mockReturnValue({});
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledCfg, changes: ["whatsapp"] });

    await runChannelLogout({}, runtime);

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledCfg,
        method: "channels.logout",
      }),
    );
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: autoEnabledCfg,
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
    expect(mocks.login).toHaveBeenCalled();
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
    mocks.listChannelPlugins.mockReturnValue([plugin, zaloPlugin]);
    mocks.normalizeChannelId.mockImplementation((value) => value);
    mocks.getChannelPlugin.mockImplementation((value) =>
      value === "whatsapp"
        ? plugin
        : value === "zalouser"
          ? (zaloPlugin as typeof plugin)
          : undefined,
    );

    await expect(runChannelLogin({}, runtime)).rejects.toThrow(
      "multiple configured channels support login: whatsapp, zalouser",
    );
    expect(mocks.login).not.toHaveBeenCalled();
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
    expect(mocks.login).toHaveBeenCalled();
  });

  it("throws for unsupported channel aliases", async () => {
    mocks.normalizeChannelId.mockImplementation(() => undefined);

    await expect(runChannelLogin({ channel: "bad-channel" }, runtime)).rejects.toThrow(
      "Unsupported channel: bad-channel",
    );
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it("throws when channel does not support login", async () => {
    mocks.getChannelPlugin.mockReturnValueOnce({
      auth: {},
      gateway: { logoutAccount: mocks.logoutAccount },
      config: { resolveAccount: mocks.resolveAccount },
    });

    await expect(runChannelLogin({ channel: "whatsapp" }, runtime)).rejects.toThrow(
      "Channel whatsapp does not support login",
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
    mocks.getChannelPlugin.mockReturnValueOnce(undefined);
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

    expect(mocks.ensureChannelSetupPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: catalogEntry,
        runtime,
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(mocks.loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        pluginId: "whatsapp",
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: { channels: { whatsapp: {} } },
      baseHash: "config-1",
    });
    expect(mocks.login).toHaveBeenCalled();
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
    mocks.getChannelPlugin.mockReturnValueOnce(undefined);
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
      nextConfig: {
        channels: { whatsapp: {} },
        plugins: {
          entries: { whatsapp: { enabled: true } },
        },
      },
      baseHash: "config-1",
      writeOptions: { unsetPaths: [["plugins", "installs"]] },
    });
    expect(mocks.login).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {
          channels: { whatsapp: {} },
          plugins: {
            entries: { whatsapp: { enabled: true } },
          },
        },
      }),
    );
  });

  it("resolves explicit channel login through the catalog when registry normalize misses", async () => {
    mocks.normalizeChannelId.mockReturnValueOnce(undefined).mockReturnValue("whatsapp");
    mocks.getChannelPlugin.mockReturnValueOnce(undefined);
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

    expect(mocks.ensureChannelSetupPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ id: "whatsapp" }),
        runtime,
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(mocks.login).toHaveBeenCalledWith(
      expect.objectContaining({
        channelInput: "whatsapp",
      }),
    );
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
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("running gateway did not stop it: gateway unreachable"),
    );
    expect(mocks.setVerbose).not.toHaveBeenCalled();
  });

  it("throws when channel does not support logout", async () => {
    mocks.getChannelPlugin.mockReturnValueOnce({
      auth: { login: mocks.login },
      gateway: {},
      config: { resolveAccount: mocks.resolveAccount },
    });

    await expect(runChannelLogout({ channel: "whatsapp" }, runtime)).rejects.toThrow(
      "Channel whatsapp does not support logout",
    );
  });
});
