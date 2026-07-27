// Channel plugin catalog tests cover plugin catalog entries and metadata normalization.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginChannelCatalogEntry } from "../../plugins/channel-catalog-registry.js";

const listChannelCatalogEntriesMock = vi.hoisted(() =>
  vi.fn<() => PluginChannelCatalogEntry[]>(() => []),
);

vi.mock("../../plugins/channel-catalog-registry.js", () => ({
  listChannelCatalogEntries: listChannelCatalogEntriesMock,
}));

import {
  getChannelPluginCatalogEntry,
  resolveOfficialChannelPluginCatalogEntry,
} from "./catalog.js";

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
    expect(wecom?.install?.npmSpec).toBe("@wecom/wecom-openclaw-plugin@2026.5.7");

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

  it("resolves installed official channels back to verified official metadata", () => {
    const options = {
      workspaceDir: "/tmp/openclaw-channel-catalog-empty-workspace",
      env: {},
    };
    const official = getChannelPluginCatalogEntry("wecom", options);
    if (!official) {
      throw new Error("expected official WeCom catalog entry");
    }
    const { trustedSourceLinkedOfficialInstall: _trusted, ...installed } = official;

    expect(
      resolveOfficialChannelPluginCatalogEntry({
        ...installed,
        origin: "global",
        trustedSourceLinkedOfficialInstall: true,
        meta: {
          ...installed.meta,
          docsPath: "/unverified-installed-plugin-docs",
        },
      })?.meta.docsPath,
    ).toBe(official.meta.docsPath);
  });

  it("resolves trusted config-origin official channels back to verified official metadata", () => {
    const options = {
      workspaceDir: "/tmp/openclaw-channel-catalog-empty-workspace",
      env: {},
    };
    const official = getChannelPluginCatalogEntry("wecom", options);
    if (!official) {
      throw new Error("expected official WeCom catalog entry");
    }
    const { trustedSourceLinkedOfficialInstall: _trusted, ...installed } = official;

    expect(
      resolveOfficialChannelPluginCatalogEntry({
        ...installed,
        origin: "config",
        trustedSourceLinkedOfficialInstall: true,
        meta: {
          ...installed.meta,
          docsPath: "/unverified-config-plugin-docs",
        },
      })?.meta.docsPath,
    ).toBe(official.meta.docsPath);
  });

  it("resolves installed official channels whose catalog omits a plugin id", () => {
    const options = {
      workspaceDir: "/tmp/openclaw-channel-catalog-empty-workspace",
      env: {},
    };
    const official = getChannelPluginCatalogEntry("slack", options);
    if (!official) {
      throw new Error("expected official Slack catalog entry");
    }
    const { trustedSourceLinkedOfficialInstall: _trusted, ...installed } = official;

    expect(
      resolveOfficialChannelPluginCatalogEntry({
        ...installed,
        pluginId: "slack",
        origin: "global",
        trustedSourceLinkedOfficialInstall: true,
      })?.meta.docsPath,
    ).toBe("/channels/slack");
  });

  it("does not resolve a third-party package shadow to official channel metadata", () => {
    const options = {
      workspaceDir: "/tmp/openclaw-channel-catalog-empty-workspace",
      env: {},
    };
    const official = getChannelPluginCatalogEntry("wecom", options);
    if (!official) {
      throw new Error("expected official WeCom catalog entry");
    }
    const { trustedSourceLinkedOfficialInstall: _trusted, ...installed } = official;

    expect(
      resolveOfficialChannelPluginCatalogEntry({
        ...installed,
        origin: "global",
        installSource: {
          npm: {
            spec: official.installSource?.npm?.spec ?? "@wecom/wecom-openclaw-plugin",
            packageName: official.installSource?.npm?.packageName ?? "@wecom/wecom-openclaw-plugin",
            expectedPackageName: "@attacker/wecom",
            selectorKind: "none",
            exactVersion: false,
            pinState: "floating-without-integrity",
          },
          warnings: [],
        },
      }),
    ).toBeUndefined();
  });

  it("does not trust an untracked global plugin that claims official identity", () => {
    const official = getChannelPluginCatalogEntry("slack", {
      workspaceDir: "/tmp/openclaw-channel-catalog-empty-workspace",
      env: {},
    });
    if (!official) {
      throw new Error("expected official Slack catalog entry");
    }

    expect(
      resolveOfficialChannelPluginCatalogEntry({
        ...official,
        origin: "global",
        trustedSourceLinkedOfficialInstall: undefined,
      }),
    ).toBeUndefined();
  });
});
