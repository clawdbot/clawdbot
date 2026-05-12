import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";

const mocks = vi.hoisted(() => ({
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveDefaultAgentId: vi.fn(() => "default"),
  listChannelPluginCatalogEntries: vi.fn(),
  getChannelPluginCatalogEntry: vi.fn(),
  getChannelPlugin: vi.fn(),
  loadChannelSetupPluginRegistrySnapshotForChannel: vi.fn(),
  ensureChannelSetupPluginInstalled: vi.fn(),
  createClackPrompter: vi.fn(() => ({}) as never),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));

vi.mock("../../channels/plugins/catalog.js", () => ({
  listChannelPluginCatalogEntries: mocks.listChannelPluginCatalogEntries,
  getChannelPluginCatalogEntry: mocks.getChannelPluginCatalogEntry,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
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

describe("resolveInstallableChannelPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getChannelPlugin.mockReturnValue(undefined);
    mocks.ensureChannelSetupPluginInstalled.mockResolvedValue({
      cfg: {},
      installed: false,
    });
  });

  it("ignores untrusted workspace channel shadows during setup resolution", async () => {
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

    mocks.listChannelPluginCatalogEntries.mockImplementation(
      ({ excludeWorkspace }: { excludeWorkspace?: boolean }) =>
        excludeWorkspace ? [bundledEntry] : [workspaceEntry],
    );
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockImplementation(
      ({ pluginId }: { pluginId?: string }) => ({
        channels: pluginId === "telegram" ? [{ plugin: bundledPlugin }] : [],
        channelSetups: [],
      }),
    );

    const result = await resolveInstallableChannelPlugin({
      cfg: { plugins: { enabled: true } },
      runtime: {} as never,
      rawChannel: "telegram",
      allowInstall: false,
    });

    expect(result.catalogEntry?.pluginId).toBe("telegram");
    expect(result.plugin?.id).toBe("telegram");
    expect(mocks.loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(1);
    const snapshotRequest =
      mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mock.calls.at(0)?.[0];
    expect(snapshotRequest?.channel).toBe("telegram");
    expect(snapshotRequest?.pluginId).toBe("telegram");
    expect(snapshotRequest?.workspaceDir).toBe("/tmp/workspace");
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
    const snapshotRequest =
      mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mock.calls.at(0)?.[0];
    expect(snapshotRequest?.channel).toBe("telegram");
    expect(snapshotRequest?.pluginId).toBe("evil-telegram-shadow");
    expect(snapshotRequest?.workspaceDir).toBe("/tmp/workspace");
  });

  it("returns an existing plugin that lacks the requested capability without reinstalling", async () => {
    const catalogEntry = createCatalogEntry({
      id: "openclaw-weixin",
      pluginId: "@tencent-weixin/openclaw-weixin",
      origin: "bundled",
    });
    const installedPlugin = createPlugin("openclaw-weixin");

    mocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    mocks.getChannelPlugin.mockReturnValue(installedPlugin);

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
    const installRequest = mocks.ensureChannelSetupPluginInstalled.mock.calls.at(0)?.[0];
    expect(installRequest?.entry).toBe(catalogEntry);
    expect(result.pluginInstalled).toBe(true);
  });
});
