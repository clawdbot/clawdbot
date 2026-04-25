import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeCatalogEntry,
  makeChannelSetupEntries,
  makeMeta,
} from "./channel-setup.test-helpers.js";

type ChannelSetupPlugin = import("../channels/plugins/setup-wizard-types.js").ChannelSetupPlugin;
type ResolveChannelSetupEntries =
  typeof import("../commands/channel-setup/discovery.js").resolveChannelSetupEntries;
type CollectChannelStatus = typeof import("./channel-setup.status.js").collectChannelStatus;
type EnsureChannelSetupPluginInstalled =
  typeof import("../commands/channel-setup/plugin-install.js").ensureChannelSetupPluginInstalled;
type LoadChannelSetupPluginRegistrySnapshotForChannel =
  typeof import("../commands/channel-setup/plugin-install.js").loadChannelSetupPluginRegistrySnapshotForChannel;
type PluginRegistry = ReturnType<LoadChannelSetupPluginRegistrySnapshotForChannel>;

function makeSetupPlugin(params: {
  id: string;
  label: string;
  setupWizard?: ChannelSetupPlugin["setupWizard"];
}): ChannelSetupPlugin {
  return {
    id: params.id as ChannelSetupPlugin["id"],
    meta: makeMeta(params.id, params.label),
    capabilities: { chatTypes: [] },
    config: {
      resolveAccount: vi.fn(() => ({})),
    } as unknown as ChannelSetupPlugin["config"],
    ...(params.setupWizard ? { setupWizard: params.setupWizard } : {}),
  };
}

function externalChatSetupEntries(overrides: Partial<ReturnType<ResolveChannelSetupEntries>> = {}) {
  return makeChannelSetupEntries({
    entries: [
      {
        id: "external-chat",
        meta: makeMeta("external-chat", "External Chat"),
      },
    ],
    ...overrides,
  });
}

function makePluginRegistry(overrides: Partial<PluginRegistry> = {}): PluginRegistry {
  return {
    plugins: [],
    channels: [],
    channelSetups: [],
    providers: [],
    authProviders: [],
    authRequirements: [],
    webSearchProviders: [],
    webFetchProviders: [],
    mediaUnderstandingProviders: [],
    imageGenerationProviders: [],
    videoGenerationProviders: [],
    musicGenerationProviders: [],
    speechProviders: [],
    realtimeTranscriptionProviders: [],
    realtimeVoiceProviders: [],
    cliBackends: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    bundledExtensionDescriptors: [],
    doctorChecks: [],
    flowContributions: [],
    flowContributionResolvers: [],
    providerExtensions: [],
    toolsets: [],
    toolDisplayEntries: [],
    textTransforms: [],
    diagnostics: [],
    ...overrides,
  } as unknown as PluginRegistry;
}

const resolveAgentWorkspaceDir = vi.hoisted(() =>
  vi.fn((_cfg?: unknown, _agentId?: unknown) => "/tmp/openclaw-workspace"),
);
const resolveDefaultAgentId = vi.hoisted(() => vi.fn((_cfg?: unknown) => "default"));
const listTrustedChannelPluginCatalogEntries = vi.hoisted(() =>
  vi.fn((_params?: unknown): unknown[] => []),
);
const getChannelSetupPlugin = vi.hoisted(() => vi.fn((_channel?: unknown) => undefined));
const listChannelSetupPlugins = vi.hoisted(() => vi.fn((): unknown[] => []));
const listActiveChannelSetupPlugins = vi.hoisted(() => vi.fn((): unknown[] => []));
const loadChannelSetupPluginRegistrySnapshotForChannel = vi.hoisted(() =>
  vi.fn<LoadChannelSetupPluginRegistrySnapshotForChannel>((_params) => makePluginRegistry()),
);
const ensureChannelSetupPluginInstalled = vi.hoisted(() =>
  vi.fn<EnsureChannelSetupPluginInstalled>(async ({ cfg, entry }) => ({
    cfg,
    installed: true,
    pluginId: entry?.pluginId,
    status: "installed",
  })),
);
const resolveChannelSetupEntries = vi.hoisted(() =>
  vi.fn<ResolveChannelSetupEntries>((_params) => ({
    entries: [],
    installedCatalogEntries: [],
    installableCatalogEntries: [],
    installedCatalogById: new Map(),
    installableCatalogById: new Map(),
  })),
);
const collectChannelStatus = vi.hoisted(() =>
  vi.fn<CollectChannelStatus>(async (_params) => ({
    installedPlugins: [],
    catalogEntries: [],
    installedCatalogEntries: [],
    statusByChannel: new Map(),
    statusLines: [],
  })),
);
const isChannelConfigured = vi.hoisted(() => vi.fn((_cfg?: unknown, _channel?: unknown) => true));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: (cfg?: unknown, agentId?: unknown) =>
    resolveAgentWorkspaceDir(cfg, agentId),
  resolveDefaultAgentId: (cfg?: unknown) => resolveDefaultAgentId(cfg),
}));

