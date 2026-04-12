import { vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelsConfig } from "../config/types.channels.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";

export function createMockChannelSetupPluginInstallModule(
  actual?: Partial<typeof import("./channel-setup/plugin-install.js")>,
) {
  return {
    ...actual,
    ensureChannelSetupPluginInstalled: vi.fn(async ({ cfg }) => ({ cfg, installed: true })),
    loadChannelSetupPluginRegistrySnapshotForChannel: vi.fn(() => createTestRegistry()),
  };
}

export function createMSTeamsCatalogEntry(): ChannelPluginCatalogEntry {
  return {
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
}

export function createMSTeamsSetupPlugin(): ChannelPlugin {
  return {
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
  } as ChannelPlugin;
}

export function createMSTeamsDeletePlugin(): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: "msteams",
      label: "Microsoft Teams",
      docsPath: "/channels/msteams",
    }),
    config: {
      ...createChannelTestPluginBase({
        id: "msteams",
        label: "Microsoft Teams",
        docsPath: "/channels/msteams",
      }).config,
      deleteAccount: vi.fn(({ cfg }: { cfg: Record<string, unknown> }) => {
        const channels = (cfg.channels as Record<string, unknown> | undefined) ?? {};
        const nextChannels = { ...channels };
        delete nextChannels.msteams;
        return {
          ...cfg,
          channels: nextChannels as ChannelsConfig,
        };
      }),
    },
  };
}
