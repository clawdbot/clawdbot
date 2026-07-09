// Channel plugin catalog tests cover plugin catalog entries and metadata normalization.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginChannelCatalogEntry } from "../../plugins/channel-catalog-registry.js";

const listChannelCatalogEntriesMock = vi.hoisted(() =>
  vi.fn<() => PluginChannelCatalogEntry[]>(() => []),
);

vi.mock("../../plugins/channel-catalog-registry.js", () => ({
  listChannelCatalogEntries: listChannelCatalogEntriesMock,
}));

import { getChannelPluginCatalogEntry } from "./catalog.js";

beforeEach(() => {
  listChannelCatalogEntriesMock.mockReset().mockReturnValue([]);
});

describe("channel plugin catalog", () => {
  it("keeps third-party channel ids mapped with catalog install trust", () => {
    const options = {
      workspaceDir: "/tmp/openclaw-channel-catalog-empty-workspace",
      env: {},
    };

    const wecom = getChannelPluginCatalogEntry("wecom", options);
    expect(wecom?.id).toBe("wecom");
    expect(wecom?.pluginId).toBe("wecom-openclaw-plugin");
    expect(wecom?.trustedSourceLinkedOfficialInstall).toBe(true);
    expect(wecom?.install?.npmSpec).toBe("@wecom/wecom-openclaw-plugin@2026.7.2");

    const yuanbao = getChannelPluginCatalogEntry("yuanbao", options);
    expect(yuanbao?.id).toBe("yuanbao");
    expect(yuanbao?.pluginId).toBe("openclaw-plugin-yuanbao");
    expect(yuanbao?.trustedSourceLinkedOfficialInstall).toBe(true);
    expect(yuanbao?.install?.npmSpec).toBe("openclaw-plugin-yuanbao@2.15.0");
  });

  it("excludes only the rejected origin/plugin pair when resolving fallback copies", () => {
    listChannelCatalogEntriesMock.mockReturnValue([
      {
        pluginId: "telegram",
        origin: "config",
        rootDir: "/tmp/config-telegram",
        packageName: "telegram-shadow",
        channel: {
          id: "telegram",
          label: "Telegram Shadow",
          selectionLabel: "Telegram Shadow",
          docsPath: "/channels/telegram",
          blurb: "shadow",
        },
        install: { localPath: "/tmp/config-telegram" },
      },
      {
        pluginId: "telegram",
        origin: "bundled",
        rootDir: "/tmp/bundled-telegram",
        packageName: "@openclaw/telegram",
        channel: {
          id: "telegram",
          label: "Telegram",
          selectionLabel: "Telegram",
          docsPath: "/channels/telegram",
          blurb: "bundled",
        },
        install: { npmSpec: "@openclaw/telegram@1.0.0" },
      },
    ] satisfies PluginChannelCatalogEntry[]);

    expect(
      getChannelPluginCatalogEntry("telegram", {
        excludePluginRefs: [{ pluginId: "telegram", origin: "config" }],
      })?.origin,
    ).toBe("bundled");
  });
});
