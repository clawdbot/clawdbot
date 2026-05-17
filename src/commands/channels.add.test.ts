import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getBundledChannelSetupPlugin } from "../channels/plugins/bundled.js";
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

const channelWizardMocks = vi.hoisted(() => {
  const prompter = {
    intro: vi.fn(async () => undefined),
    outro: vi.fn(async () => undefined),
    confirm: vi.fn(async () => false),
    note: vi.fn(async () => undefined),
    select: vi.fn(),
    text: vi.fn(),
  };
  return {
    prompter,
    setupChannels: vi.fn(async (...args: unknown[]) => args[0] as OpenClawConfig),
  };
});

const bundledMocks = vi.hoisted(() => ({
  getBundledChannelPlugin: vi.fn(() => undefined),
  getBundledChannelSetupPlugin: vi.fn(() => undefined),
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
    getBundledChannelPlugin: bundledMocks.getBundledChannelPlugin,
    getBundledChannelSetupPlugin: bundledMocks.getBundledChannelSetupPlugin,
  };
});

vi.mock("./channel-setup/plugin-install.js", () => pluginInstallMocks);

vi.mock("../cli/plugins-registry-refresh.js", () => registryRefreshMocks);

vi.mock("../cli/plugins-install-record-commit.js", () => pluginInstallRecordCommitMocks);

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: () => channelWizardMocks.prompter,
}));

vi.mock("./onboard-channels.js", async () => {
  const actual =
    await vi.importActual<typeof import("./onboard-channels.js")>("./onboard-channels.js");
  return {
    ...actual,
    setupChannels: (...args: Parameters<typeof actual.setupChannels>) =>
      channelWizardMocks.setupChannels(...args),
  };
});

const runtime = createTestRuntime();

