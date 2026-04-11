import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
} from "./channel-setup/plugin-install.js";
import { configMocks, offsetMocks } from "./channels.mock-harness.js";
import {
  createMSTeamsCatalogEntry,
  createMSTeamsSetupPlugin,
} from "./channels.plugin-install.test-helpers.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

let channelsAddCommand: typeof import("./channels.js").channelsAddCommand;

const catalogMocks = vi.hoisted(() => ({
  listChannelPluginCatalogEntries: vi.fn((): ChannelPluginCatalogEntry[] => []),
}));

const manifestRegistryMocks = vi.hoisted(() => ({
  loadPluginManifestRegistry: vi.fn(() => ({ plugins: [], diagnostics: [] })),
}));

vi.mock("../channels/plugins/catalog.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/catalog.js")>(
    "../channels/plugins/catalog.js",
  );
  return {
    ...actual,
    listChannelPluginCatalogEntries: catalogMocks.listChannelPluginCatalogEntries,
  };
});

vi.mock("../plugins/manifest-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/manifest-registry.js")>(
    "../plugins/manifest-registry.js",
  );
  return {
    ...actual,
    loadPluginManifestRegistry: manifestRegistryMocks.loadPluginManifestRegistry,
  };
});

vi.mock("./channel-setup/plugin-install.js", async () => {
  const actual = await vi.importActual<typeof import("./channel-setup/plugin-install.js")>(
    "./channel-setup/plugin-install.js",
  );
  const { createMockChannelSetupPluginInstallModule } =
    await import("./channels.plugin-install.test-helpers.js");
  return createMockChannelSetupPluginInstallModule(actual);
});

const runtime = createTestRuntime();

function listConfiguredAccountIds(
  channelConfig: { accounts?: Record<string, unknown>; botToken?: string } | undefined,
): string[] {
  const accountIds = Object.keys(channelConfig?.accounts ?? {});
  if (accountIds.length > 0) {
    return accountIds;
  }
  if (channelConfig?.botToken) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [];
}

function createTelegramAddTestPlugin(): ChannelPlugin {
  const resolveTelegramAccount = (
    cfg: Parameters<NonNullable<ChannelPlugin["config"]["resolveAccount"]>>[0],
    accountId: string,
  ) => {
    const telegram = cfg.channels?.telegram as
      | {
          botToken?: string;
          enabled?: boolean;
          accounts?: Record<string, { botToken?: string; enabled?: boolean }>;
        }
      | undefined;
    const resolvedAccountId = accountId || DEFAULT_ACCOUNT_ID;
    const scoped = telegram?.accounts?.[resolvedAccountId];
    return {
      token: scoped?.botToken ?? telegram?.botToken ?? "",
      enabled:
        typeof scoped?.enabled === "boolean"
          ? scoped.enabled
          : typeof telegram?.enabled === "boolean"
            ? telegram.enabled
            : true,
    };
  };

  return {
    ...createChannelTestPluginBase({
      id: "telegram",
      label: "Telegram",
      docsPath: "/channels/telegram",
    }),
    config: {
      listAccountIds: (cfg) =>
        listConfiguredAccountIds(
          cfg.channels?.telegram as
            | { accounts?: Record<string, unknown>; botToken?: string }
            | undefined,
        ),
      resolveAccount: resolveTelegramAccount,
    },
    setup: {
      resolveAccountId: ({ accountId }) => accountId || DEFAULT_ACCOUNT_ID,
      applyAccountConfig: ({ cfg, accountId, input }) => {
        const telegram = (cfg.channels?.telegram as
          | {
              enabled?: boolean;
              botToken?: string;
              accounts?: Record<string, { botToken?: string }>;
            }
          | undefined) ?? { enabled: true };
        const resolvedAccountId = accountId || DEFAULT_ACCOUNT_ID;
        if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
          return {
            ...cfg,
            channels: {
              ...cfg.channels,
              telegram: {
                ...telegram,
                enabled: true,
                ...(input.token ? { botToken: input.token } : {}),
              },
            },
          };
        }
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            telegram: {
              ...telegram,
              enabled: true,
              accounts: {
                ...telegram.accounts,
                [resolvedAccountId]: {
                  ...telegram.accounts?.[resolvedAccountId],
                  ...(input.token ? { botToken: input.token } : {}),
                },
              },
            },
          },
        };
      },
    },
    lifecycle: {
      onAccountConfigChanged: async ({ prevCfg, nextCfg, accountId }) => {
        const prevTelegram = resolveTelegramAccount(prevCfg, accountId) as { token?: string };
        const nextTelegram = resolveTelegramAccount(nextCfg, accountId) as { token?: string };
        if ((prevTelegram.token ?? "").trim() !== (nextTelegram.token ?? "").trim()) {
          await offsetMocks.deleteTelegramUpdateOffset({ accountId });
        }
      },
    },
  } as ChannelPlugin;
}