vi.mock("../channels/plugins/setup-registry.js", () => ({
  getChannelSetupPlugin: (channel?: unknown) => getChannelSetupPlugin(channel),
  listActiveChannelSetupPlugins: () => listActiveChannelSetupPlugins(),
  listChannelSetupPlugins: () => listChannelSetupPlugins(),
}));

vi.mock("../channels/registry.js", () => ({
  getChatChannelMeta: (channelId: string) => ({ id: channelId, label: channelId }),
  listChatChannels: () => [],
  normalizeChatChannelId: (channelId?: unknown) =>
    typeof channelId === "string" ? channelId.trim().toLowerCase() || null : null,
}));

vi.mock("../commands/channel-setup/discovery.js", () => ({
  resolveChannelSetupEntries: (params: Parameters<ResolveChannelSetupEntries>[0]) =>
    resolveChannelSetupEntries(params),
  shouldShowChannelInSetup: () => true,
}));

vi.mock("../commands/channel-setup/plugin-install.js", () => ({
  ensureChannelSetupPluginInstalled: (params: Parameters<EnsureChannelSetupPluginInstalled>[0]) =>
    ensureChannelSetupPluginInstalled(params),
  loadChannelSetupPluginRegistrySnapshotForChannel: (
    params: Parameters<LoadChannelSetupPluginRegistrySnapshotForChannel>[0],
  ) => loadChannelSetupPluginRegistrySnapshotForChannel(params),
}));

vi.mock("../commands/channel-setup/registry.js", () => ({
  resolveChannelSetupWizardAdapterForPlugin: (plugin?: { setupWizard?: unknown }) =>
    plugin?.setupWizard,
}));

vi.mock("../commands/channel-setup/trusted-catalog.js", () => ({
  listTrustedChannelPluginCatalogEntries: (params?: unknown) =>
    listTrustedChannelPluginCatalogEntries(params),
}));

vi.mock("../config/channel-configured.js", () => ({
  isChannelConfigured: (cfg?: unknown, channel?: unknown) => isChannelConfigured(cfg, channel),
}));

vi.mock("./channel-setup.prompts.js", () => ({
  maybeConfigureDmPolicies: vi.fn(),
  promptConfiguredAction: vi.fn(),
  promptRemovalAccountId: vi.fn(),
  formatAccountLabel: vi.fn(),
}));

vi.mock("./channel-setup.status.js", () => ({
  collectChannelStatus: (params: Parameters<CollectChannelStatus>[0]) =>
    collectChannelStatus(params),
  noteChannelPrimer: vi.fn(),
  noteChannelStatus: vi.fn(),
  resolveChannelSelectionNoteLines: vi.fn(() => []),
  resolveChannelSetupSelectionContributions: vi.fn(() => []),
  resolveQuickstartDefault: vi.fn(() => undefined),
}));

import { setupChannels } from "./channel-setup.js";

