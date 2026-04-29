import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
} from "./channel-setup/plugin-install.js";
import { configMocks, lifecycleMocks } from "./channels.mock-harness.js";
import {
  createExternalChatCatalogEntry,
  createExternalChatSetupPlugin,
} from "./channels.plugin-install.test-helpers.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

let channelsAddCommand: typeof import("./channels/add.js").channelsAddCommand;

const catalogMocks = vi.hoisted(() => ({
  getChannelPluginCatalogEntry: vi.fn(),
  listChannelPluginCatalogEntries: vi.fn((): ChannelPluginCatalogEntry[] => []),
}));

const discoveryMocks = vi.hoisted(() => ({
  isCatalogChannelInstalled: vi.fn(() => false),
}));

const pluginInstallMocks = vi.hoisted(() => ({
  ensureChannelSetupPluginInstalled: vi.fn(),
  loadChannelSetupPluginRegistrySnapshotForChannel: vi.fn(),
}));

const registryRefreshMocks = vi.hoisted(() => ({
  refreshPluginRegistryAfterConfigMutation: vi.fn(async () => undefined),
}));

const pluginInstallRecordCommitMocks = vi.hoisted(() => ({
  commitConfigWithPendingPluginInstalls: vi.fn(),
}));

vi.mock("../channels/plugins/catalog.js", () => ({
  getChannelPluginCatalogEntry: catalogMocks.getChannelPluginCatalogEntry,
  listChannelPluginCatalogEntries: catalogMocks.listChannelPluginCatalogEntries,
}));

vi.mock("./channel-setup/discovery.js", () => ({
  isCatalogChannelInstalled: discoveryMocks.isCatalogChannelInstalled,
}));

vi.mock("../channels/plugins/bundled.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/bundled.js")>(
    "../channels/plugins/bundled.js",
  );
  return {
    ...actual,
    getBundledChannelPlugin: vi.fn(() => undefined),
  };
});

vi.mock("./channel-setup/plugin-install.js", () => pluginInstallMocks);

vi.mock("../cli/plugins-registry-refresh.js", () => registryRefreshMocks);

vi.mock("../cli/plugins-install-record-commit.js", () => pluginInstallRecordCommitMocks);

const runtime = createTestRuntime();

function listConfiguredAccountIds(
  channelConfig: { accounts?: Record<string, unknown>; token?: string } | undefined,
): string[] {
  const accountIds = Object.keys(channelConfig?.accounts ?? {});
  if (accountIds.length > 0) {
    return accountIds;
  }
  if (channelConfig?.token) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [];
}

function expectExternalChatEnabledConfigWrite() {
  expect(configMocks.writeConfigFile).toHaveBeenCalledWith(
    expect.objectContaining({
      channels: {
        "external-chat": expect.objectContaining({
          enabled: true,
        }),
      },
    }),
  );
}

