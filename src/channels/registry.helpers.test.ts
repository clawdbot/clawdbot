// Registry helper tests cover channel registry fixtures and lookup helpers.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getActivePluginChannelRegistryVersion,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { listChatChannels } from "./chat-meta.js";
import { normalizeAnyChannelId as normalizeAnyChannelIdLight } from "./registry-normalize.js";
import { formatChannelSelectionLine, normalizeAnyChannelId } from "./registry.js";

describe("channel registry helpers", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  function channelIds(): string[] {
    const ids: string[] = [];
    for (const channel of listChatChannels()) {
      ids.push(channel.id);
    }
    return ids;
  }

  function formatTestLink(path?: string, label?: string): string {
    if (label && path) {
      return `${label}:${path}`;
    }
    return label ?? path ?? "";
  }

  function createRegistryWithRegisteredChannel(id: string, aliases: string[] = []) {
    return createTestRegistry([
      {
        pluginId: id,
        plugin: { id, meta: { aliases } },
        source: "test",
      },
    ]);
  }

  it("keeps Feishu first in the current default order", () => {
    const channels = listChatChannels();
    expect(channels[0]?.id).toBe("feishu");
  });

  it("includes MS Teams in the bundled channel list", () => {
    expect(channelIds()).toContain("msteams");
  });

  it("formats Telegram selection lines without a docs prefix and with website extras", () => {
    const telegram = listChatChannels().find((channel) => channel.id === "telegram");
    if (!telegram) {
      throw new Error("Missing Telegram channel metadata.");
    }
    const line = formatChannelSelectionLine(telegram, formatTestLink);
    expect(line).not.toContain("Docs:");
    expect(line).toContain("/channels/telegram");
    expect(line).toContain("https://openclaw.ai");
  });

  it("prefers an exact channel id over an earlier plugin alias", () => {
    const aliasOwner = createRegistryWithRegisteredChannel("alias-owner", ["exact-id"]).channels[0];
    const exactOwner = createRegistryWithRegisteredChannel("exact-id").channels[0];
    setActivePluginRegistry(
      createTestRegistry([
        expectDefined(aliasOwner, "alias owner test channel"),
        expectDefined(exactOwner, "exact owner test channel"),
      ]),
    );

    expect(normalizeAnyChannelId("exact-id")).toBe("exact-id");
    expect(normalizeAnyChannelIdLight("exact-id")).toBe("exact-id");
  });

  it("rebuilds registered channel lookups when the active registry changes", () => {
    const alphaRegistry = createRegistryWithRegisteredChannel("alpha", ["a"]);
    setActivePluginRegistry(alphaRegistry);

    const channelVersion = getActivePluginChannelRegistryVersion();
    expect(normalizeAnyChannelId("a")).toBe("alpha");
    expect(normalizeAnyChannelIdLight("a")).toBe("alpha");

    const betaRegistry = createRegistryWithRegisteredChannel("beta", ["b"]);
    setActivePluginRegistry(betaRegistry);

    expect(getActivePluginChannelRegistryVersion()).not.toBe(channelVersion);
    expect(normalizeAnyChannelId("a")).toBeNull();
    expect(normalizeAnyChannelId("b")).toBe("beta");
    expect(normalizeAnyChannelIdLight("a")).toBeNull();
    expect(normalizeAnyChannelIdLight("b")).toBe("beta");
  });

  it("refreshes registered channel lookups when selected registry channels grow in place", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);

    expect(normalizeAnyChannelId("a")).toBeNull();
    expect(normalizeAnyChannelIdLight("a")).toBeNull();

    registry.channels.push(
      expectDefined(
        createRegistryWithRegisteredChannel("alpha", ["a"]).channels[0],
        'createRegistryWithRegisteredChannel("alpha", ["a"]).channels[0] test invariant',
      ),
    );

    expect(normalizeAnyChannelId("a")).toBe("alpha");
    expect(normalizeAnyChannelIdLight("a")).toBe("alpha");
  });
});