function setMinimalChannelsAddRegistryForTests(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        plugin: createTelegramAddTestPlugin(),
        source: "test",
      },
    ]),
  );
}

function registerMSTeamsSetupPlugin(pluginId = "@openclaw/msteams-plugin"): void {
  vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
    createTestRegistry([{ pluginId, plugin: createMSTeamsSetupPlugin(), source: "test" }]),
  );
}

type SignalAfterAccountConfigWritten = NonNullable<
  NonNullable<ChannelPlugin["setup"]>["afterAccountConfigWritten"]
>;

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
    ({ channelsAddCommand } = await import("./channels.js"));
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
    offsetMocks.deleteTelegramUpdateOffset.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    catalogMocks.listChannelPluginCatalogEntries.mockClear();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([]);
    manifestRegistryMocks.loadPluginManifestRegistry.mockClear();
    manifestRegistryMocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    vi.mocked(ensureChannelSetupPluginInstalled).mockClear();
    vi.mocked(ensureChannelSetupPluginInstalled).mockImplementation(async ({ cfg }) => ({
      cfg,
      installed: true,
    }));
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockClear();
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry(),
    );
    setMinimalChannelsAddRegistryForTests();
  });

  it("clears telegram update offsets when the token changes", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: { botToken: "old-token", enabled: true },
        },
      },
    });

    await channelsAddCommand(
      { channel: "telegram", account: "default", token: "new-token" },
      runtime,
      { hasFlags: true },
    );

    expect(offsetMocks.deleteTelegramUpdateOffset).toHaveBeenCalledTimes(1);
    expect(offsetMocks.deleteTelegramUpdateOffset).toHaveBeenCalledWith({ accountId: "default" });
  });

  it("does not clear telegram update offsets when the token is unchanged", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: { botToken: "same-token", enabled: true },
        },
      },
    });

    await channelsAddCommand(
      { channel: "telegram", account: "default", token: "same-token" },
      runtime,
      { hasFlags: true },
    );

    expect(offsetMocks.deleteTelegramUpdateOffset).not.toHaveBeenCalled();
  });

  it("falls back to a scoped snapshot after installing an external channel plugin", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    setActivePluginRegistry(createTestRegistry());
    const catalogEntry = createMSTeamsCatalogEntry();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    registerMSTeamsSetupPlugin("msteams");

    await channelsAddCommand(
      {
        channel: "msteams",
        account: "default",
        token: "tenant-scoped",
      },
      runtime,
      { hasFlags: true },
    );

    expect(ensureChannelSetupPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({ entry: catalogEntry }),
    );
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: {
          msteams: {
            enabled: true,
          },
        },
      }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("uses the installed external channel snapshot without reinstalling", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    setActivePluginRegistry(createTestRegistry());
    const catalogEntry = createMSTeamsCatalogEntry();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    manifestRegistryMocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "@openclaw/msteams-plugin",
          channels: ["msteams"],
        } as never,
      ],
      diagnostics: [],
    });
    registerMSTeamsSetupPlugin("msteams");

    await channelsAddCommand(
      {
        channel: "msteams",
        account: "default",
        token: "tenant-installed",
      },
      runtime,
      { hasFlags: true },
    );

    expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: {
          msteams: {
            enabled: true,
          },
        },
      }),
    );
  });

  it("uses the installed plugin id when channel and plugin ids differ", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    setActivePluginRegistry(createTestRegistry());
    const catalogEntry: ChannelPluginCatalogEntry = {
      id: "msteams",
      pluginId: "@openclaw/msteams-plugin",
      meta: {
        id: "msteams",
        label: "Microsoft Teams",
        selectionLabel: "Microsoft Teams",
        docsPath: "/channels/msteams",
        blurb: "teams channel",
      },
      install: {
        npmSpec: "@openclaw/msteams",
      },
    };
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    vi.mocked(ensureChannelSetupPluginInstalled).mockImplementation(async ({ cfg }) => ({
      cfg,
      installed: true,
      pluginId: "@vendor/teams-runtime",
    }));
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/teams-runtime",
          plugin: {
            ...createChannelTestPluginBase({
              id: "msteams",
              label: "Microsoft Teams",
              docsPath: "/channels/msteams",
            }),
            setup: {
              applyAccountConfig: vi.fn(({ cfg, input }) => ({
                ...cfg,
                channels: {
                  ...cfg.channels,
                  msteams: {
                    enabled: true,
                    tenantId: input.token,
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
        channel: "msteams",
        account: "default",
        token: "tenant-scoped",
      },
      runtime,
      { hasFlags: true },
    );

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: {
          msteams: {
            enabled: true,
          },
        },
      }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("runs post-setup hooks after writing config", async () => {
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
  });

  it("keeps the saved config when a post-setup hook fails", async () => {
    const afterAccountConfigWritten = vi.fn().mockRejectedValue(new Error("hook failed"));
    await runSignalAddCommand(afterAccountConfigWritten);

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      'Channel signal post-setup warning for "ops": hook failed',
    );
  });
});