function createLifecycleChatAddTestPlugin(): ChannelPlugin {
  const resolveLifecycleChatAccount = (
    cfg: Parameters<NonNullable<ChannelPlugin["config"]["resolveAccount"]>>[0],
    accountId: string,
  ) => {
    const lifecycleChat = cfg.channels?.["lifecycle-chat"] as
      | {
          token?: string;
          enabled?: boolean;
          accounts?: Record<string, { token?: string; enabled?: boolean }>;
        }
      | undefined;
    const resolvedAccountId = accountId || DEFAULT_ACCOUNT_ID;
    const scoped = lifecycleChat?.accounts?.[resolvedAccountId];
    return {
      token: scoped?.token ?? lifecycleChat?.token ?? "",
      enabled:
        typeof scoped?.enabled === "boolean"
          ? scoped.enabled
          : typeof lifecycleChat?.enabled === "boolean"
            ? lifecycleChat.enabled
            : true,
    };
  };

  return {
    ...createChannelTestPluginBase({
      id: "lifecycle-chat",
      label: "Lifecycle Chat",
      docsPath: "/channels/lifecycle-chat",
    }),
    config: {
      listAccountIds: (cfg) =>
        listConfiguredAccountIds(
          cfg.channels?.["lifecycle-chat"] as
            | { accounts?: Record<string, unknown>; token?: string }
            | undefined,
        ),
      resolveAccount: resolveLifecycleChatAccount,
    },
    setup: {
      resolveAccountId: ({ accountId }) => accountId || DEFAULT_ACCOUNT_ID,
      applyAccountConfig: ({ cfg, accountId, input }) => {
        const lifecycleChat = (cfg.channels?.["lifecycle-chat"] as
          | {
              enabled?: boolean;
              token?: string;
              accounts?: Record<string, { token?: string }>;
            }
          | undefined) ?? { enabled: true };
        const resolvedAccountId = accountId || DEFAULT_ACCOUNT_ID;
        if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
          return {
            ...cfg,
            channels: {
              ...cfg.channels,
              "lifecycle-chat": {
                ...lifecycleChat,
                enabled: true,
                ...(input.token ? { token: input.token } : {}),
              },
            },
          };
        }
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            "lifecycle-chat": {
              ...lifecycleChat,
              enabled: true,
              accounts: {
                ...lifecycleChat.accounts,
                [resolvedAccountId]: {
                  ...lifecycleChat.accounts?.[resolvedAccountId],
                  ...(input.token ? { token: input.token } : {}),
                },
              },
            },
          },
        };
      },
    },
    lifecycle: {
      onAccountConfigChanged: async ({ prevCfg, nextCfg, accountId }) => {
        const prev = resolveLifecycleChatAccount(prevCfg, accountId) as { token?: string };
        const next = resolveLifecycleChatAccount(nextCfg, accountId) as { token?: string };
        if ((prev.token ?? "").trim() !== (next.token ?? "").trim()) {
          await lifecycleMocks.onAccountConfigChanged({ accountId });
        }
      },
    },
  } as ChannelPlugin;
}

function setMinimalChannelsAddRegistryForTests(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "lifecycle-chat",
        plugin: createLifecycleChatAddTestPlugin(),
        source: "test",
      },
    ]),
  );
}

function registerExternalChatSetupPlugin(pluginId = "@vendor/external-chat-plugin"): void {
  vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
    createTestRegistry([{ pluginId, plugin: createExternalChatSetupPlugin(), source: "test" }]),
  );
}

type SignalAfterAccountConfigWritten = NonNullable<
  NonNullable<ChannelPlugin["setup"]>["afterAccountConfigWritten"]
>;
type ApplyAccountConfigParams = Parameters<
  NonNullable<NonNullable<ChannelPlugin["setup"]>["applyAccountConfig"]>
>[0];

function createSignalPlugin(
  afterAccountConfigWritten: SignalAfterAccountConfigWritten,
): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: "signal",
      label: "Signal",
    }),
    setup: {
      applyAccountConfig: ({ cfg, accountId, input }) => ({
        ...cfg,
        channels: {
          ...cfg.channels,
          signal: {
            enabled: true,
            accounts: {
              [accountId]: {
                account: input.signalNumber,
              },
            },
          },
        },
      }),
      afterAccountConfigWritten,
    },
  } as ChannelPlugin;
}

async function runSignalAddCommand(afterAccountConfigWritten: SignalAfterAccountConfigWritten) {
  const plugin = createSignalPlugin(afterAccountConfigWritten);
  setActivePluginRegistry(createTestRegistry([{ pluginId: "signal", plugin, source: "test" }]));
  configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
  await channelsAddCommand(
    { channel: "signal", account: "ops", signalNumber: "+15550001" },
    runtime,
    { hasFlags: true },
  );
}

