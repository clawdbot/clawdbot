// Setup promotion helper tests cover setup-result promotion into configured channel state.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getLoadedChannelPluginMock = vi.hoisted(() => vi.fn());
const resolveBundledSurfaceMock = vi.hoisted(() => vi.fn());

vi.mock("./registry-loaded.js", () => ({
  getLoadedChannelPluginForRead: getLoadedChannelPluginMock,
}));

import { resolveSingleAccountPromotion } from "./setup-promotion-helpers.js";

function resolveSingleAccountKeysToMove(
  params: Parameters<typeof resolveSingleAccountPromotion>[0],
): string[] {
  const promotion = resolveSingleAccountPromotion(params);
  expect(promotion.kind).toBe("promote");
  if (promotion.kind !== "promote") {
    throw new Error("Expected ordinary account promotion");
  }
  return promotion.keysToMove;
}

const legacyCommonKeys = [
  "accessToken",
  "appToken",
  "httpUrl",
  "password",
  "userId",
  "webhookSecret",
] as const;
const legacySetupOnlyKeys = ["rooms"] as const;

function valuesFor(keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, `value:${key}`]));
}

describe("setup promotion helpers", () => {
  beforeEach(() => {
    getLoadedChannelPluginMock.mockReset();
    resolveBundledSurfaceMock.mockReset();
  });

  it("resolves generic migration keys without importing plugin runtime", () => {
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
    expect(getLoadedChannelPluginMock).toHaveBeenCalledWith("demo");
    expect(resolveBundledSurfaceMock).not.toHaveBeenCalled();
  });

  describe.each(["caller", "loaded", "discovered"])(
    "explicit preserve-root from the %s surface",
    (source) => {
      it.each([
        { name: "Root", groupPolicy: "allowlist", accounts: { ada: {} } },
        { enabled: true },
        { enabled: true, accounts: {} },
      ])("preserves the owned root including an empty promotion key set: %j", (channel) => {
        const surface = { configPromotion: "preserve-root" as const };
        if (source === "loaded") {
          getLoadedChannelPluginMock.mockReturnValue({ setupContract: surface });
        }
        resolveBundledSurfaceMock.mockReturnValue(surface);
        expect(
          resolveSingleAccountPromotion({
            channelKey: "demo",
            channel,
            ...(source === "caller" ? { setupSurface: surface } : {}),
            resolveBundledSurface: resolveBundledSurfaceMock,
          }),
        ).toEqual({ kind: "preserve-root" });
        if (source !== "discovered") {
          expect(resolveBundledSurfaceMock).not.toHaveBeenCalled();
        }
      });
    },
  );

  it("retains the published-reader common tier when no declarations resolve", () => {
    expect(
      resolveSingleAccountKeysToMove({
        channelKey: "demo",
        channel: {
          ...valuesFor(legacyCommonKeys),
          ...valuesFor(legacySetupOnlyKeys),
        },
      }),
    ).toEqual(legacyCommonKeys);
  });

  it("adds the published-reader setup-only tier on direct setup paths", () => {
    expect(
      resolveSingleAccountKeysToMove({
        channelKey: "demo",
        channel: {
          ...valuesFor(legacyCommonKeys),
          ...valuesFor(legacySetupOnlyKeys),
        },
        includeSetupKeys: true,
      }),
    ).toEqual([...legacyCommonKeys, ...legacySetupOnlyKeys]);
  });

  it("keeps WeCom botId and secret in the generic tier", () => {
    const keys = resolveSingleAccountKeysToMove({
      channelKey: "demo",
      channel: {
        tokenFile: "/tmp/token",
        botId: "legacy-wecom-bot",
        secret: "legacy-wecom-secret",
      },
    });

    expect(keys).toEqual(["tokenFile", "botId", "secret"]);
  });

  it("applies the legacy tier to a resolved but undeclared adapter", () => {
    const keys = resolveSingleAccountKeysToMove({
      channelKey: "community",
      channel: {
        dmPolicy: "allowlist",
        appToken: "legacy-app-token",
        accessToken: "legacy-access-token",
        rooms: { lobby: {} },
      },
      setupSurface: {},
      includeSetupKeys: true,
    });

    expect(keys).toEqual(["dmPolicy", "appToken", "accessToken", "rooms"]);
  });

  it("treats a declared empty list as authoritative", () => {
    const keys = resolveSingleAccountKeysToMove({
      channelKey: "community",
      channel: {
        dmPolicy: "allowlist",
        streaming: { mode: "partial" },
        appToken: "legacy-app-token",
        rooms: { lobby: {} },
      },
      setupSurface: { singleAccountKeysToMove: [] },
      includeSetupKeys: true,
    });

    expect(keys).toEqual(["dmPolicy", "streaming"]);
  });

  it("prefers a caller-supplied setup surface over registry and bundled lookup", () => {
    getLoadedChannelPluginMock.mockReturnValue({
      setup: { singleAccountKeysToMove: ["loadedKey"] },
    });
    resolveBundledSurfaceMock.mockReturnValue({ singleAccountKeysToMove: ["bundledKey"] });

    const keys = resolveSingleAccountKeysToMove({
      channelKey: "scoped",
      channel: {
        callerKey: true,
        loadedKey: true,
        bundledKey: true,
      },
      setupSurface: { singleAccountKeysToMove: ["callerKey"] },
      resolveBundledSurface: resolveBundledSurfaceMock,
    });

    expect(keys).toEqual(["callerKey"]);
    expect(getLoadedChannelPluginMock).not.toHaveBeenCalled();
    expect(resolveBundledSurfaceMock).not.toHaveBeenCalled();
  });

  it("prefers loaded channel-owned promotion declarations over legacy setup", () => {
    getLoadedChannelPluginMock.mockReturnValue({
      setupContract: { singleAccountKeysToMove: ["signalNumber"] },
      setup: { singleAccountKeysToMove: ["legacyKey"] },
    });

    expect(
      resolveSingleAccountKeysToMove({
        channelKey: "signal",
        channel: { signalNumber: "+15551234567", legacyKey: true },
      }),
    ).toEqual(["signalNumber"]);
  });

  it("unions the setup generic tier with plugin-declared keys", () => {
    const keys = resolveSingleAccountKeysToMove({
      channelKey: "demo",
      channel: {
        streaming: { mode: "partial" },
        appToken: "xapp-test",
        unrelated: true,
      },
      setupSurface: { singleAccountKeysToMove: ["appToken"] },
      includeSetupKeys: true,
    });

    expect(keys).toEqual(["streaming", "appToken"]);
  });

  it("does not apply legacy keys to a declared in-repo surface", () => {
    const keys = resolveSingleAccountKeysToMove({
      channelKey: "matrix",
      channel: {
        homeserver: "https://matrix.example.org",
        streaming: { mode: "partial" },
        appToken: "not-matrix",
        rooms: { lobby: {} },
      },
      setupSurface: { singleAccountKeysToMove: ["homeserver"] },
      includeSetupKeys: true,
    });

    expect(keys).toEqual(["homeserver", "streaming"]);
  });

  it("defers only undeclared keys outside generic and legacy coverage", () => {
    expect(
      resolveSingleAccountPromotion({
        channelKey: "community",
        channel: {
          accounts: { work: {} },
          dmPolicy: "allowlist",
          appToken: "legacy-app-token",
        },
        setupSurface: {},
      }),
    ).toMatchObject({
      keysToMove: ["dmPolicy", "appToken"],
      shouldDeferPromotion: false,
    });

    expect(
      resolveSingleAccountPromotion({
        channelKey: "community",
        channel: {
          accounts: { work: {} },
          dmPolicy: "allowlist",
          appToken: "legacy-app-token",
          customAuth: "uncovered",
        },
        setupSurface: {},
      }),
    ).toMatchObject({ shouldDeferPromotion: true });

    expect(
      resolveSingleAccountPromotion({
        channelKey: "community",
        channel: {
          accounts: { work: {} },
          dmPolicy: "allowlist",
          customAuth: "declared-none",
        },
        setupSurface: { singleAccountKeysToMove: [] },
      }),
    ).toMatchObject({
      keysToMove: ["dmPolicy"],
      shouldDeferPromotion: false,
    });
  });

  it("does not consult bundled artifacts without an injected resolver", () => {
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
    expect(resolveBundledSurfaceMock).not.toHaveBeenCalled();
  });

  it("uses an injected bundled surface for non-static migration keys", () => {
    resolveBundledSurfaceMock.mockReturnValue({ singleAccountKeysToMove: ["customAuth"] });

    expect(
      resolveSingleAccountKeysToMove({
        channelKey: "demo",
        channel: {
          customAuth: "secret",
        },
        resolveBundledSurface: resolveBundledSurfaceMock,
      }),
    ).toEqual(["customAuth"]);
    expect(resolveBundledSurfaceMock).toHaveBeenCalledWith("demo");
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
    expect(resolveBundledSurfaceMock).not.toHaveBeenCalled();
  });

  it("loads bundled setup for named-account filters before registry bootstrap", () => {
    resolveBundledSurfaceMock.mockReturnValue({ namedAccountPromotionKeys: ["token"] });

    const keys = resolveSingleAccountKeysToMove({
      channelKey: "demo",
      channel: {
        accounts: {
          work: { enabled: true },
        },
        token: "secret",
        dmPolicy: "allowlist",
      },
      resolveBundledSurface: resolveBundledSurfaceMock,
    });

    expect(keys).toEqual(["token"]);
    expect(getLoadedChannelPluginMock).toHaveBeenCalledWith("demo");
    expect(resolveBundledSurfaceMock).toHaveBeenCalledWith("demo");
  });
});