describe("setupChannels workspace shadow exclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw-workspace");
    resolveDefaultAgentId.mockReturnValue("default");
    listTrustedChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "external-chat",
        pluginId: "@vendor/external-chat-plugin",
        origin: "bundled",
      },
    ]);
    getChannelSetupPlugin.mockReturnValue(undefined);
    listActiveChannelSetupPlugins.mockReturnValue([]);
    listChannelSetupPlugins.mockReturnValue([]);
    loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(makePluginRegistry());
    ensureChannelSetupPluginInstalled.mockImplementation(async ({ cfg, entry }) => ({
      cfg,
      installed: true,
      pluginId: entry?.pluginId,
      status: "installed",
    }));
    resolveChannelSetupEntries.mockReturnValue(makeChannelSetupEntries());
    collectChannelStatus.mockResolvedValue({
      installedPlugins: [],
      catalogEntries: [],
      installedCatalogEntries: [],
      statusByChannel: new Map(),
      statusLines: [],
    });
    isChannelConfigured.mockReturnValue(true);
  });

  it("preloads configured external plugins from the trusted catalog boundary", async () => {
    await setupChannels(
      {} as never,
      {} as never,
      {
        confirm: vi.fn(async () => false),
        note: vi.fn(async () => undefined),
      } as never,
    );

    expect(listTrustedChannelPluginCatalogEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "external-chat",
        pluginId: "@vendor/external-chat-plugin",
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
  });

  it("keeps trusted workspace overrides eligible during preload", async () => {
    listTrustedChannelPluginCatalogEntries.mockReturnValue([
      { id: "external-chat", pluginId: "trusted-external-chat-shadow", origin: "workspace" },
    ]);

    await setupChannels(
      {
        plugins: {
          enabled: true,
          allow: ["trusted-external-chat-shadow"],
        },
      } as never,
      {} as never,
      {
        confirm: vi.fn(async () => false),
        note: vi.fn(async () => undefined),
      } as never,
    );

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "external-chat",
        pluginId: "trusted-external-chat-shadow",
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
  });

  it("defers status and setup-plugin loads until a channel is selected", async () => {
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    const select = vi.fn(async () => "__done__");

    await setupChannels(
      {} as never,
      {} as never,
      {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => undefined),
        select,
      } as never,
      {
        deferStatusUntilSelection: true,
        skipConfirm: true,
      },
    );

    expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: "Select a channel" }));
    expect(collectChannelStatus).not.toHaveBeenCalled();
    expect(listTrustedChannelPluginCatalogEntries).not.toHaveBeenCalled();
    expect(listChannelSetupPlugins).not.toHaveBeenCalled();
    expect(getChannelSetupPlugin).not.toHaveBeenCalled();
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
  });

  it("keeps already-active setup plugins in the deferred picker without registry fallback", async () => {
    const activePlugin = {
      ...makeSetupPlugin({ id: "custom-chat", label: "Custom Chat" }),
    };
    listActiveChannelSetupPlugins.mockReturnValue([activePlugin]);
    resolveChannelSetupEntries.mockImplementation(() => ({
      entries: [],
      installedCatalogEntries: [],
      installableCatalogEntries: [],
      installedCatalogById: new Map(),
      installableCatalogById: new Map(),
    }));
    const select = vi.fn(async () => "__done__");

    await setupChannels(
      {} as never,
      {} as never,
      {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => undefined),
        select,
      } as never,
      {
        deferStatusUntilSelection: true,
        skipConfirm: true,
      },
    );

    expect(resolveChannelSetupEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        installedPlugins: [activePlugin],
      }),
    );
    expect(listChannelSetupPlugins).not.toHaveBeenCalled();
    expect(collectChannelStatus).not.toHaveBeenCalled();
  });

  it("uses an active deferred setup plugin without enabling config on selection", async () => {
    const setupWizard = {
      channel: "custom-chat",
      getStatus: vi.fn(async () => ({
        channel: "custom-chat",
        configured: false,
        statusLines: [],
      })),
      configure: vi.fn(async ({ cfg }: { cfg: Record<string, unknown> }) => ({
        cfg: {
          ...cfg,
          channels: {
            "custom-chat": { token: "secret" },
          },
        },
      })),
    };
    const activePlugin = makeSetupPlugin({
      id: "custom-chat",
      label: "Custom Chat",
      setupWizard,
    });
    listActiveChannelSetupPlugins.mockReturnValue([activePlugin]);
    resolveChannelSetupEntries.mockReturnValue(
      makeChannelSetupEntries({
        entries: [
          {
            id: "custom-chat",
            meta: makeMeta("custom-chat", "Custom Chat"),
          },
        ],
        installedCatalogEntries: [],
        installableCatalogEntries: [],
        installedCatalogById: new Map(),
        installableCatalogById: new Map(),
      }),
    );
    const select = vi.fn().mockResolvedValueOnce("custom-chat").mockResolvedValueOnce("__done__");

    const next = await setupChannels(
      {} as never,
      {} as never,
      {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => undefined),
        select,
      } as never,
      {
        deferStatusUntilSelection: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    );

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
    expect(setupWizard.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
      }),
    );
    expect(next).toEqual({
      channels: {
        "custom-chat": { token: "secret" },
      },
    });
  });

  it("loads the selected bundled catalog plugin without writing explicit plugin enablement", async () => {
    const configure = vi.fn(async ({ cfg }: { cfg: Record<string, unknown> }) => ({
      cfg: {
        ...cfg,
        channels: {
          "external-chat": { token: "secret" },
        },
      } as never,
    }));
    const setupWizard = {
      channel: "external-chat",
      getStatus: vi.fn(async () => ({
        channel: "external-chat",
        configured: false,
        statusLines: [],
      })),
      configure,
    } as ChannelSetupPlugin["setupWizard"];
    const externalChatPlugin = makeSetupPlugin({
      id: "external-chat",
      label: "External Chat",
      setupWizard,
    });
    const installedCatalogEntry = makeCatalogEntry("external-chat", "External Chat", {
      pluginId: "external-chat",
      origin: "bundled",
    });
    resolveChannelSetupEntries.mockReturnValue(
      externalChatSetupEntries({
        installedCatalogEntries: [installedCatalogEntry],
        installedCatalogById: new Map([["external-chat", installedCatalogEntry]]),
      }),
    );
    loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(
      makePluginRegistry({
        channels: [
          {
            pluginId: "external-chat",
            source: "bundled",
            plugin: externalChatPlugin,
          },
        ],
      }),
    );
    const select = vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__");

    const next = await setupChannels(
      {} as never,
      {} as never,
      {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => undefined),
        select,
      } as never,
      {
        deferStatusUntilSelection: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    );

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(2);
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: "external-chat",
        pluginId: "external-chat",
        workspaceDir: "/tmp/openclaw-workspace",
        installRuntimeDeps: false,
      }),
    );
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: "external-chat",
        workspaceDir: "/tmp/openclaw-workspace",
        forceSetupOnlyChannelPlugins: true,
        installRuntimeDeps: true,
      }),
    );
    expect(getChannelSetupPlugin).not.toHaveBeenCalled();
    expect(collectChannelStatus).not.toHaveBeenCalled();
    expect(configure).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
      }),
    );
    expect(next).toEqual({
      channels: {
        "external-chat": { token: "secret" },
      },
    });
  });

  it("returns to quickstart selection when install-on-demand is skipped", async () => {
    const configure = vi.fn(async ({ cfg }: { cfg: Record<string, unknown> }) => ({ cfg }));
    const externalChatPlugin = makeSetupPlugin({
      id: "external-chat",
      label: "External Chat",
      setupWizard: {
        channel: "external-chat",
        getStatus: vi.fn(async () => ({
          channel: "external-chat",
          configured: false,
          statusLines: [],
        })),
        configure,
      } as ChannelSetupPlugin["setupWizard"],
    });
    const installableCatalogEntry = makeCatalogEntry("external-chat", "External Chat", {
      pluginId: "@vendor/external-chat-plugin",
    });
    resolveChannelSetupEntries.mockReturnValue(
      makeChannelSetupEntries({
        entries: [
          {
            id: "external-chat",
            meta: makeMeta("external-chat", "External Chat"),
          },
        ],
        installableCatalogEntries: [installableCatalogEntry],
        installableCatalogById: new Map([["external-chat", installableCatalogEntry]]),
      }),
    );
    ensureChannelSetupPluginInstalled
      .mockResolvedValueOnce({
        cfg: {},
        installed: false,
        pluginId: "@vendor/external-chat-plugin",
        status: "skipped",
      })
      .mockResolvedValueOnce({
        cfg: {},
        installed: true,
        pluginId: "@vendor/external-chat-plugin",
        status: "installed",
      });
    loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(
      makePluginRegistry({
        channelSetups: [
          {
            pluginId: "@vendor/external-chat-plugin",
            source: "global",
            enabled: true,
            plugin: externalChatPlugin,
          },
        ],
      }),
    );
    let quickstartSelectionCount = 0;
    const select = vi.fn(async ({ message }: { message: string }) => {
      if (message === "Select channel (QuickStart)") {
        quickstartSelectionCount += 1;
        return "external-chat";
      }
      return "__done__";
    });

    await setupChannels(
      {} as never,
      {} as never,
      {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => undefined),
        select,
      } as never,
      {
        quickstartDefaults: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    );

    expect(quickstartSelectionCount).toBe(2);
    expect(ensureChannelSetupPluginInstalled).toHaveBeenCalledTimes(2);
    expect(configure).toHaveBeenCalledTimes(1);
  });

  it("does not load or re-enable an explicitly disabled channel when selected lazily", async () => {
    const setupWizard = {
      channel: "external-chat",
      getStatus: vi.fn(async () => ({
        channel: "external-chat",
        configured: true,
        statusLines: [],
      })),
      configure: vi.fn(),
    };
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    const select = vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__");
    const note = vi.fn(async () => undefined);
    const cfg = {
      channels: {
        "external-chat": { enabled: false, token: "secret" },
      },
    };

    const next = await setupChannels(
      cfg as never,
      {} as never,
      {
        confirm: vi.fn(async () => true),
        note,
        select,
      } as never,
      {
        deferStatusUntilSelection: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    );

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      "external-chat cannot be configured while disabled. Enable it before setup.",
      "Channel setup",
    );
    expect(setupWizard.configure).not.toHaveBeenCalled();
    expect(next).toEqual({
      channels: {
        "external-chat": { enabled: false, token: "secret" },
      },
    });
  });

  it("honors global plugin disablement before lazy channel setup loads plugins", async () => {
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    const select = vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__");
    const note = vi.fn(async () => undefined);
    const cfg = {
      plugins: { enabled: false },
      channels: {
        "external-chat": { enabled: true, token: "secret" },
      },
    };

    await setupChannels(
      cfg as never,
      {} as never,
      {
        confirm: vi.fn(async () => true),
        note,
        select,
      } as never,
      {
        deferStatusUntilSelection: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    );

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      "external-chat cannot be configured while plugins disabled. Enable it before setup.",
      "Channel setup",
    );
  });
});
