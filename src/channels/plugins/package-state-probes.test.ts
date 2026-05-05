import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginChannelCatalogEntry } from "../../plugins/channel-catalog-registry.js";
import {
  hasBundledChannelPackageState,
  listBundledChannelIdsForPackageState,
} from "./package-state-probes.js";

const listChannelCatalogEntriesMock = vi.hoisted(() => vi.fn());

vi.mock("../../plugins/channel-catalog-registry.js", () => ({
  listChannelCatalogEntries: listChannelCatalogEntriesMock,
}));

function makeBundledChannelCatalogEntry(params: {
  pluginId: string;
  channelId: string;
}): PluginChannelCatalogEntry {
  return {
    pluginId: params.pluginId,
    origin: "bundled",
    rootDir: "/tmp/openclaw-channel-plugin",
    channel: {
      id: params.channelId,
      configuredState: {
        env: {
          allOf: ["ALIAS_CHAT_TOKEN"],
        },
      },
    },
  };
}

beforeEach(() => {
  listChannelCatalogEntriesMock.mockReset();
});

describe("channel package-state probes", () => {
  it("uses channel ids when manifest plugin ids differ", () => {
    listChannelCatalogEntriesMock.mockReturnValue([
      makeBundledChannelCatalogEntry({
        pluginId: "vendor-alias-chat-plugin",
        channelId: "alias-chat",
      }),
    ]);

    expect(listBundledChannelIdsForPackageState("configuredState")).toEqual(["alias-chat"]);
    expect(
      hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: "alias-chat",
        cfg: {},
        env: { ALIAS_CHAT_TOKEN: "token" },
      }),
    ).toBe(true);
    expect(
      hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: "vendor-alias-chat-plugin",
        cfg: {},
        env: { ALIAS_CHAT_TOKEN: "token" },
      }),
    ).toBe(false);
  });
});
