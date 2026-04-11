import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const normalizeChannelIdMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
const getActivePluginChannelRegistryVersionMock = vi.hoisted(() => vi.fn());

type TargetNormalizationModule = typeof import("./target-normalization.js");

let buildTargetResolverSignature: TargetNormalizationModule["buildTargetResolverSignature"];
let looksLikeTargetId: TargetNormalizationModule["looksLikeTargetId"];
let maybeResolvePluginMessagingTarget: TargetNormalizationModule["maybeResolvePluginMessagingTarget"];
let normalizeChannelTargetInput: TargetNormalizationModule["normalizeChannelTargetInput"];
let resolveNormalizedTargetInput: TargetNormalizationModule["resolveNormalizedTargetInput"];
let normalizeTargetForProvider: TargetNormalizationModule["normalizeTargetForProvider"];
let resetTargetNormalizerCacheForTests: TargetNormalizationModule["__testing"]["resetTargetNormalizerCacheForTests"];

vi.mock("../../channels/registry.js", () => ({
  normalizeAnyChannelId: (...args: unknown[]) => normalizeChannelIdMock(...args),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginChannelRegistryVersion: (...args: unknown[]) =>
    getActivePluginChannelRegistryVersionMock(...args),
}));

beforeAll(async () => {
  ({
    buildTargetResolverSignature,
    looksLikeTargetId,
    maybeResolvePluginMessagingTarget,
    normalizeChannelTargetInput,
    normalizeTargetForProvider,
    resolveNormalizedTargetInput,
  } = await import("./target-normalization.js"));
  ({
    __testing: { resetTargetNormalizerCacheForTests },
  } = await import("./target-normalization.js"));
});

beforeEach(() => {
  normalizeChannelIdMock.mockReset();
  getChannelPluginMock.mockReset();
  getActivePluginChannelRegistryVersionMock.mockReset();
  resetTargetNormalizerCacheForTests();
});

describe("normalizeChannelTargetInput", () => {
  it("trims raw target input", () => {
    expect(normalizeChannelTargetInput("  channel:C1  ")).toBe("channel:C1");
  });
});

describe("normalizeTargetForProvider", () => {
  it.each([undefined, "   "])("returns undefined for blank raw input %j", (raw) => {
    expect(normalizeTargetForProvider("telegram", raw)).toBeUndefined();
  });

  it.each([
    {
      provider: "unknown",
      setup: () => {
        normalizeChannelIdMock.mockReturnValueOnce(null);
      },
      expected: "raw-id",
    },
    {
      provider: "telegram",
      setup: () => {
        normalizeChannelIdMock.mockReturnValueOnce("telegram");
        getActivePluginChannelRegistryVersionMock.mockReturnValueOnce(1);
        getChannelPluginMock.mockReturnValueOnce(undefined);
      },
      expected: "raw-id",
    },
  ])(
    "falls back to trimmed input when provider normalization misses for %j",
    ({ provider, setup, expected }) => {
      setup();
      expect(normalizeTargetForProvider(provider, "  raw-id  ")).toBe(expected);
    },
  );

  it("uses the cached target normalizer until the plugin registry version changes", () => {
    const firstNormalizer = vi.fn((raw: string) => raw.trim().toUpperCase());
    const secondNormalizer = vi.fn((raw: string) => `next:${raw.trim()}`);
    normalizeChannelIdMock.mockReturnValue("telegram");
    getActivePluginChannelRegistryVersionMock
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(11);
    getChannelPluginMock
      .mockReturnValueOnce({
        messaging: { normalizeTarget: firstNormalizer },
      })
      .mockReturnValueOnce({
        messaging: { normalizeTarget: secondNormalizer },
      });

    expect(normalizeTargetForProvider("telegram", "  abc  ")).toBe("ABC");
    expect(normalizeTargetForProvider("telegram", "  def  ")).toBe("DEF");
    expect(normalizeTargetForProvider("telegram", "  ghi  ")).toBe("next:ghi");

    expect(getChannelPluginMock).toHaveBeenCalledTimes(2);
    expect(firstNormalizer).toHaveBeenCalledTimes(2);
    expect(secondNormalizer).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when the provider normalizer resolves to an empty value", () => {
    normalizeChannelIdMock.mockReturnValueOnce("telegram");
    getActivePluginChannelRegistryVersionMock.mockReturnValueOnce(20);
    getChannelPluginMock.mockReturnValueOnce({
      messaging: {
        normalizeTarget: () => "",
      },
    });

    expect(normalizeTargetForProvider("telegram", "  raw-id  ")).toBeUndefined();
  });
});

