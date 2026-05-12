import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginAutoEnableResult } from "../../config/plugin-auto-enable.js";

const loadPluginRegistrySnapshot = vi.hoisted(() => vi.fn());
const listPluginContributionIds = vi.hoisted(() =>
  vi.fn((_index?: unknown, _contribution?: unknown, _options?: unknown): string[] => []),
);
const listChannelPluginCatalogEntries = vi.hoisted(() => vi.fn((): unknown[] => []));
const listChatChannels = vi.hoisted(() => vi.fn((): Array<Record<string, string>> => []));
const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn<(args: { config: unknown; env?: NodeJS.ProcessEnv }) => PluginAutoEnableResult>(
    ({ config }) => ({
      config: config as never,
      changes: [] as string[],
      autoEnabledReasons: {},
    }),
  ),
);

vi.mock("../../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => ({ diagnostics: [], plugins: [] }),
  loadPluginRegistrySnapshot: (...args: unknown[]) => loadPluginRegistrySnapshot(...args),
  listPluginContributionIds: (args: unknown) => listPluginContributionIds(args),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (args: unknown) =>
    applyPluginAutoEnable(args as { config: unknown; env?: NodeJS.ProcessEnv }),
}));

vi.mock("../../channels/plugins/catalog.js", () => ({
  listChannelPluginCatalogEntries: (_args?: unknown) => listChannelPluginCatalogEntries(),
}));

vi.mock("../../channels/chat-meta.js", () => ({
  listChatChannels: () => listChatChannels(),
}));

import { listManifestInstalledChannelIds, resolveChannelSetupEntries } from "./discovery.js";

describe("listManifestInstalledChannelIds", () => {
  beforeEach(() => {
    loadPluginRegistrySnapshot.mockReset().mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    listPluginContributionIds.mockReset().mockReturnValue([]);
    listChannelPluginCatalogEntries.mockReset().mockReturnValue([]);
    listChatChannels.mockReset().mockReturnValue([]);
    applyPluginAutoEnable.mockReset().mockImplementation(({ config }) => ({
      config: config as never,
      changes: [] as string[],
      autoEnabledReasons: {},
    }));
  });

  it("uses the auto-enabled config snapshot for manifest discovery", () => {
    const autoEnabledConfig = {
      channels: { slack: { enabled: true } },
      plugins: { allow: ["slack"] },
      autoEnabled: true,
    } as never;
    applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: ["slack"] as string[],
      autoEnabledReasons: {
        slack: ["slack configured"],
      },
    });
    loadPluginRegistrySnapshot.mockReturnValue({
      plugins: [{ pluginId: "slack" }],
      diagnostics: [],
    });
    listPluginContributionIds.mockReturnValue(["slack"]);

    const installedIds = listManifestInstalledChannelIds({
      cfg: {} as never,
      workspaceDir: "/tmp/workspace",
      env: { OPENCLAW_HOME: "/tmp/home" } as NodeJS.ProcessEnv,
    });

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
      env: { OPENCLAW_HOME: "/tmp/home" },
    });
    expect(loadPluginRegistrySnapshot).toHaveBeenCalledWith({
      config: autoEnabledConfig,
      workspaceDir: "/tmp/workspace",
      env: { OPENCLAW_HOME: "/tmp/home" },
    });
    expect(listPluginContributionIds).toHaveBeenCalledWith({
      index: {
        plugins: [{ pluginId: "slack" }],
        diagnostics: [],
      },
      contribution: "channels",
      config: autoEnabledConfig,
      workspaceDir: "/tmp/workspace",
      env: { OPENCLAW_HOME: "/tmp/home" },
    });
    expect(installedIds).toEqual(new Set(["slack"]));
  });

  it("filters channels hidden from setup out of interactive entries", () => {
    listChatChannels.mockReturnValue([
      {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/channels/telegram",
        blurb: "bot token",
      },
    ]);

    const resolved = resolveChannelSetupEntries({
      cfg: {} as never,
      installedPlugins: [
        {
          id: "qa-channel",
          meta: {
            id: "qa-channel",
            label: "QA Channel",
            selectionLabel: "QA Channel",
            docsPath: "/channels/qa-channel",
            blurb: "synthetic",
            exposure: { setup: false },
          },
        } as never,
      ],
      workspaceDir: "/tmp/workspace",
      env: { OPENCLAW_HOME: "/tmp/home" } as NodeJS.ProcessEnv,
    });

    expect(resolved.entries.map((entry) => entry.id)).toEqual(["telegram"]);
  });

  it("preserves bundled channel display metadata when installed setup plugins omit it", () => {
    listChatChannels.mockReturnValue([
      {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/channels/telegram",
        blurb: "bot token",
      },
    ]);

    const resolved = resolveChannelSetupEntries({
      cfg: {} as never,
      installedPlugins: [
        {
          id: "telegram",
          meta: {
            id: "telegram",
          },
        } as never,
      ],
      workspaceDir: "/tmp/workspace",
      env: { OPENCLAW_HOME: "/tmp/home" } as NodeJS.ProcessEnv,
    });

    expect(resolved).toStrictEqual({
      entries: [
        {
          id: "telegram",
          meta: {
            id: "telegram",
            label: "Telegram",
            selectionLabel: "Telegram",
            blurb: "bot token",
            docsPath: "/channels/telegram",
          },
        },
      ],
      installedCatalogEntries: [],
      installableCatalogEntries: [],
      installedCatalogById: new Map(),
      installableCatalogById: new Map(),
    });
  });
});
