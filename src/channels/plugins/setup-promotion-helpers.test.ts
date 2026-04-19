import { beforeEach, describe, expect, it, vi } from "vitest";

const getBundledChannelPluginMock = vi.hoisted(() => vi.fn());
const getLoadedChannelPluginMock = vi.hoisted(() => vi.fn());

vi.mock("./bundled.js", () => ({
  getBundledChannelPlugin: getBundledChannelPluginMock,
}));

vi.mock("./registry.js", () => ({
  getLoadedChannelPlugin: getLoadedChannelPluginMock,
}));

import {
  resolveSingleAccountKeysToMove,
  shouldMoveSingleAccountChannelKey,
} from "./setup-promotion-helpers.js";

describe("setup promotion helpers", () => {
  beforeEach(() => {
    getBundledChannelPluginMock.mockReset();
    getLoadedChannelPluginMock.mockReset();
  });

  it("keeps static named-account migration keys cheap", () => {
    const keys = resolveSingleAccountKeysToMove({
      channelKey: "whatsapp",
      channel: {
        accounts: {
          work: { enabled: true },
        },
        dmPolicy: "allowlist",
        allowFrom: ["+15551234567"],
        groupPolicy: "allowlist",
        groupAllowFrom: ["120363000000000000@g.us"],
      },
    });

    expect(keys).toEqual(["dmPolicy", "allowFrom", "groupPolicy", "groupAllowFrom"]);
    expect(getLoadedChannelPluginMock).toHaveBeenCalledTimes(1);
    expect(getLoadedChannelPluginMock).toHaveBeenCalledWith("whatsapp");
    expect(getBundledChannelPluginMock).not.toHaveBeenCalled();
  });

  it("loads bundled setup only for non-static migration keys", () => {
    getBundledChannelPluginMock.mockReturnValue({
      setup: {
        singleAccountKeysToMove: ["customAuth"],
      },
    });

    expect(
      shouldMoveSingleAccountChannelKey({
        channelKey: "demo",
        key: "customAuth",
      }),
    ).toBe(true);
    expect(getBundledChannelPluginMock).toHaveBeenCalledWith("demo");
  });

  it("honors loaded plugin named-account filters without bundled fallback", () => {
    getLoadedChannelPluginMock.mockReturnValue({
      setup: {
        namedAccountPromotionKeys: ["token"],
      },
    });

    const keys = resolveSingleAccountKeysToMove({
      channelKey: "demo",
      channel: {
        accounts: {
          work: { enabled: true },
        },
        token: "secret",
        dmPolicy: "allowlist",
      },
    });

    expect(keys).toEqual(["token"]);
    expect(getBundledChannelPluginMock).not.toHaveBeenCalled();
  });
});