describe("channelsAddCommand", () => {
  beforeAll(async () => {
    ({ channelsAddCommand } = await import("./channels/add.js"));
  });

  beforeEach(async () => {
    resetPluginRuntimeStateForTest();
    configMocks.readConfigFileSnapshot.mockClear();
    configMocks.writeConfigFile.mockClear();
    configMocks.replaceConfigFile
      .mockReset()
      .mockImplementation(async (params: { nextConfig: unknown }) => {
        await configMocks.writeConfigFile(params.nextConfig);
      });
    pluginInstallRecordCommitMocks.commitConfigWithPendingPluginInstalls.mockReset();
    pluginInstallRecordCommitMocks.commitConfigWithPendingPluginInstalls.mockImplementation(
      async (params: { nextConfig: unknown }) => {
        await configMocks.writeConfigFile(params.nextConfig);
        return {
          config: params.nextConfig,
          installRecords: {},
          movedInstallRecords: false,
        };
      },
    );
    lifecycleMocks.onAccountConfigChanged.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    catalogMocks.getChannelPluginCatalogEntry.mockClear();
    catalogMocks.getChannelPluginCatalogEntry.mockReturnValue(undefined);
    catalogMocks.listChannelPluginCatalogEntries.mockClear();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([]);
    discoveryMocks.isCatalogChannelInstalled.mockClear();
    discoveryMocks.isCatalogChannelInstalled.mockReturnValue(false);
    vi.mocked(ensureChannelSetupPluginInstalled).mockReset();
    vi.mocked(ensureChannelSetupPluginInstalled).mockImplementation(async ({ cfg }) => ({
      cfg,
      installed: true,
      status: "installed",
    }));
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReset();
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry(),
    );
    registryRefreshMocks.refreshPluginRegistryAfterConfigMutation.mockClear();
    setMinimalChannelsAddRegistryForTests();
  });

  it("runs channel lifecycle hooks only when account config changes", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          "lifecycle-chat": { token: "old-token", enabled: true },
        },
      },
    });

    await channelsAddCommand(
      { channel: "lifecycle-chat", account: "default", token: "new-token" },
      runtime,
      { hasFlags: true },
    );

    expect(lifecycleMocks.onAccountConfigChanged).toHaveBeenCalledTimes(1);
    expect(lifecycleMocks.onAccountConfigChanged).toHaveBeenCalledWith({ accountId: "default" });

    lifecycleMocks.onAccountConfigChanged.mockClear();
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          "lifecycle-chat": { token: "same-token", enabled: true },
        },
      },
    });

    await channelsAddCommand(
      { channel: "lifecycle-chat", account: "default", token: "same-token" },
      runtime,
      { hasFlags: true },
    );

    expect(lifecycleMocks.onAccountConfigChanged).not.toHaveBeenCalled();
  });

  it("maps legacy Nextcloud Talk add flags to setup input fields", async () => {
    const applyAccountConfig = vi.fn(({ cfg, input }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        "nextcloud-talk": {
          enabled: true,
          baseUrl: input.baseUrl,
          botSecret: input.secret,
          botSecretFile: input.secretFile,
        },
      },
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "nextcloud-talk",
          plugin: {
            ...createChannelTestPluginBase({
              id: "nextcloud-talk",
              label: "Nextcloud Talk",
            }),
            setup: { applyAccountConfig },
          },
          source: "test",
        },
      ]),
    );
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });

    await channelsAddCommand(
      {
        channel: "nextcloud-talk",
        account: "default",
        url: "https://cloud.example.com/",
        token: "shared-secret",
      },
      runtime,
      { hasFlags: true },
    );

    expect(applyAccountConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          url: "https://cloud.example.com/",
          token: "shared-secret",
          baseUrl: "https://cloud.example.com/",
          secret: "shared-secret",
        }),
      }),
    );
    expect(configMocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: {
          "nextcloud-talk": {
            enabled: true,
            baseUrl: "https://cloud.example.com/",
            botSecret: "shared-secret",
            botSecretFile: undefined,
          },
        },
      }),
    );

    configMocks.writeConfigFile.mockClear();
    applyAccountConfig.mockClear();
    await channelsAddCommand(
      {
        channel: "nextcloud-talk",
        account: "default",
        url: "https://cloud.example.com",
        tokenFile: "/tmp/nextcloud-secret",
      },
      runtime,
      { hasFlags: true },
    );

    expect(applyAccountConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          baseUrl: "https://cloud.example.com",
          secretFile: "/tmp/nextcloud-secret",
        }),
      }),
    );
  });

  it("passes channel auth directory overrides through add setup input", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "whatsapp",
          plugin: {
            ...createChannelTestPluginBase({
              id: "whatsapp",
              label: "WhatsApp",
            }),
            setup: {
              applyAccountConfig: (params: ApplyAccountConfigParams) => ({
                ...params.cfg,
                channels: {
                  ...params.cfg.channels,
                  whatsapp: {
                    enabled: true,
                    accounts: {
                      [params.accountId]: {
                        enabled: true,
                        authDir: params.input.authDir,
                      },
                    },
                  },
                },
              }),
            },
          },
          source: "test",
        },
      ]),
    );
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });

    await channelsAddCommand(
      {
        channel: "whatsapp",
        account: "work",
        authDir: "/tmp/openclaw-wa-auth",
      },
      runtime,
      { hasFlags: true },
    );

    expect(configMocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: {
          whatsapp: {
            enabled: true,
            accounts: {
              work: {
                enabled: true,
                authDir: "/tmp/openclaw-wa-auth",
              },
            },
          },
        },
      }),
    );
  });

  it("loads external channel setup snapshots for newly installed and existing plugins", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    setActivePluginRegistry(createTestRegistry());
    const catalogEntry = createExternalChatCatalogEntry();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    registerExternalChatSetupPlugin("external-chat");

    await channelsAddCommand(
      {
        channel: "external-chat",
        account: "default",
        token: "tenant-scoped",
      },
      runtime,
      { hasFlags: true },
    );

    expect(ensureChannelSetupPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({ entry: catalogEntry, promptInstall: false }),
    );
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(1);
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({ installRuntimeDeps: false }),
    );
    expect(registryRefreshMocks.refreshPluginRegistryAfterConfigMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          channels: expect.objectContaining({
            "external-chat": expect.objectContaining({ enabled: true }),
          }),
        }),
        reason: "source-changed",
      }),
    );
    expectExternalChatEnabledConfigWrite();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();

    vi.mocked(ensureChannelSetupPluginInstalled).mockClear();
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockClear();
    configMocks.writeConfigFile.mockClear();
    discoveryMocks.isCatalogChannelInstalled.mockReturnValue(true);

    await channelsAddCommand(
      {
        channel: "external-chat",
        account: "default",
        token: "tenant-installed",
      },
      runtime,
      { hasFlags: true },
    );

    expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(1);
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({ installRuntimeDeps: false }),
    );
    expectExternalChatEnabledConfigWrite();
  });

  it("falls back from untrusted workspace catalog shadows when adding by alias", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    setActivePluginRegistry(createTestRegistry());
    const workspaceEntry: ChannelPluginCatalogEntry = {
      ...createExternalChatCatalogEntry(),
      pluginId: "evil-external-chat-shadow",
      origin: "workspace",
      meta: {
        ...createExternalChatCatalogEntry().meta,
        aliases: ["ext"],
      },
      install: {
        npmSpec: "evil-external-chat-shadow",
      },
    };
    const trustedEntry: ChannelPluginCatalogEntry = {
      ...createExternalChatCatalogEntry(),
      origin: "bundled",
      meta: {
        ...createExternalChatCatalogEntry().meta,
        aliases: ["ext"],
      },
    };
    catalogMocks.listChannelPluginCatalogEntries.mockImplementation(
      ({ excludeWorkspace }: { excludeWorkspace?: boolean } = {}) =>
        excludeWorkspace ? [trustedEntry] : [workspaceEntry],
    );
    registerExternalChatSetupPlugin("@vendor/external-chat-plugin");

    await channelsAddCommand(
      {
        channel: "ext",
        account: "default",
        token: "tenant-scoped",
      },
      runtime,
      { hasFlags: true },
    );

    expect(ensureChannelSetupPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({ entry: trustedEntry, promptInstall: false }),
    );
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "@vendor/external-chat-plugin" }),
    );
    expectExternalChatEnabledConfigWrite();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("keeps explicitly trusted workspace catalog ownership when adding by alias", async () => {
    const workspaceEntry: ChannelPluginCatalogEntry = {
      ...createExternalChatCatalogEntry(),
      pluginId: "trusted-external-chat-shadow",
      origin: "workspace",
      meta: {
        ...createExternalChatCatalogEntry().meta,
        aliases: ["ext"],
      },
      install: {
        npmSpec: "trusted-external-chat-shadow",
      },
    };
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        plugins: {
          enabled: true,
          allow: ["trusted-external-chat-shadow"],
        },
      },
    });
    setActivePluginRegistry(createTestRegistry());
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([workspaceEntry]);
    registerExternalChatSetupPlugin("trusted-external-chat-shadow");

    await channelsAddCommand(
      {
        channel: "ext",
        account: "default",
        token: "tenant-scoped",
      },
      runtime,
      { hasFlags: true },
    );

    expect(ensureChannelSetupPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({ entry: workspaceEntry, promptInstall: false }),
    );
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "trusted-external-chat-shadow" }),
    );
    expectExternalChatEnabledConfigWrite();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("commits channel setup plugin install records with the guarded config write", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      hash: "config-1",
    });
    setActivePluginRegistry(createTestRegistry());
    const catalogEntry = createExternalChatCatalogEntry();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    registerExternalChatSetupPlugin("external-chat");
    const installRecords: Record<string, PluginInstallRecord> = {
      "@vendor/external-chat-plugin": {
        source: "npm",
        spec: "@vendor/external-chat@1.2.3",
      },
    };
    pluginInstallRecordCommitMocks.commitConfigWithPendingPluginInstalls.mockImplementationOnce(
      async (params: { nextConfig: OpenClawConfig }) => {
        const { installs: _installs, ...plugins } = params.nextConfig.plugins ?? {};
        const writtenConfig = { ...params.nextConfig, plugins };
        await configMocks.writeConfigFile(writtenConfig);
        return {
          config: writtenConfig,
          installRecords,
          movedInstallRecords: true,
        };
      },
    );
    vi.mocked(ensureChannelSetupPluginInstalled).mockImplementation(async ({ cfg }) => ({
      cfg: {
        ...cfg,
        plugins: {
          ...cfg.plugins,
          installs: installRecords,
        },
      },
      installed: true,
      pluginId: "@vendor/external-chat-plugin",
      status: "installed",
    }));

    await channelsAddCommand(
      {
        channel: "external-chat",
        account: "default",
        token: "tenant-scoped",
      },
      runtime,
      { hasFlags: true },
    );

    expect(
      pluginInstallRecordCommitMocks.commitConfigWithPendingPluginInstalls,
    ).toHaveBeenCalledWith({
      nextConfig: expect.objectContaining({
        plugins: expect.objectContaining({ installs: installRecords }),
      }),
      baseHash: "config-1",
    });
    expect(registryRefreshMocks.refreshPluginRegistryAfterConfigMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        installRecords,
      }),
    );
  });

  it("uses the installed plugin id when channel and plugin ids differ", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    setActivePluginRegistry(createTestRegistry());
    const catalogEntry: ChannelPluginCatalogEntry = {
      id: "external-chat",
      pluginId: "@vendor/external-chat-plugin",
      meta: {
        id: "external-chat",
        label: "External Chat",
        selectionLabel: "External Chat",
        docsPath: "/channels/external-chat",
        blurb: "external chat channel",
      },
      install: {
        npmSpec: "@vendor/external-chat",
      },
    };
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    vi.mocked(ensureChannelSetupPluginInstalled).mockImplementation(async ({ cfg }) => ({
      cfg,
      installed: true,
      pluginId: "@vendor/external-chat-runtime",
      status: "installed",
    }));
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-runtime",
          plugin: {
            ...createChannelTestPluginBase({
              id: "external-chat",
              label: "External Chat",
              docsPath: "/channels/external-chat",
            }),
            setup: {
              applyAccountConfig: vi.fn(({ cfg, input }) => ({
                ...cfg,
                channels: {
                  ...cfg.channels,
                  "external-chat": {
                    enabled: true,
                    token: input.token,
                  },
                },
              })),
            },
          },
          source: "test",
        },
      ]),
    );

    await channelsAddCommand(
      {
        channel: "external-chat",
        account: "default",
        token: "tenant-scoped",
      },
      runtime,
      { hasFlags: true },
    );

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(1);
    expectExternalChatEnabledConfigWrite();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("runs post-setup hooks after writing config and keeps saved config on hook failure", async () => {
    const afterAccountConfigWritten = vi.fn().mockResolvedValue(undefined);
    await runSignalAddCommand(afterAccountConfigWritten);

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(afterAccountConfigWritten).toHaveBeenCalledTimes(1);
    expect(configMocks.writeConfigFile.mock.invocationCallOrder[0]).toBeLessThan(
      afterAccountConfigWritten.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(afterAccountConfigWritten).toHaveBeenCalledWith({
      previousCfg: baseConfigSnapshot.config,
      cfg: expect.objectContaining({
        channels: {
          signal: {
            enabled: true,
            accounts: {
              ops: {
                account: "+15550001",
              },
            },
          },
        },
      }),
      accountId: "ops",
      input: expect.objectContaining({
        signalNumber: "+15550001",
      }),
      runtime,
    });

    configMocks.writeConfigFile.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    const failingHook = vi.fn().mockRejectedValue(new Error("hook failed"));
    await runSignalAddCommand(failingHook);

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      'Channel signal post-setup warning for "ops": hook failed',
    );
  });
});
