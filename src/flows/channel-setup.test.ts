// Channel setup tests cover setup flow prompts and config output.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { WizardCancelledError, WizardNavigationError } from "../wizard/prompts.js";
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
  const registry = createEmptyPluginRegistry();
  for (const key of Object.keys(overrides) as Array<keyof PluginRegistry>) {
    const value = overrides[key];
    if (value !== undefined) {
      Object.assign(registry, { [key]: value });
    }
  }
  return registry;
}

function callArg<T>(mock: { mock: { calls: unknown[][] } }, index = 0, _type?: (value: T) => T): T {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  return call[0] as T;
}

function mockCall(mock: { mock: { calls: unknown[][] } }, index = 0): unknown[] {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call ${index}`);
  }
  return call;
}

function expectExternalCatalogInstallCall(index = 0) {
  const input = callArg<{
    entry?: { id?: string; install?: { npmSpec?: string } };
    autoConfirmSingleSource?: boolean;
  }>(ensureChannelSetupPluginInstalled, index);
  expect(input.entry?.id).toBe("external-chat");
  expect(input.entry?.install?.npmSpec).toBe("@vendor/external-chat-plugin");
  expect(input.autoConfirmSingleSource).toBe(true);
}

const resolveAgentWorkspaceDir = vi.hoisted(() =>
  vi.fn((_cfg?: unknown, _agentId?: unknown) => "/tmp/openclaw-workspace"),
);
const resolveDefaultAgentId = vi.hoisted(() => vi.fn((_cfg?: unknown) => "default"));
const listTrustedChannelPluginCatalogEntries = vi.hoisted(() =>
  vi.fn((_params?: unknown): unknown[] => []),
);
const getTrustedChannelPluginCatalogEntry = vi.hoisted(() =>
  vi.fn((_channelId: string, _params?: unknown): unknown => undefined),
);
const getChannelSetupPlugin = vi.hoisted(() => vi.fn((_channel?: unknown) => undefined));
const listChannelSetupPlugins = vi.hoisted(() => vi.fn((): unknown[] => []));
const listActiveChannelSetupPlugins = vi.hoisted(() => vi.fn((): unknown[] => []));
const loadChannelSetupPluginRegistrySnapshotForChannel = vi.hoisted(() =>
  vi.fn((_params: Parameters<LoadChannelSetupPluginRegistrySnapshotForChannel>[0]) =>
    makePluginRegistry(),
  ),
);
const ensureChannelSetupPluginInstalled = vi.hoisted(() =>
  vi.fn(async ({ cfg, entry }: Parameters<EnsureChannelSetupPluginInstalled>[0]) => ({
    cfg,
    installed: true,
    pluginId: entry?.pluginId,
    status: "installed",
  })),
);
const resolveChannelSetupEntries = vi.hoisted(() =>
  vi.fn(
    (
      _params: Parameters<ResolveChannelSetupEntries>[0],
    ): ReturnType<ResolveChannelSetupEntries> => ({
      entries: [],
      installedCatalogEntries: [],
      installableCatalogEntries: [],
      installedCatalogById: new Map(),
      installableCatalogById: new Map(),
    }),
  ),
);
const collectChannelStatus = vi.hoisted(() =>
  vi.fn(async (_params: Parameters<CollectChannelStatus>[0]) => ({
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
  normalizeAnyChannelId: (channelId?: unknown) =>
    typeof channelId === "string" ? channelId.trim().toLowerCase() || null : null,
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
  getTrustedChannelPluginCatalogEntry: (channelId: string, params?: unknown) =>
    getTrustedChannelPluginCatalogEntry(channelId, params),
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
  findBundledSourceForCatalogChannel: vi.fn(() => undefined),
  noteChannelPrimer: vi.fn(),
  noteChannelStatus: vi.fn(),
  resolveCatalogChannelSelectionHint: vi.fn(() => "download from <npm>"),
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
    getTrustedChannelPluginCatalogEntry.mockReturnValue(undefined);
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

    const trustedInput = callArg<{ cfg?: unknown; workspaceDir?: string }>(
      listTrustedChannelPluginCatalogEntries,
    );
    expect(trustedInput.cfg).toEqual({});
    expect(trustedInput.workspaceDir).toBe("/tmp/openclaw-workspace");
    const registryInput = callArg<{
      channel?: string;
      pluginId?: string;
      workspaceDir?: string;
    }>(loadChannelSetupPluginRegistrySnapshotForChannel);
    expect(registryInput.channel).toBe("external-chat");
    expect(registryInput.pluginId).toBe("@vendor/external-chat-plugin");
    expect(registryInput.workspaceDir).toBe("/tmp/openclaw-workspace");
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

    const registryInput = callArg<{
      channel?: string;
      pluginId?: string;
      workspaceDir?: string;
    }>(loadChannelSetupPluginRegistrySnapshotForChannel);
    expect(registryInput.channel).toBe("external-chat");
    expect(registryInput.pluginId).toBe("trusted-external-chat-shadow");
    expect(registryInput.workspaceDir).toBe("/tmp/openclaw-workspace");
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

    expect(callArg<{ message?: string }>(select).message).toBe("Select a channel");
    expect(collectChannelStatus).not.toHaveBeenCalled();
    expect(listTrustedChannelPluginCatalogEntries).not.toHaveBeenCalled();
    expect(listChannelSetupPlugins).not.toHaveBeenCalled();
    expect(getChannelSetupPlugin).not.toHaveBeenCalled();
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
  });

  it("puts skip first and selected by default in QuickStart channel selection", async () => {
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    const select = vi.fn(async () => "__skip__");

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
        quickstartDefaults: true,
        skipConfirm: true,
      },
    );

    const prompt = callArg<{
      message?: string;
      options?: Array<{ value: string; label: string }>;
      initialValue?: string;
      searchable?: boolean;
    }>(select);
    expect(prompt.message).toBe("Select channel (QuickStart)");
    expect(prompt.options?.[0]).toEqual(
      expect.objectContaining({
        value: "__skip__",
        label: "Skip for now",
      }),
    );
    expect(prompt.initialValue).toBe("__skip__");
    expect(prompt.searchable).toBe(true);
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

    expect(
      callArg<{ installedPlugins?: unknown[] }>(resolveChannelSetupEntries).installedPlugins,
    ).toEqual([activePlugin]);
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
    expect(callArg<{ cfg?: unknown }>(setupWizard.configure).cfg).toEqual({});
    expect(next).toEqual({
      channels: {
        "custom-chat": { token: "secret" },
      },
    });
  });

  it("allowlists ClickClack when it is explicitly selected for setup", async () => {
    const setupWizard = {
      channel: "clickclack",
      getStatus: vi.fn(async () => ({
        channel: "clickclack",
        configured: false,
        statusLines: [],
      })),
      configure: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
        cfg: {
          ...cfg,
          channels: {
            ...cfg.channels,
            clickclack: {
              ...cfg.channels?.clickclack,
              token: "secret",
            },
          },
        },
      })),
    };
    const clickClackPlugin = makeSetupPlugin({
      id: "clickclack",
      label: "ClickClack",
      setupWizard,
    });
    resolveChannelSetupEntries.mockReturnValue(
      makeChannelSetupEntries({
        entries: [
          {
            id: "clickclack",
            meta: makeMeta("clickclack", "ClickClack"),
          },
        ],
      }),
    );
    loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(
      makePluginRegistry({
        channelSetups: [
          {
            pluginId: "clickclack",
            source: "bundled",
            enabled: true,
            plugin: clickClackPlugin,
          },
        ],
      }),
    );
    const select = vi.fn().mockResolvedValueOnce("clickclack").mockResolvedValueOnce("__done__");

    const next = await setupChannels(
      {
        plugins: {
          allow: ["memory-core"],
        },
      } as never,
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

    expect(next.plugins?.allow).toEqual(["memory-core", "clickclack"]);
    expect(next.plugins?.entries?.clickclack?.enabled).toBe(true);
    expect(next.channels?.clickclack).toEqual({
      enabled: true,
      token: "secret",
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
    const firstRegistryInput = callArg<{
      channel?: string;
      pluginId?: string;
      workspaceDir?: string;
      forceSetupOnlyChannelPlugins?: boolean;
    }>(loadChannelSetupPluginRegistrySnapshotForChannel, 0);
    expect(firstRegistryInput.channel).toBe("external-chat");
    expect(firstRegistryInput.pluginId).toBe("external-chat");
    expect(firstRegistryInput.workspaceDir).toBe("/tmp/openclaw-workspace");
    expect(firstRegistryInput.forceSetupOnlyChannelPlugins).toBe(true);
    const secondRegistryInput = callArg<{
      channel?: string;
      workspaceDir?: string;
      forceSetupOnlyChannelPlugins?: boolean;
    }>(loadChannelSetupPluginRegistrySnapshotForChannel, 1);
    expect(secondRegistryInput.channel).toBe("external-chat");
    expect(secondRegistryInput.workspaceDir).toBe("/tmp/openclaw-workspace");
    expect(secondRegistryInput.forceSetupOnlyChannelPlugins).toBe(true);
    expect(getChannelSetupPlugin).not.toHaveBeenCalled();
    expect(collectChannelStatus).not.toHaveBeenCalled();
    expect(callArg<{ cfg?: unknown }>(configure).cfg).toEqual({});
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

  it("returns an external install confirmation to channel selection before installing", async () => {
    const installableCatalogEntry = makeCatalogEntry("external-chat", "External Chat", {
      pluginId: "@vendor/external-chat-plugin",
    });
    resolveChannelSetupEntries.mockReturnValue(
      externalChatSetupEntries({
        installableCatalogEntries: [installableCatalogEntry],
        installableCatalogById: new Map([["external-chat", installableCatalogEntry]]),
      }),
    );
    ensureChannelSetupPluginInstalled.mockImplementationOnce(async ({ cfg, prompter }) => {
      await prompter.confirm({
        message: "Install External Chat?",
        initialValue: true,
      });
      return {
        cfg,
        installed: true,
        pluginId: "@vendor/external-chat-plugin",
        status: "installed",
      };
    });
    const select = vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__");
    const confirm = vi.fn(async () => {
      throw new WizardNavigationError("back");
    });
    const cfg = { channels: { telegram: { botToken: "keep" } } } as OpenClawConfig;

    const result = await setupChannels(
      cfg,
      {} as never,
      {
        confirm,
        note: vi.fn(async () => undefined),
        select,
      } as never,
      {
        deferStatusUntilSelection: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    );

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Install External Chat?",
        navigation: { canGoBack: true, canGoForward: false },
      }),
    );
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
    expect(result).toEqual(cfg);
  });

  it.each(["installed-catalog", "trusted-catalog-fallback"] as const)(
    "returns the %s reinstall confirmation to channel selection",
    async (source) => {
      const catalogEntry = makeCatalogEntry("external-chat", "External Chat", {
        pluginId: "@vendor/external-chat-plugin",
        install: { npmSpec: "@vendor/external-chat-plugin" },
      });
      resolveChannelSetupEntries.mockReturnValue(
        source === "installed-catalog"
          ? externalChatSetupEntries({
              installedCatalogEntries: [catalogEntry],
              installedCatalogById: new Map([["external-chat", catalogEntry]]),
            })
          : externalChatSetupEntries(),
      );
      if (source === "trusted-catalog-fallback") {
        getTrustedChannelPluginCatalogEntry.mockReturnValue(catalogEntry);
      }
      loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(makePluginRegistry());
      ensureChannelSetupPluginInstalled.mockImplementationOnce(async ({ cfg, prompter }) => {
        await prompter.confirm({
          message: "Reinstall External Chat?",
          initialValue: true,
        });
        return {
          cfg,
          installed: true,
          pluginId: "@vendor/external-chat-plugin",
          status: "installed",
        };
      });
      const confirm = vi.fn(async () => {
        throw new WizardNavigationError("back");
      });
      const cfg = { channels: { "external-chat": { token: "keep" } } } as OpenClawConfig;

      const result = await setupChannels(
        cfg,
        {} as never,
        {
          confirm,
          note: vi.fn(async () => undefined),
          select: vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__"),
        } as never,
        {
          deferStatusUntilSelection: true,
          skipConfirm: true,
          skipDmPolicyPrompt: true,
        },
      );

      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Reinstall External Chat?",
          navigation: { canGoBack: true, canGoForward: false },
        }),
      );
      expect(result).toEqual(cfg);
    },
  );

  it("returns custom channel setup to channel selection when its first prompt goes back", async () => {
    const configureInteractive = vi.fn(async ({ prompter }) => {
      await prompter.text({ message: "Custom channel token" });
      return {
        cfg: {
          channels: { "external-chat": { token: "should-not-apply" } },
        } as OpenClawConfig,
        accountId: "custom-account",
      };
    });
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
        configure: vi.fn(),
        configureInteractive,
      } as ChannelSetupPlugin["setupWizard"],
    });
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    listActiveChannelSetupPlugins.mockReturnValue([externalChatPlugin]);
    const select = vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__");
    const text = vi.fn(async () => {
      throw new WizardNavigationError("back");
    });
    const result = await setupChannels(
      { channels: { telegram: { botToken: "keep" } } } as OpenClawConfig,
      {} as never,
      {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => undefined),
        select,
        text,
      } as never,
      {
        deferStatusUntilSelection: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    );

    expect(configureInteractive).toHaveBeenCalledTimes(1);
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Custom channel token",
        navigation: { canGoBack: true, canGoForward: false },
      }),
    );
    expect(select).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ channels: { telegram: { botToken: "keep" } } });
  });

  it("returns declarative channel setup to channel selection when its first prompt goes back", async () => {
    const configure = vi.fn(async ({ cfg, prompter }) => {
      await prompter.text({ message: "Declarative channel token" });
      return {
        cfg: {
          ...cfg,
          channels: { ...cfg.channels, "external-chat": { token: "should-not-apply" } },
        },
        accountId: "declarative-account",
      };
    });
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
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    listActiveChannelSetupPlugins.mockReturnValue([externalChatPlugin]);
    const select = vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__");
    const text = vi.fn(async () => {
      throw new WizardNavigationError("back");
    });
    const result = await setupChannels(
      { channels: { telegram: { botToken: "keep" } } } as OpenClawConfig,
      {} as never,
      {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => undefined),
        select,
        text,
      } as never,
      {
        deferStatusUntilSelection: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    );

    expect(configure).toHaveBeenCalledTimes(1);
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Declarative channel token",
        navigation: { canGoBack: true, canGoForward: false },
      }),
    );
    expect(select).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ channels: { telegram: { botToken: "keep" } } });
  });

  it("returns configured channel actions to selection when their first prompt goes back", async () => {
    const configureWhenConfigured = vi.fn(async ({ cfg, prompter }) => {
      await prompter.select({
        message: "Configured channel action",
        options: [{ value: "update", label: "Update" }],
      });
      return {
        cfg: {
          ...cfg,
          channels: { ...cfg.channels, "external-chat": { token: "should-not-apply" } },
        },
      };
    });
    const externalChatPlugin = makeSetupPlugin({
      id: "external-chat",
      label: "External Chat",
      setupWizard: {
        channel: "external-chat",
        getStatus: vi.fn(async () => ({
          channel: "external-chat",
          configured: true,
          statusLines: [],
        })),
        configure: vi.fn(),
        configureWhenConfigured,
      } as ChannelSetupPlugin["setupWizard"],
    });
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    listActiveChannelSetupPlugins.mockReturnValue([externalChatPlugin]);
    const select = vi
      .fn()
      .mockResolvedValueOnce("external-chat")
      .mockRejectedValueOnce(new WizardNavigationError("back"))
      .mockResolvedValueOnce("__done__");
    const cfg = {
      channels: { "external-chat": { token: "keep" } },
    } as OpenClawConfig;

    const result = await setupChannels(
      cfg,
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

    expect(configureWhenConfigured).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: "Configured channel action",
        navigation: { canGoBack: true, canGoForward: false },
      }),
    );
    expect(result).toEqual(cfg);
  });

  it("rolls back reversible plugin enablement when channel setup goes back", async () => {
    const configure = vi.fn(async ({ cfg, prompter }) => {
      await prompter.text({ message: "ClickClack token" });
      return { cfg };
    });
    const clickClackPlugin = makeSetupPlugin({
      id: "clickclack",
      label: "ClickClack",
      setupWizard: {
        channel: "clickclack",
        getStatus: vi.fn(async () => ({
          channel: "clickclack",
          configured: false,
          statusLines: [],
        })),
        configure,
      } as ChannelSetupPlugin["setupWizard"],
    });
    resolveChannelSetupEntries.mockReturnValue(
      makeChannelSetupEntries({
        entries: [{ id: "clickclack", meta: makeMeta("clickclack", "ClickClack") }],
      }),
    );
    loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(
      makePluginRegistry({
        channelSetups: [
          {
            pluginId: "clickclack",
            source: "bundled",
            enabled: true,
            plugin: clickClackPlugin,
          },
        ],
      }),
    );
    const select = vi.fn().mockResolvedValueOnce("clickclack").mockResolvedValueOnce("__done__");
    const text = vi.fn(async () => {
      throw new WizardNavigationError("back");
    });
    const cfg = { plugins: { allow: ["memory-core"] } } as OpenClawConfig;

    const result = await setupChannels(
      cfg,
      {} as never,
      {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => undefined),
        select,
        text,
      } as never,
      {
        deferStatusUntilSelection: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    );

    expect(result).toEqual(cfg);
    expect(result.plugins?.allow).toEqual(["memory-core"]);
    expect(result.plugins?.entries?.clickclack).toBeUndefined();
  });

  it("preserves accepted external install metadata when later channel setup goes back", async () => {
    const configure = vi.fn(async ({ cfg, prompter }) => {
      await prompter.text({ message: "External Chat token" });
      return { cfg, accountId: "external-account" };
    });
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
      externalChatSetupEntries({
        installableCatalogEntries: [installableCatalogEntry],
        installableCatalogById: new Map([["external-chat", installableCatalogEntry]]),
      }),
    );
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
    ensureChannelSetupPluginInstalled.mockImplementationOnce(async (params) => {
      await params.beforePersistentEffect?.();
      return {
        cfg: {
          ...params.cfg,
          plugins: {
            ...params.cfg.plugins,
            entries: {
              ...params.cfg.plugins?.entries,
              "@vendor/external-chat-plugin": { enabled: true },
            },
            installs: {
              ...params.cfg.plugins?.installs,
              "@vendor/external-chat-plugin": {
                source: "npm",
                spec: "@vendor/external-chat-plugin@1.0.0",
              },
            },
          },
        },
        installed: true,
        pluginId: "@vendor/external-chat-plugin",
        status: "installed",
      };
    });
    const select = vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__");
    const beforePersistentEffect = vi.fn(async () => undefined);

    const result = await setupChannels(
      { channels: { telegram: { botToken: "keep" } } } as OpenClawConfig,
      {} as never,
      {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => undefined),
        select,
        text: vi.fn(async () => {
          throw new WizardNavigationError("back");
        }),
      } as never,
      {
        beforePersistentEffect,
        deferStatusUntilSelection: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    );

    expect(result.channels).toEqual({ telegram: { botToken: "keep" } });
    expect(result.plugins?.entries?.["@vendor/external-chat-plugin"]?.enabled).toBe(true);
    expect(result.plugins?.installs?.["@vendor/external-chat-plugin"]?.spec).toBe(
      "@vendor/external-chat-plugin@1.0.0",
    );
    expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
  });

  it("replays earlier prompts when Back is used inside channel setup", async () => {
    const configure = vi.fn(async ({ cfg, prompter }) => {
      const username = await prompter.text({ message: "Username" });
      const token = await prompter.text({ message: "Token" });
      return {
        cfg: { ...cfg, channels: { ...cfg.channels, "external-chat": { username, token } } },
      };
    });
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
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    listActiveChannelSetupPlugins.mockReturnValue([externalChatPlugin]);
    const text = vi
      .fn()
      .mockResolvedValueOnce("old-name")
      .mockRejectedValueOnce(new WizardNavigationError("back"))
      .mockResolvedValueOnce("new-name")
      .mockResolvedValueOnce("secret-token");

    const result = await setupChannels(
      {} as OpenClawConfig,
      {} as never,
      {
        confirm: vi.fn(async () => true),
        note: vi.fn(async () => undefined),
        select: vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__"),
        text,
      } as never,
      {
        deferStatusUntilSelection: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    );

    expect(configure).toHaveBeenCalledTimes(2);
    expect(result.channels?.["external-chat"]).toEqual({
      username: "new-name",
      token: "secret-token",
    });
    expect(mockCall(text, 2)[0]).toEqual(
      expect.objectContaining({
        initialValue: "old-name",
        navigation: { canGoBack: true, canGoForward: true },
      }),
    );
  });

  it("disables Back after a channel declares a persistent effect boundary", async () => {
    const configure = vi.fn(async ({ cfg, prompter, options }) => {
      await prompter.text({ message: "Before effect" });
      await options.beforePersistentEffect?.();
      await prompter.text({ message: "After effect" });
      return { cfg };
    });
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
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    listActiveChannelSetupPlugins.mockReturnValue([externalChatPlugin]);
    const navigationError = new WizardNavigationError("back");
    const text = vi.fn().mockResolvedValueOnce("ready").mockRejectedValueOnce(navigationError);
    const beforePersistentEffect = vi.fn(async () => undefined);

    await expect(
      setupChannels(
        {} as OpenClawConfig,
        {} as never,
        {
          confirm: vi.fn(async () => true),
          note: vi.fn(async () => undefined),
          select: vi.fn().mockResolvedValueOnce("external-chat"),
          text,
        } as never,
        {
          beforePersistentEffect,
          deferStatusUntilSelection: true,
          skipConfirm: true,
          skipDmPolicyPrompt: true,
        },
      ),
    ).rejects.toBe(navigationError);

    expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
    expect(mockCall(text, 1)[0]).toEqual(
      expect.objectContaining({
        navigation: { canGoBack: false, canGoForward: false },
      }),
    );
  });

  it("propagates Ctrl-C cancellation from channel setup", async () => {
    const cancelled = new WizardCancelledError();
    const configure = vi.fn(async ({ prompter }) => {
      await prompter.text({ message: "Token" });
      return { cfg: {} as OpenClawConfig };
    });
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
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    listActiveChannelSetupPlugins.mockReturnValue([externalChatPlugin]);

    await expect(
      setupChannels(
        {} as OpenClawConfig,
        {} as never,
        {
          confirm: vi.fn(async () => true),
          note: vi.fn(async () => undefined),
          select: vi.fn().mockResolvedValueOnce("external-chat"),
          text: vi.fn(async () => {
            throw cancelled;
          }),
        } as never,
        {
          deferStatusUntilSelection: true,
          skipConfirm: true,
          skipDmPolicyPrompt: true,
        },
      ),
    ).rejects.toBe(cancelled);
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

  it(
    "reinstalls the external plugin via catalog when a stale channel config " +
      "declares an already-installed plugin whose runtime cannot be loaded",
    async () => {
      // Regression: users who uninstalled an externalized channel plugin
      // (qqbot / imessage / discord / ...) while a non-empty
      // `channels.<id>` entry remained in their config got dead-ended with
      // "<channel> plugin not available" because the installed-catalog
      // branch did not fall back to the catalog install flow.
      const configure = vi.fn(async ({ cfg }: { cfg: Record<string, unknown> }) => ({
        cfg: { ...cfg, channels: { "external-chat": { token: "secret" } } },
      }));
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
      const installedCatalogEntry = makeCatalogEntry("external-chat", "External Chat", {
        pluginId: "@vendor/external-chat-plugin",
        install: { npmSpec: "@vendor/external-chat-plugin" },
      });
      resolveChannelSetupEntries.mockReturnValue(
        externalChatSetupEntries({
          installedCatalogEntries: [installedCatalogEntry],
          installedCatalogById: new Map([["external-chat", installedCatalogEntry]]),
        }),
      );
      // First snapshot (pre-install) is empty — plugin runtime is gone.
      // After `ensureChannelSetupPluginInstalled` runs, subsequent snapshots
      // resolve the plugin as expected.
      loadChannelSetupPluginRegistrySnapshotForChannel
        .mockReturnValueOnce(makePluginRegistry())
        .mockReturnValue(
          makePluginRegistry({
            channels: [
              {
                pluginId: "@vendor/external-chat-plugin",
                source: "global",
                plugin: externalChatPlugin,
              },
            ],
          }),
        );
      ensureChannelSetupPluginInstalled.mockResolvedValueOnce({
        cfg: {},
        installed: true,
        pluginId: "@vendor/external-chat-plugin",
        status: "installed",
      });
      isChannelConfigured.mockReturnValue(false);
      const note = vi.fn(async () => undefined);
      const select = vi
        .fn()
        .mockResolvedValueOnce("external-chat")
        .mockResolvedValueOnce("__done__");

      await setupChannels(
        {} as never,
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

      expect(ensureChannelSetupPluginInstalled).toHaveBeenCalledTimes(1);
      expectExternalCatalogInstallCall();
      expect(note).not.toHaveBeenCalledWith("external-chat plugin not available.", "Channel setup");
      expect(configure).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "returns to channel selection when catalog-fallback install is declined " +
      "from the installed-catalog branch",
    async () => {
      const installedCatalogEntry = makeCatalogEntry("external-chat", "External Chat", {
        pluginId: "@vendor/external-chat-plugin",
        install: { npmSpec: "@vendor/external-chat-plugin" },
      });
      resolveChannelSetupEntries.mockReturnValue(
        externalChatSetupEntries({
          installedCatalogEntries: [installedCatalogEntry],
          installedCatalogById: new Map([["external-chat", installedCatalogEntry]]),
        }),
      );
      loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(makePluginRegistry());
      ensureChannelSetupPluginInstalled.mockResolvedValueOnce({
        cfg: {},
        installed: false,
        pluginId: "@vendor/external-chat-plugin",
        status: "skipped",
      });
      isChannelConfigured.mockReturnValue(false);
      let quickstartSelectionCount = 0;
      const select = vi.fn(async ({ message }: { message: string }) => {
        if (message === "Select channel (QuickStart)") {
          quickstartSelectionCount += 1;
          if (quickstartSelectionCount === 1) {
            return "external-chat";
          }
        }
        return "__skip__";
      });
      const note = vi.fn(async () => undefined);

      await setupChannels(
        {} as never,
        {} as never,
        {
          confirm: vi.fn(async () => true),
          note,
          select,
        } as never,
        {
          quickstartDefaults: true,
          skipConfirm: true,
          skipDmPolicyPrompt: true,
        },
      );

      // Install prompt ran once, was declined; user returned to channel
      // selection (quickstartSelectionCount === 2) rather than being
      // dead-ended with a "plugin not available" note.
      expect(ensureChannelSetupPluginInstalled).toHaveBeenCalledTimes(1);
      expect(quickstartSelectionCount).toBe(2);
      expect(note).not.toHaveBeenCalledWith("external-chat plugin not available.", "Channel setup");
    },
  );

  it(
    "auto-installs external plugin from catalog when both discovery buckets " +
      "are empty due to a stale `channels.<id>` config entry",
    async () => {
      // Regression test for the real-world repro: `channels.qqbot` has stale
      // fields (appId/secret) from an earlier install, so
      // `isStaticallyChannelConfigured` drops qqbot from
      // `installableCatalogEntries`; qqbot isn't on disk either, so
      // `manifestInstalledIds` doesn't include it. Both discovery buckets
      // come back empty, but the channel is still selectable (entries list
      // does not apply the static-config filter). Before the fix, onboard
      // fell through to `enableBundledPluginForSetup` which just printed
      // "qqbot plugin not available." and exited the flow. The fix consults
      // the catalog directly and drives `ensureChannelSetupPluginInstalled`.
      const configure = vi.fn(async ({ cfg }: { cfg: Record<string, unknown> }) => ({
        cfg: { ...cfg, channels: { "external-chat": { token: "secret" } } },
      }));
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
      // Entries list exposes the channel in the menu, but BOTH discovery
      // buckets are empty — faithfully reproducing the observed bug.
      resolveChannelSetupEntries.mockReturnValue(
        makeChannelSetupEntries({
          entries: [
            {
              id: "external-chat",
              meta: makeMeta("external-chat", "External Chat"),
            },
          ],
          installedCatalogEntries: [],
          installableCatalogEntries: [],
          installedCatalogById: new Map(),
          installableCatalogById: new Map(),
        }),
      );
      const fallbackCatalogEntry = makeCatalogEntry("external-chat", "External Chat", {
        pluginId: "@vendor/external-chat-plugin",
        install: { npmSpec: "@vendor/external-chat-plugin" },
      });
      getTrustedChannelPluginCatalogEntry.mockReturnValue(fallbackCatalogEntry);
      ensureChannelSetupPluginInstalled.mockResolvedValueOnce({
        cfg: {},
        installed: true,
        pluginId: "@vendor/external-chat-plugin",
        status: "installed",
      });
      loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(
        makePluginRegistry({
          channels: [
            {
              pluginId: "@vendor/external-chat-plugin",
              source: "global",
              plugin: externalChatPlugin,
            },
          ],
        }),
      );
      isChannelConfigured.mockReturnValue(false);
      const note = vi.fn(async () => undefined);
      const select = vi
        .fn()
        .mockResolvedValueOnce("external-chat")
        .mockResolvedValueOnce("__done__");

      await setupChannels(
        {} as never,
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

      const catalogLookupCall = mockCall(getTrustedChannelPluginCatalogEntry) as [
        string,
        { workspaceDir?: string } | undefined,
      ];
      expect(catalogLookupCall[0]).toBe("external-chat");
      expect(catalogLookupCall[1]?.workspaceDir).toBe("/tmp/openclaw-workspace");
      expect(ensureChannelSetupPluginInstalled).toHaveBeenCalledTimes(1);
      expectExternalCatalogInstallCall();
      expect(note).not.toHaveBeenCalledWith("external-chat plugin not available.", "Channel setup");
      expect(configure).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "returns to channel selection when the catalog-fallback install is " +
      "declined from the bundled-enable branch",
    async () => {
      resolveChannelSetupEntries.mockReturnValue(
        makeChannelSetupEntries({
          entries: [
            {
              id: "external-chat",
              meta: makeMeta("external-chat", "External Chat"),
            },
          ],
        }),
      );
      const fallbackCatalogEntry = makeCatalogEntry("external-chat", "External Chat", {
        pluginId: "@vendor/external-chat-plugin",
        install: { npmSpec: "@vendor/external-chat-plugin" },
      });
      getTrustedChannelPluginCatalogEntry.mockReturnValue(fallbackCatalogEntry);
      ensureChannelSetupPluginInstalled.mockResolvedValueOnce({
        cfg: {},
        installed: false,
        pluginId: "@vendor/external-chat-plugin",
        status: "skipped",
      });
      isChannelConfigured.mockReturnValue(false);
      let quickstartSelectionCount = 0;
      const select = vi.fn(async ({ message }: { message: string }) => {
        if (message === "Select channel (QuickStart)") {
          quickstartSelectionCount += 1;
          if (quickstartSelectionCount === 1) {
            return "external-chat";
          }
        }
        return "__skip__";
      });
      const note = vi.fn(async () => undefined);

      await setupChannels(
        {} as never,
        {} as never,
        {
          confirm: vi.fn(async () => true),
          note,
          select,
        } as never,
        {
          quickstartDefaults: true,
          skipConfirm: true,
          skipDmPolicyPrompt: true,
        },
      );

      expect(ensureChannelSetupPluginInstalled).toHaveBeenCalledTimes(1);
      expect(quickstartSelectionCount).toBe(2);
      expect(note).not.toHaveBeenCalledWith("external-chat plugin not available.", "Channel setup");
    },
  );

  it("fails closed when the catalog-fallback install guard rejects", async () => {
    resolveChannelSetupEntries.mockReturnValue(
      makeChannelSetupEntries({
        entries: [
          {
            id: "external-chat",
            meta: makeMeta("external-chat", "External Chat"),
          },
        ],
      }),
    );
    const fallbackCatalogEntry = makeCatalogEntry("external-chat", "External Chat", {
      pluginId: "@vendor/external-chat-plugin",
      install: { npmSpec: "@vendor/external-chat-plugin" },
    });
    getTrustedChannelPluginCatalogEntry.mockReturnValue(fallbackCatalogEntry);
    isChannelConfigured.mockReturnValue(false);
    const guardError = new Error("verified inference owner changed");
    const beforePersistentEffect = vi.fn(async () => {
      throw guardError;
    });
    ensureChannelSetupPluginInstalled.mockImplementationOnce(async (params) => {
      await params.beforePersistentEffect?.();
      return {
        cfg: params.cfg,
        installed: true,
        pluginId: params.entry.pluginId,
        status: "installed",
      };
    });
    const select = vi.fn().mockResolvedValueOnce("external-chat");

    await expect(
      setupChannels(
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
          beforePersistentEffect,
        },
      ),
    ).rejects.toBe(guardError);

    expect(ensureChannelSetupPluginInstalled).toHaveBeenCalledTimes(1);
    expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
  });

  it(
    "refuses catalog-fallback install from empty discovery buckets when the " +
      "channel is explicitly disabled in config",
    async () => {
      // Review-note regression: the bundled-enable `else` branch used to rely
      // on `enableBundledPluginForSetup`'s own disabled-config guard. The
      // new catalog fallback runs BEFORE that helper, so it must re-apply
      // the same `resolveConfigDisabledHint` check — otherwise an operator-
      // disabled channel with a stale `channels.<id>` entry could be
      // reinstalled/re-enabled silently.
      //
      // We intentionally do NOT pass `deferStatusUntilSelection` here so the
      // top-level `deferredDisabledHint` guard in `handleChannelChoice` is
      // bypassed. That isolates the guard newly added inside the catalog
      // fallback; without it, the test would pass against an unguarded
      // fallback because the QuickStart path's early guard would catch the
      // disabled state first.
      resolveChannelSetupEntries.mockReturnValue(
        makeChannelSetupEntries({
          entries: [
            {
              id: "external-chat",
              meta: makeMeta("external-chat", "External Chat"),
            },
          ],
        }),
      );
      const fallbackCatalogEntry = makeCatalogEntry("external-chat", "External Chat", {
        pluginId: "@vendor/external-chat-plugin",
        install: { npmSpec: "@vendor/external-chat-plugin" },
      });
      getTrustedChannelPluginCatalogEntry.mockReturnValue(fallbackCatalogEntry);
      const select = vi
        .fn()
        .mockResolvedValueOnce("external-chat")
        .mockResolvedValueOnce("__done__");
      const note = vi.fn(async () => undefined);
      // Operator has explicitly disabled the plugin while a stale
      // `channels.<id>` entry lingers in config.
      const cfg = {
        plugins: { entries: { "external-chat": { enabled: false } } },
        channels: {
          "external-chat": {
            enabled: true,
            appId: "999999",
            clientSecret: "stale",
          },
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
          skipConfirm: true,
          skipDmPolicyPrompt: true,
        },
      );

      // The new catalog fallback must NOT drive an install.
      expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
      // Instead, the same "Enable it before setup." note used by
      // `enableBundledPluginForSetup` should be shown.
      expect(note).toHaveBeenCalledWith(
        "external-chat cannot be configured while plugin disabled. Enable it before setup.",
        "Channel setup",
      );
    },
  );

  it(
    "refuses the installed-catalog install fallback when the channel is " +
      "explicitly disabled in config",
    async () => {
      // Symmetric guard for the `installedCatalogEntry` fallback path. When
      // `loadScopedChannelPlugin` returns null and the catalog entry carries
      // `install.npmSpec`, the fix reaches for the catalog install flow —
      // but must first respect an operator-level disable, matching the
      // guard inside `enableBundledPluginForSetup`.
      //
      // As in the sibling test, we omit `deferStatusUntilSelection` to skip
      // the top-level guard and isolate the new inline guard.
      const installedCatalogEntry = makeCatalogEntry("external-chat", "External Chat", {
        pluginId: "@vendor/external-chat-plugin",
        install: { npmSpec: "@vendor/external-chat-plugin" },
      });
      resolveChannelSetupEntries.mockReturnValue(
        externalChatSetupEntries({
          installedCatalogEntries: [installedCatalogEntry],
          installedCatalogById: new Map([["external-chat", installedCatalogEntry]]),
        }),
      );
      loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(makePluginRegistry());
      isChannelConfigured.mockReturnValue(false);
      const select = vi
        .fn()
        .mockResolvedValueOnce("external-chat")
        .mockResolvedValueOnce("__done__");
      const note = vi.fn(async () => undefined);
      const cfg = {
        plugins: { entries: { "external-chat": { enabled: false } } },
        channels: {
          "external-chat": {
            enabled: true,
            appId: "999999",
            clientSecret: "stale",
          },
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
          skipConfirm: true,
          skipDmPolicyPrompt: true,
        },
      );

      expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
      expect(note).toHaveBeenCalledWith(
        "external-chat cannot be configured while plugin disabled. Enable it before setup.",
        "Channel setup",
      );
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