type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};

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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function mockArg(source: MockCallSource, callIndex: number, argIndex: number, label: string) {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call: ${label}`);
  }
  if (argIndex >= call.length) {
    throw new Error(`Expected mock call argument ${argIndex}: ${label}`);
  }
  return call[argIndex];
}

function writtenConfig(index = 0) {
  return requireRecord(
    mockArg(configMocks.writeConfigFile, index, 0, `written config ${index}`),
    `written config ${index}`,
  );
}

function writtenChannel(channel: string, index = 0) {
  return requireRecord(
    requireRecord(writtenConfig(index).channels, `written channels ${index}`)[channel],
    `written channel ${channel}`,
  );
}

function setupOptions() {
  return requireRecord(
    mockArg(channelWizardMocks.setupChannels, 0, 3, "setup options"),
    "setup options",
  );
}

function setupChannelArg(index: number) {
  return mockArg(channelWizardMocks.setupChannels, 0, index, `setup channel arg ${index}`);
}

function applyAccountConfigCall(fn: MockCallSource, index = 0) {
  return requireRecord(
    mockArg(fn, index, 0, `apply account config ${index}`),
    "apply account config",
  );
}

function installCall(index = 0) {
  return requireRecord(
    mockArg(
      ensureChannelSetupPluginInstalled as unknown as MockCallSource,
      index,
      0,
      `install call ${index}`,
    ),
    `install call ${index}`,
  );
}

function snapshotCall(index = 0) {
  return requireRecord(
    mockArg(
      loadChannelSetupPluginRegistrySnapshotForChannel as unknown as MockCallSource,
      index,
      0,
      `snapshot call ${index}`,
    ),
    `snapshot call ${index}`,
  );
}

function refreshCall(index = 0) {
  return requireRecord(
    mockArg(
      registryRefreshMocks.refreshPluginRegistryAfterConfigMutation,
      index,
      0,
      `refresh call ${index}`,
    ),
    `refresh call ${index}`,
  );
}

function commitInstallCall(index = 0) {
  return requireRecord(
    mockArg(
      pluginInstallRecordCommitMocks.commitConfigWithPendingPluginInstalls,
      index,
      0,
      `commit install call ${index}`,
    ),
    `commit install call ${index}`,
  );
}

function expectExternalChatEnabledConfigWrite() {
  expect(writtenChannel("external-chat").enabled).toBe(true);
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
    bundledMocks.getBundledChannelPlugin.mockReset();
    bundledMocks.getBundledChannelPlugin.mockReturnValue(undefined);
    bundledMocks.getBundledChannelSetupPlugin.mockReset();
    bundledMocks.getBundledChannelSetupPlugin.mockReturnValue(undefined);
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
    channelWizardMocks.prompter.intro.mockClear();
    channelWizardMocks.prompter.outro.mockClear();
    channelWizardMocks.prompter.confirm.mockClear();
    channelWizardMocks.prompter.note.mockClear();
    channelWizardMocks.prompter.select.mockClear();
    channelWizardMocks.prompter.text.mockClear();
    channelWizardMocks.setupChannels.mockClear();
    channelWizardMocks.setupChannels.mockImplementation(
      async (...args: unknown[]) => args[0] as OpenClawConfig,
    );
    setMinimalChannelsAddRegistryForTests();
  });

  it("keeps guided channel setup lazy until the user selects a channel", async () => {
    const config: OpenClawConfig = { channels: {} };
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      sourceConfig: config,
      config,
    });

    await channelsAddCommand({}, runtime, { hasFlags: false });

    expect(channelWizardMocks.prompter.intro).toHaveBeenCalledWith("Channel setup");
    expect(setupChannelArg(0)).toBe(config);
    expect(setupChannelArg(1)).toBe(runtime);
    expect(setupChannelArg(2)).toBe(channelWizardMocks.prompter);
    expect(setupOptions().deferStatusUntilSelection).toBe(true);
    expect(setupOptions().skipStatusNote).toBe(true);
    expect(setupOptions().promptAccountIds).toBe(true);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(channelWizardMocks.prompter.outro).toHaveBeenCalledWith("No channel changes made.");
  });

  it("exits quietly when guided channel setup is cancelled", async () => {
    const { WizardCancelledError } = await import("../wizard/prompts.js");
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      sourceConfig: { channels: {} },
      config: { channels: {} },
    });
    channelWizardMocks.setupChannels.mockRejectedValue(new WizardCancelledError());

    await channelsAddCommand({}, runtime, { hasFlags: false });

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
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

    const applyInput = requireRecord(
      applyAccountConfigCall(applyAccountConfig as unknown as MockCallSource).input,
      "apply input",
    );
    expect(applyInput.url).toBe("https://cloud.example.com/");
    expect(applyInput.token).toBe("shared-secret");
    expect(applyInput.baseUrl).toBe("https://cloud.example.com/");
    expect(applyInput.secret).toBe("shared-secret");
    expect(writtenChannel("nextcloud-talk")).toEqual({
      enabled: true,
      baseUrl: "https://cloud.example.com/",
      botSecret: "shared-secret",
      botSecretFile: undefined,
    });

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

    const secondApplyInput = requireRecord(
      applyAccountConfigCall(applyAccountConfig as unknown as MockCallSource).input,
      "second apply input",
    );
    expect(secondApplyInput.baseUrl).toBe("https://cloud.example.com");
    expect(secondApplyInput.secretFile).toBe("/tmp/nextcloud-secret");
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

    expect(writtenChannel("whatsapp")).toEqual({
      enabled: true,
      accounts: {
        work: {
          enabled: true,
          authDir: "/tmp/openclaw-wa-auth",
        },
      },
    });
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

    expect(installCall().entry).toBe(catalogEntry);
    expect(installCall().promptInstall).toBe(false);
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(1);
    expect(snapshotCall().forceSetupOnlyChannelPlugins).toBe(true);
    const refreshedChannels = requireRecord(
      requireRecord(refreshCall().config, "refresh config").channels,
      "refresh channels",
    );
    expect(
      requireRecord(refreshedChannels["external-chat"], "refreshed external chat").enabled,
    ).toBe(true);
    expect(refreshCall().reason).toBe("source-changed");
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
    expect(snapshotCall().forceSetupOnlyChannelPlugins).toBe(true);
    expectExternalChatEnabledConfigWrite();
  });

  it("installs same-id externalized channel plugins before non-interactive add", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    setActivePluginRegistry(createTestRegistry());
    const catalogEntry: ChannelPluginCatalogEntry = {
      id: "whatsapp",
      pluginId: "whatsapp",
      meta: {
        id: "whatsapp",
        label: "WhatsApp",
        selectionLabel: "WhatsApp",
        docsPath: "/channels/whatsapp",
        blurb: "WhatsApp channel",
      },
      install: {
        npmSpec: "@openclaw/whatsapp",
      },
    };
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "whatsapp",
          plugin: {
            ...createChannelTestPluginBase({
              id: "whatsapp",
              label: "WhatsApp",
              docsPath: "/channels/whatsapp",
            }),
            setup: {
              applyAccountConfig: ({ cfg, accountId, input }: ApplyAccountConfigParams) => ({
                ...cfg,
                channels: {
                  ...cfg.channels,
                  whatsapp: {
                    enabled: true,
                    accounts: {
                      [accountId]: {
                        enabled: true,
                        authDir: input.authDir,
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

    await channelsAddCommand(
      {
        channel: "whatsapp",
        account: "work",
        authDir: "/tmp/openclaw-wa-auth",
      },
      runtime,
      { hasFlags: true },
    );

    expect(installCall().entry).toBe(catalogEntry);
    expect(installCall().promptInstall).toBe(false);
    expect(snapshotCall().pluginId).toBe("whatsapp");
    expect(writtenChannel("whatsapp")).toEqual({
      enabled: true,
      accounts: {
        work: {
          enabled: true,
          authDir: "/tmp/openclaw-wa-auth",
        },
      },
    });
    expect(refreshCall().reason).toBe("source-changed");
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("uses setup-entry snapshots when an already loaded channel plugin has no setup adapter", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
          source: "test",
        },
      ]),
    );
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
            setup: {
              applyAccountConfig: ({ cfg, input }: ApplyAccountConfigParams) => ({
                ...cfg,
                channels: {
                  ...cfg.channels,
                  telegram: {
                    enabled: true,
                    botToken: input.token,
                  },
                },
              }),
            },
          },
          source: "test",
        },
      ]),
    );

    await channelsAddCommand(
      {
        channel: "telegram",
        token: "123456:token",
      },
      runtime,
      { hasFlags: true },
    );

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(1);
    expect(writtenChannel("telegram").enabled).toBe(true);
    expect(writtenChannel("telegram").botToken).toBe("123456:token");
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("uses the bundled setup fallback when snapshots only see a runtime plugin", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
          source: "test",
        },
      ]),
    );
    vi.mocked(getBundledChannelSetupPlugin).mockReturnValue({
      ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
      setup: {
        applyAccountConfig: ({ cfg, input }: ApplyAccountConfigParams) => ({
          ...cfg,
          channels: {
            ...cfg.channels,
            telegram: {
              enabled: true,
              botToken: input.token,
            },
          },
        }),
      },
    });

    await channelsAddCommand(
      {
        channel: "telegram",
        token: "123456:token",
      },
      runtime,
      { hasFlags: true },
    );

    expect(getBundledChannelSetupPlugin).toHaveBeenCalledWith("telegram");
    expect(writtenChannel("telegram").enabled).toBe(true);
    expect(writtenChannel("telegram").botToken).toBe("123456:token");
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
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

    expect(installCall().entry).toBe(trustedEntry);
    expect(installCall().promptInstall).toBe(false);
    expect(snapshotCall().pluginId).toBe("@vendor/external-chat-plugin");
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

    expect(installCall().entry).toBe(workspaceEntry);
    expect(installCall().promptInstall).toBe(false);
    expect(snapshotCall().pluginId).toBe("trusted-external-chat-shadow");
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

    const commitCall = commitInstallCall();
    const commitNextConfig = requireRecord(commitCall.nextConfig, "commit next config");
    expect(requireRecord(commitNextConfig.plugins, "commit plugins").installs).toEqual(
      installRecords,
    );
    expect(commitCall.baseHash).toBe("config-1");
    expect(refreshCall().installRecords).toEqual(installRecords);
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
    const hookCall = requireRecord(
      mockArg(afterAccountConfigWritten, 0, 0, "hook call"),
      "hook call",
    );
    expect(hookCall.previousCfg).toBe(baseConfigSnapshot.config);
    expect(requireRecord(hookCall.cfg, "hook config").channels).toEqual({
      signal: {
        enabled: true,
        accounts: {
          ops: {
            account: "+15550001",
          },
        },
      },
    });
    expect(hookCall.accountId).toBe("ops");
    expect(requireRecord(hookCall.input, "hook input").signalNumber).toBe("+15550001");
    expect(hookCall.runtime).toBe(runtime);

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
