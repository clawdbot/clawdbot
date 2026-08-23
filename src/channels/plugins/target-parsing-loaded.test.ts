import { beforeEach, describe, expect, it, vi } from "vitest";

const getLoadedChannelPluginForRead = vi.hoisted(() => vi.fn());
const getChannelPlugin = vi.hoisted(() => vi.fn());

vi.mock("./index.js", () => ({
  getChannelPlugin,
  normalizeChannelId: (raw?: string | null) => raw?.trim().toLowerCase() || null,
}));

vi.mock("./registry-loaded.js", () => ({
  getLoadedChannelPluginForRead,
}));

import { resolveExplicitDeliveryTargetCompat } from "./target-parsing-loaded.js";

describe("resolveExplicitDeliveryTargetCompat", () => {
  beforeEach(() => {
    getLoadedChannelPluginForRead.mockReset();
    getChannelPlugin.mockReset();
  });

  it("keeps unloaded channels on generic parsing without activating a plugin", () => {
    getLoadedChannelPluginForRead.mockReturnValue(undefined);

    expect(
      resolveExplicitDeliveryTargetCompat({
        channel: " LegacyChat ",
        rawTarget: " room-a ",
        fallbackThreadId: "77",
      }),
    ).toEqual({
      channel: "legacychat",
      rawTo: "room-a",
      to: "room-a",
      threadId: "77",
      chatType: undefined,
    });
    expect(getLoadedChannelPluginForRead).toHaveBeenCalledWith("legacychat");
    expect(getChannelPlugin).not.toHaveBeenCalled();
  });

  it("preserves the deprecated parser contract for an already-loaded plugin", () => {
    const parseExplicitTarget = vi.fn(() => ({
      to: "room-a",
      threadId: 42,
      chatType: "group" as const,
    }));
    getLoadedChannelPluginForRead.mockReturnValue({
      messaging: { parseExplicitTarget },
    });

    expect(
      resolveExplicitDeliveryTargetCompat({
        channel: "legacychat",
        rawTarget: "room-a:topic:42",
      }),
    ).toEqual({
      channel: "legacychat",
      rawTo: "room-a:topic:42",
      to: "room-a",
      threadId: 42,
      chatType: "group",
    });
    expect(parseExplicitTarget).toHaveBeenCalledWith({ raw: "room-a:topic:42" });
    expect(getChannelPlugin).not.toHaveBeenCalled();
  });
});
