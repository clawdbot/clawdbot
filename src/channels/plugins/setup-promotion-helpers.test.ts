import { beforeEach, describe, expect, it, vi } from "vitest";

const getBundledChannelPluginMock = vi.hoisted(() => vi.fn());
const hasBundledChannelPackageSetupFeatureMock = vi.hoisted(() => vi.fn());
const getLoadedChannelPluginMock = vi.hoisted(() => vi.fn());

vi.mock("./bundled.js", () => ({
  getBundledChannelPlugin: getBundledChannelPluginMock,
  hasBundledChannelPackageSetupFeature: hasBundledChannelPackageSetupFeatureMock,
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
    hasBundledChannelPackageSetupFeatureMock.mockReset();
    hasBundledChannelPackageSetupFeatureMock.mockReturnValue(false);
    getLoadedChannelPluginMock.mockReset();
  });

  it("keeps static single-account migration keys cheap", () => {
    const keys = resolveSingleAccountKeysToMove({
      channelKey: "demo",
      channel: {
        defaultAccount: "ops",
        dmPolicy: "allowlist",
        allowFrom: ["+15551234567"],
        groupPolicy: "allowlist",
        groupAllowFrom: ["group-123"],
      },
    });

    expect(keys).toEqual(["dmPolicy", "allowFrom", "groupPolicy", "groupAllowFrom"]);
    expect(getLoadedChannelPluginMock).not.toHaveBeenCalled();
    expect(getBundledChannelPluginMock).not.toHaveBeenCalled();
  });

  it("skips bundled setup promotion without a manifest feature", () => {
    const keys = resolveSingleAccountKeysToMove({
      channelKey: "demo",
      channel: {
        accounts: {
          work: { enabled: true },
        },
        dmPolicy: "allowlist",
        allowFrom: ["+15551234567"],
        groupPolicy: "allowlist",
        groupAllowFrom: ["group-123"],
      },
    });

    expect(keys).toEqual(["dmPolicy", "allowFrom", "groupPolicy", "groupAllowFrom"]);
    expect(getLoadedChannelPluginMock).toHaveBeenCalledWith("demo");
    expect(hasBundledChannelPackageSetupFeatureMock).toHaveBeenCalledWith(
      "demo",
      "configPromotion",
    );
    expect(getBundledChannelPluginMock).not.toHaveBeenCalled();
  });

  it("loads bundled setup only for non-static migration keys", () => {
    hasBundledChannelPackageSetupFeatureMock.mockReturnValue(true);
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

  it("loads bundled setup for named-account filters before registry bootstrap", () => {
    hasBundledChannelPackageSetupFeatureMock.mockReturnValue(true);
    getBundledChannelPluginMock.mockReturnValue({
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
    expect(getLoadedChannelPluginMock).toHaveBeenCalledWith("demo");
    expect(getBundledChannelPluginMock).toHaveBeenCalledWith("demo");
  });
});