describe("resolveNormalizedTargetInput", () => {
  it("returns undefined for blank input", () => {
    expect(resolveNormalizedTargetInput("telegram", "   ")).toBeUndefined();
  });

  it("returns raw and normalized values", () => {
    normalizeChannelIdMock.mockReturnValueOnce("telegram");
    getActivePluginChannelRegistryVersionMock.mockReturnValueOnce(1);
    getChannelPluginMock.mockReturnValueOnce({
      messaging: {
        normalizeTarget: (raw: string) => raw.trim().toUpperCase(),
      },
    });

    expect(resolveNormalizedTargetInput("telegram", "  abc  ")).toEqual({
      raw: "abc",
      normalized: "ABC",
    });
  });
});

describe("looksLikeTargetId", () => {
  it("uses plugin looksLikeId when available", () => {
    const pluginLooksLikeId = vi.fn((raw: string, normalized: string) => raw !== normalized);
    getChannelPluginMock.mockReturnValueOnce({
      messaging: {
        targetResolver: {
          looksLikeId: pluginLooksLikeId,
        },
      },
    });

    expect(
      looksLikeTargetId({
        channel: "telegram",
        raw: "room-1",
        normalized: "ROOM-1",
      }),
    ).toBe(true);
    expect(pluginLooksLikeId).toHaveBeenCalledWith("room-1", "ROOM-1");
  });

  it.each(["channel:C123", "@alice", "#general", "+15551234567", "conversation:abc", "foo@thread"])(
    "falls back to built-in id-like heuristics for %s",
    (raw) => {
      getChannelPluginMock.mockReturnValueOnce(undefined);
      expect(looksLikeTargetId({ channel: "slack", raw })).toBe(true);
    },
  );
});

describe("maybeResolvePluginMessagingTarget", () => {
  const cfg = {} as OpenClawConfig;

  it("returns undefined when requireIdLike is set and the target is not id-like", async () => {
    getChannelPluginMock.mockReturnValueOnce({
      messaging: {
        targetResolver: {
          looksLikeId: () => false,
          resolveTarget: vi.fn(),
        },
      },
    });

    await expect(
      maybeResolvePluginMessagingTarget({
        cfg,
        channel: "slack",
        input: "general",
        requireIdLike: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("invokes the plugin resolver with normalized input and defaults source", async () => {
    normalizeChannelIdMock.mockReturnValueOnce("slack");
    getActivePluginChannelRegistryVersionMock.mockReturnValueOnce(1);
    const resolveTarget = vi.fn().mockResolvedValue({
      to: "channel:C123ABC",
      kind: "group",
      display: "general",
    });
    getChannelPluginMock
      .mockReturnValueOnce({
        messaging: {
          normalizeTarget: (raw: string) => raw.trim().toUpperCase(),
        },
      })
      .mockReturnValueOnce({
        messaging: {
          targetResolver: {
            resolveTarget,
          },
        },
      });

    await expect(
      maybeResolvePluginMessagingTarget({
        cfg,
        channel: "slack",
        input: "  channel:c123abc  ",
      }),
    ).resolves.toEqual({
      to: "channel:C123ABC",
      kind: "group",
      display: "general",
      source: "normalized",
    });

    expect(resolveTarget).toHaveBeenCalledWith({
      cfg,
      accountId: undefined,
      input: "channel:c123abc",
      normalized: "CHANNEL:C123ABC",
      preferredKind: undefined,
    });
  });
});

describe("buildTargetResolverSignature", () => {
  it("builds stable signatures from resolver hint and looksLikeId source", () => {
    const looksLikeId = (value: string) => value.startsWith("C");
    getChannelPluginMock.mockReturnValueOnce({
      messaging: {
        targetResolver: {
          hint: "Use channel id",
          looksLikeId,
        },
      },
    });

    const first = buildTargetResolverSignature("slack");
    getChannelPluginMock.mockReturnValueOnce({
      messaging: {
        targetResolver: {
          hint: "Use channel id",
          looksLikeId,
        },
      },
    });
    const second = buildTargetResolverSignature("slack");

    expect(first).toBe(second);
  });

  it("changes when resolver metadata changes", () => {
    getChannelPluginMock.mockReturnValueOnce({
      messaging: {
        targetResolver: {
          hint: "Use channel id",
          looksLikeId: (value: string) => value.startsWith("C"),
        },
      },
    });
    const first = buildTargetResolverSignature("slack");

    getChannelPluginMock.mockReturnValueOnce({
      messaging: {
        targetResolver: {
          hint: "Use user id",
          looksLikeId: (value: string) => value.startsWith("U"),
        },
      },
    });
    const second = buildTargetResolverSignature("slack");

    expect(first).not.toBe(second);
  });
});
