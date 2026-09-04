// Channel plugin resolution tests cover trusted catalog lookup, install prompts, and setup plugin snapshots.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { createPluginRuntimeStore } from "../../plugin-sdk/runtime-store.js";

const mocks = vi.hoisted(() => ({
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  listChannelPluginCatalogEntries: vi.fn(),
  getChannelPluginCatalogEntry: vi.fn(),
  getChannelPlugin: vi.fn(),
  getLoadedChannelPlugin: vi.fn(),
  loadChannelSetupPluginRegistrySnapshotForChannel: vi.fn(),
  ensureChannelSetupPluginInstalled: vi.fn(),
  createClackPrompter: vi.fn(() => ({}) as never),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("../../channels/plugins/catalog.js", () => ({
  listRawChannelPluginCatalogEntries: mocks.listChannelPluginCatalogEntries,
  getChannelPluginCatalogEntry: mocks.getChannelPluginCatalogEntry,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
  getLoadedChannelPlugin: mocks.getLoadedChannelPlugin,
  normalizeChannelId: (value: unknown) => (typeof value === "string" ? value.trim() || null : null),
}));

vi.mock("./plugin-install.js", () => ({
  loadChannelSetupPluginRegistrySnapshotForChannel:
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel,
  ensureChannelSetupPluginInstalled: mocks.ensureChannelSetupPluginInstalled,
}));

vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

import { resolveInstallableChannelPlugin } from "./channel-plugin-resolution.js";

function createCatalogEntry(params: {
  id: string;
  pluginId: string;
  origin?: "workspace" | "bundled";
}): ChannelPluginCatalogEntry {
  return {
    id: params.id,
    pluginId: params.pluginId,
    origin: params.origin,
    meta: {
      id: params.id,
      label: "Telegram",
      selectionLabel: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "Telegram channel",
    },
    install: {
      npmSpec: params.pluginId,
    },
  };
}

function createPlugin(id: string): ChannelPlugin {
  return { id } as ChannelPlugin;
}

function firstMockArg(mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }): unknown {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("expected mock to have at least one call");
  }
  return call[0];
}

describe("resolveInstallableChannelPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/workspace");
    mocks.getChannelPlugin.mockReturnValue(undefined);
    mocks.getLoadedChannelPlugin.mockReturnValue(undefined);
    mocks.getChannelPluginCatalogEntry.mockReturnValue(undefined);
    mocks.ensureChannelSetupPluginInstalled.mockResolvedValue({
      cfg: {},
      installed: false,
    });
  });

  it("returns a registered plugin before resolving a multi-agent workspace owner", async () => {
    const registeredPlugin = {
      ...createPlugin("telegram"),
      directory: { self: vi.fn() },
    } as ChannelPlugin;
    mocks.getLoadedChannelPlugin.mockReturnValue(registeredPlugin);

    const result = await resolveInstallableChannelPlugin({
      cfg: {
        agents: {
          list: [{ id: "alpha" }, { id: "beta" }],
        },
      },
      runtime: {} as never,
      rawChannel: "telegram",
      allowInstall: true,
      preferRegisteredPlugin: true,
      supports: (plugin) => Boolean(plugin.directory),
    });

    expect(result).toMatchObject({
      channelId: "telegram",
      plugin: registeredPlugin,
      configChanged: false,
      pluginInstalled: false,
      supportsRequestedCapability: true,
    });
    expect(mocks.resolveAgentWorkspaceDir).not.toHaveBeenCalled();
    expect(mocks.getLoadedChannelPlugin).toHaveBeenCalledWith("telegram");
    expect(mocks.getChannelPlugin).not.toHaveBeenCalled();
    expect(mocks.listChannelPluginCatalogEntries).not.toHaveBeenCalled();
    expect(mocks.loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
  });

  it("requires a workspace owner before falling back to an unloaded bundled plugin", async () => {
    mocks.getChannelPlugin.mockReturnValue(createPlugin("telegram"));

    await expect(
      resolveInstallableChannelPlugin({
        cfg: {
          agents: {
            list: [{ id: "alpha" }, { id: "beta" }],
          },
        },
        runtime: {} as never,
        rawChannel: "telegram",
        allowInstall: false,
        preferRegisteredPlugin: true,
      }),
    ).rejects.toThrow(AgentSelectionRequiredError);

    expect(mocks.getLoadedChannelPlugin).toHaveBeenCalledWith("telegram");
    expect(mocks.getChannelPlugin).not.toHaveBeenCalled();
    expect(mocks.resolveAgentWorkspaceDir).not.toHaveBeenCalled();
  });

  it("still requires a workspace owner before resolving an unregistered plugin", async () => {
    await expect(
      resolveInstallableChannelPlugin({
        cfg: {
          agents: {
            list: [{ id: "alpha" }, { id: "beta" }],
          },
        },
        runtime: {} as never,
        rawChannel: "workspace-channel",
        allowInstall: false,
        preferRegisteredPlugin: true,
      }),
    ).rejects.toThrow(AgentSelectionRequiredError);

    expect(mocks.getLoadedChannelPlugin).toHaveBeenCalledWith("workspace-channel");
    expect(mocks.getChannelPlugin).not.toHaveBeenCalled();
    expect(mocks.resolveAgentWorkspaceDir).not.toHaveBeenCalled();
    expect(mocks.listChannelPluginCatalogEntries).not.toHaveBeenCalled();
  });

  it("ignores untrusted workspace channel shadows during setup resolution", async () => {
    const config = {
      agents: { entries: { ops: {}, research: {} } },
      plugins: { enabled: true },
    };
    const workspaceEntry = createCatalogEntry({
      id: "telegram",
      pluginId: "evil-telegram-shadow",
      origin: "workspace",
    });
    const bundledEntry = createCatalogEntry({
      id: "telegram",
      pluginId: "telegram",
      origin: "bundled",
    });
    const bundledPlugin = createPlugin("telegram");

    mocks.listChannelPluginCatalogEntries.mockImplementation(() => [workspaceEntry]);
    mocks.getChannelPluginCatalogEntry.mockImplementation(
      (_channel: string, opts?: { excludePluginRefs?: Array<{ pluginId: string }> }) =>
        opts?.excludePluginRefs?.some((entry) => entry.pluginId === "evil-telegram-shadow")
          ? bundledEntry
          : undefined,
    );
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockImplementation(
      ({ pluginId }: { pluginId?: string }) => ({
        channels: pluginId === "telegram" ? [{ plugin: bundledPlugin }] : [],
        channelSetups: [],
      }),
    );

    const result = await resolveInstallableChannelPlugin({
      cfg: config,
      runtime: {} as never,
      rawChannel: "telegram",
      agentId: "ops",
      allowInstall: false,
    });

    expect(result.catalogEntry?.pluginId).toBe("telegram");
    expect(result.plugin?.id).toBe("telegram");
    expect(mocks.loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(1);
    const snapshotRequest = firstMockArg(
      mocks.loadChannelSetupPluginRegistrySnapshotForChannel,
    ) as { channel?: string; pluginId?: string; workspaceDir?: string };
    expect(snapshotRequest?.channel).toBe("telegram");
    expect(snapshotRequest?.pluginId).toBe("telegram");
    expect(snapshotRequest?.workspaceDir).toBe("/tmp/workspace");
    expect(mocks.resolveAgentWorkspaceDir).toHaveBeenCalledWith(config, "ops");
  });

  it("keeps trusted workspace channel plugins eligible for setup resolution", async () => {
    const workspaceEntry = createCatalogEntry({
      id: "telegram",
      pluginId: "evil-telegram-shadow",
      origin: "workspace",
    });
    const workspacePlugin = createPlugin("telegram");

    mocks.listChannelPluginCatalogEntries.mockReturnValue([workspaceEntry]);
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockImplementation(
      ({ pluginId }: { pluginId?: string }) => ({
        channels: pluginId === "evil-telegram-shadow" ? [{ plugin: workspacePlugin }] : [],
        channelSetups: [],
      }),
    );

    const result = await resolveInstallableChannelPlugin({
      cfg: {
        plugins: {
          enabled: true,
          allow: ["evil-telegram-shadow"],
        },
      },
      runtime: {} as never,
      rawChannel: "telegram",
      allowInstall: false,
    });

    expect(result.catalogEntry?.pluginId).toBe("evil-telegram-shadow");
    expect(result.plugin?.id).toBe("telegram");
    expect(mocks.loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(1);
    const snapshotRequest = firstMockArg(
      mocks.loadChannelSetupPluginRegistrySnapshotForChannel,
    ) as { channel?: string; pluginId?: string; workspaceDir?: string };
    expect(snapshotRequest?.channel).toBe("telegram");
    expect(snapshotRequest?.pluginId).toBe("evil-telegram-shadow");
    expect(snapshotRequest?.workspaceDir).toBe("/tmp/workspace");
  });

  it("initializes a cold bundled plugin through the scoped snapshot before logout", async () => {
    const runtimeStore = createPluginRuntimeStore<{ cleared: boolean; loggedOut: boolean }>(
      "runtime not initialized",
    );
    const plugin: ChannelPlugin = {
      ...createPlugin("telegram"),
      gateway: { logoutAccount: async () => runtimeStore.getRuntime() },
    };
    mocks.getChannelPlugin.mockReturnValue(plugin);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      createCatalogEntry({ id: "telegram", pluginId: "telegram", origin: "bundled" }),
    ]);
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockImplementation(() => {
      runtimeStore.setRuntime({ cleared: true, loggedOut: true });
      return { channels: [{ plugin }], channelSetups: [] };
    });

    const result = await resolveInstallableChannelPlugin({
      cfg: {},
      runtime: {} as never,
      rawChannel: "telegram",
      allowInstall: false,
      supports: (candidate) => Boolean(candidate.gateway?.logoutAccount),
    });

    await expect(
      result.plugin?.gateway?.logoutAccount?.({
        cfg: result.cfg,
        accountId: "default",
        account: {},
        runtime: {} as never,
      }),
    ).resolves.toEqual({ cleared: true, loggedOut: true });
    expect(result.configChanged).toBe(false);
    expect(result.pluginInstalled).toBe(false);
    expect(result.supportsRequestedCapability).toBe(true);
  });

  it("returns an existing plugin that lacks the requested capability without reinstalling", async () => {
    const catalogEntry = createCatalogEntry({
      id: "openclaw-weixin",
      pluginId: "@tencent-weixin/openclaw-weixin",
      origin: "bundled",
    });
    const installedPlugin = createPlugin("openclaw-weixin");

    mocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    mocks.getLoadedChannelPlugin.mockReturnValue(installedPlugin);

    const result = await resolveInstallableChannelPlugin({
      cfg: { plugins: { enabled: true } },
      runtime: {} as never,
      rawChannel: "openclaw-weixin",
      allowInstall: true,
      supports: (plugin) => Boolean(plugin.directory),
    });

    expect(result.plugin).toBe(installedPlugin);
    expect(result.pluginInstalled).toBe(false);
    expect(result.supportsRequestedCapability).toBe(false);
    expect(mocks.ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
  });

  it("returns a scoped installed plugin that lacks the requested capability without reinstalling", async () => {
    const catalogEntry = createCatalogEntry({
      id: "openclaw-weixin",
      pluginId: "@tencent-weixin/openclaw-weixin",
      origin: "bundled",
    });
    const scopedPlugin = createPlugin("openclaw-weixin");

    mocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue({
      channels: [{ plugin: scopedPlugin }],
      channelSetups: [],
    });

    const result = await resolveInstallableChannelPlugin({
      cfg: { plugins: { enabled: true } },
      runtime: {} as never,
      rawChannel: "openclaw-weixin",
      allowInstall: true,
      supports: (plugin) => Boolean(plugin.directory),
    });

    expect(result.plugin).toBe(scopedPlugin);
    expect(result.pluginInstalled).toBe(false);
    expect(result.supportsRequestedCapability).toBe(false);
    expect(mocks.ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
  });

  it("still offers install when only a setup fallback lacks the requested capability", async () => {
    const catalogEntry = createCatalogEntry({
      id: "demo-directory",
      pluginId: "@demo/directory",
      origin: "bundled",
    });
    const setupOnlyPlugin = createPlugin("demo-directory");

    mocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue({
      channels: [],
      channelSetups: [{ plugin: setupOnlyPlugin }],
    });
    mocks.ensureChannelSetupPluginInstalled.mockResolvedValueOnce({
      cfg: { plugins: { entries: { "@demo/directory": { enabled: true } } } },
      installed: true,
      pluginId: "@demo/directory",
      status: "installed",
    });

    const result = await resolveInstallableChannelPlugin({
      cfg: { plugins: { enabled: true } },
      runtime: {} as never,
      rawChannel: "demo-directory",
      allowInstall: true,
      supports: (plugin) => Boolean(plugin.directory),
    });

    expect(mocks.ensureChannelSetupPluginInstalled).toHaveBeenCalledTimes(1);
    const installRequest = firstMockArg(mocks.ensureChannelSetupPluginInstalled) as {
      entry?: ChannelPluginCatalogEntry;
    };
    expect(installRequest?.entry).toBe(catalogEntry);
    expect(result.pluginInstalled).toBe(true);
    expect(mocks.resolveAgentWorkspaceDir).toHaveBeenCalledTimes(1);
    expect(mocks.loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/workspace" }),
    );
  });

  it.each([true, false])(
    "preserves the installation result and workspace when installed=%s",
    async (installed) => {
      const cfg = { plugins: { enabled: true } };
      const entry = createCatalogEntry({ id: "demo", pluginId: "demo", origin: "bundled" });
      const plugin = createPlugin("demo");
      const pluginId = installed ? "installed-demo" : "demo";
      const nextCfg = installed ? { plugins: { allow: [pluginId] } } : cfg;
      mocks.listChannelPluginCatalogEntries.mockReturnValue([entry]);
      mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockImplementation(
        ({ cfg: loadedCfg }) => ({
          channels: installed && loadedCfg === nextCfg ? [{ plugin }] : [],
          channelSetups: [],
        }),
      );
      mocks.ensureChannelSetupPluginInstalled.mockResolvedValueOnce({
        cfg: nextCfg,
        installed,
        pluginId,
        status: installed ? "installed" : "skipped",
      });

      const result = await resolveInstallableChannelPlugin({
        cfg,
        runtime: {} as never,
        rawChannel: "demo",
      });

      expect(result).toEqual({
        cfg: nextCfg,
        channelId: "demo",
        plugin: installed ? plugin : undefined,
        catalogEntry: { ...entry, pluginId },
        configChanged: installed,
        pluginInstalled: installed,
        supportsRequestedCapability: installed ? true : undefined,
      });
      expect(mocks.resolveAgentWorkspaceDir).toHaveBeenCalledTimes(1);
      expect(mocks.ensureChannelSetupPluginInstalled).toHaveBeenCalledWith(
        expect.objectContaining({ cfg, entry, workspaceDir: "/tmp/workspace" }),
      );
      expect(mocks.loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(
        installed ? 2 : 1,
      );
      if (installed) {
        expect(mocks.loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenLastCalledWith(
          expect.objectContaining({ cfg: nextCfg, pluginId, workspaceDir: "/tmp/workspace" }),
        );
      }
    },
  );
});
