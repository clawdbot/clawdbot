// Anthropic Vertex tests cover index plugin behavior.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { hasAnthropicVertexAvailableAuthMock } = vi.hoisted(() => ({
  hasAnthropicVertexAvailableAuthMock: vi.fn(),
}));

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    hasAnthropicVertexAvailableAuth: hasAnthropicVertexAvailableAuthMock,
  };
});

import anthropicVertexPlugin from "./index.js";
import { buildAnthropicVertexProvider } from "./provider-catalog.js";

describe("anthropic-vertex provider plugin", () => {
  beforeEach(() => {
    hasAnthropicVertexAvailableAuthMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.doUnmock("./api.js");
    vi.resetModules();
  });

  it("resolves the ADC marker through the provider hook", async () => {
    const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);

    expect(
      provider.resolveConfigApiKey?.({
        provider: "anthropic-vertex",
        env: {
          ANTHROPIC_VERTEX_USE_GCP_METADATA: "true",
        } as NodeJS.ProcessEnv,
      } as never),
    ).toBe("gcp-vertex-credentials");
  });

  it("merges the implicit Vertex catalog into explicit provider overrides", async () => {
    const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);

    const result = await provider.catalog?.run({
      config: {
        models: {
          providers: {
            "anthropic-vertex": {
              baseUrl: "https://europe-west4-aiplatform.googleapis.com",
              headers: { "x-test-header": "1" },
            },
          },
        },
      },
      env: {
        ANTHROPIC_VERTEX_USE_GCP_METADATA: "true",
        GOOGLE_CLOUD_LOCATION: "us-east5",
      } as NodeJS.ProcessEnv,
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({
        apiKey: undefined,
        discoveryApiKey: undefined,
        mode: "none",
        source: "none",
      }),
    } as never);

    if (!result || !("provider" in result)) {
      throw new Error("expected single provider catalog result");
    }
    expect(result.provider.api).toBe("anthropic-messages");
    expect(result.provider.apiKey).toBe("gcp-vertex-credentials");
    expect(result.provider.baseUrl).toBe("https://europe-west4-aiplatform.googleapis.com");
    expect(result.provider.headers).toEqual({ "x-test-header": "1" });
    expect(result.provider.models.map((model) => model.id)).toEqual([
      "claude-fable-5",
      "claude-mythos-5",
      "claude-opus-4-8",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]);
    expect(result.provider.models[0]?.thinkingLevelMap).toEqual({
      off: "low",
      minimal: "low",
      xhigh: "xhigh",
      max: "max",
    });
    expect(result.provider.models[1]?.thinkingLevelMap).toEqual({
      off: "low",
      minimal: "low",
      xhigh: "xhigh",
      max: "max",
    });
    expect(result.provider.models[2]?.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
    expect(result.provider.models[3]?.thinkingLevelMap).toEqual({ xhigh: null, max: "max" });
    expect(result.provider.models[4]?.thinkingLevelMap).toEqual({ xhigh: null, max: "max" });
  });

  it.each(["global", "us", "eu"])("publishes Sonnet 5 for the %s endpoint", (region) => {
    const provider = buildAnthropicVertexProvider({
      env: { GOOGLE_CLOUD_LOCATION: region },
      nowMs: Date.UTC(2026, 7, 31),
    });

    expect(provider.models.map((model) => model.id)).toContain("claude-sonnet-5");
  });

  it.each([
    {
      region: "global",
      nowMs: Date.UTC(2026, 7, 31),
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    },
    {
      region: "us",
      nowMs: Date.UTC(2026, 7, 31),
      cost: { input: 2.2, output: 11, cacheRead: 0.22, cacheWrite: 2.75 },
    },
    {
      region: "global",
      nowMs: Date.UTC(2026, 8, 1),
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
    {
      region: "eu",
      nowMs: Date.UTC(2026, 8, 1),
      cost: { input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 4.125 },
    },
  ])("uses the documented Sonnet 5 pricing for $region", ({ region, nowMs, cost }) => {
    const provider = buildAnthropicVertexProvider({
      env: { GOOGLE_CLOUD_LOCATION: region },
      nowMs,
    });

    expect(provider.models.find((model) => model.id === "claude-sonnet-5")).toMatchObject({
      cost,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    });
  });

  it("restores missing or stale Sonnet 5 pricing during runtime normalization", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 1));
    try {
      const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);
      const model = {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        api: "anthropic-messages",
        provider: "anthropic-vertex",
        baseUrl: "https://us-aiplatform.googleapis.com",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        contextTokens: 1_000_000,
        maxTokens: 128_000,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      };
      const expectedCost = {
        input: 3.3,
        output: 16.5,
        cacheRead: 0.33,
        cacheWrite: 4.125,
      };

      for (const cost of [
        undefined,
        { input: 2.2, output: 11, cacheRead: 0.22, cacheWrite: 2.75 },
      ]) {
        const normalized = provider.normalizeResolvedModel?.({
          provider: "anthropic-vertex",
          modelId: "claude-sonnet-5",
          model: { ...model, cost },
        } as never);
        expect(normalized?.cost).toEqual(expectedCost);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("owns Anthropic-style replay policy", async () => {
    const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "anthropic-vertex",
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      } as never),
    ).toEqual({
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      preserveNativeAnthropicToolUseIds: true,
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      validateAnthropicTurns: true,
      allowSyntheticToolResults: true,
    });
    expect(
      provider.buildReplayPolicy?.({
        provider: "anthropic-vertex",
        modelApi: "anthropic-messages",
        modelId: "claude-fable-5",
      } as never),
    ).not.toHaveProperty("dropThinkingBlocks");
  });

  it("owns Anthropic-style thinking policy", async () => {
    const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);

    const opus48Profile = provider.resolveThinkingProfile?.({
      provider: "anthropic-vertex",
      modelId: "claude-opus-4-8",
    } as never);

    expect(opus48Profile?.defaultLevel).toBe("off");
    expect(opus48Profile?.levels.map((level) => level.id)).toContain("max");

    const fableProfile = provider.resolveThinkingProfile?.({
      provider: "anthropic-vertex",
      modelId: "claude-fable-5",
    } as never);
    expect(fableProfile?.defaultLevel).toBe("high");
    expect(fableProfile?.preserveWhenCatalogReasoningFalse).toBe(true);

    const aliasProfile = provider.resolveThinkingProfile?.({
      provider: "anthropic-vertex",
      modelId: "production-claude",
      params: { canonicalModelId: "claude-fable-5" },
    } as never);
    expect(aliasProfile?.defaultLevel).toBe("high");
  });

  it("restores Fable metadata for explicit Vertex catalog rows", async () => {
    const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);

    const normalized = provider.normalizeResolvedModel?.({
      provider: "anthropic-vertex",
      modelId: "claude-fable-5",
      model: {
        id: "claude-fable-5",
        name: "Claude Fable 5",
        api: "anthropic-messages",
        provider: "anthropic-vertex",
        baseUrl: "https://aiplatform.googleapis.com",
        reasoning: false,
        input: ["text"],
        cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
        contextWindow: 200_000,
        maxTokens: 8192,
      },
    } as never);

    expect(normalized).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      contextTokens: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: {
        off: "low",
        minimal: "low",
        xhigh: "xhigh",
        max: "max",
      },
    });

    const aliasNormalized = provider.normalizeResolvedModel?.({
      provider: "anthropic-vertex",
      modelId: "production-claude",
      model: {
        id: "production-claude",
        name: "Production Claude",
        api: "anthropic-messages",
        provider: "anthropic-vertex",
        baseUrl: "https://aiplatform.googleapis.com",
        reasoning: false,
        input: ["text"],
        cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
        contextWindow: 200_000,
        maxTokens: 8192,
        params: { canonicalModelId: "claude-fable-5" },
        thinkingLevelMap: { max: null },
      },
    } as never);
    expect(aliasNormalized).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: null },
    });
  });

  it("restores Mythos 5 metadata for explicit Vertex catalog rows", async () => {
    const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);
    const normalized = provider.normalizeResolvedModel?.({
      provider: "anthropic-vertex",
      modelId: "claude-mythos-5",
      model: {
        id: "claude-mythos-5",
        name: "Claude Mythos 5",
        api: "anthropic-messages",
        provider: "anthropic-vertex",
        baseUrl: "https://aiplatform.googleapis.com",
        reasoning: false,
        input: ["text"],
        cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
        contextWindow: 200_000,
        maxTokens: 8192,
      },
    } as never);

    expect(normalized).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      contextTokens: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: {
        off: "low",
        minimal: "low",
        xhigh: "xhigh",
        max: "max",
      },
    });
  });
  it("resolves synthetic auth when ADC is available", async () => {
    hasAnthropicVertexAvailableAuthMock.mockReturnValue(true);
    const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);

    const result = provider.resolveSyntheticAuth?.({
      provider: "anthropic-vertex",
      config: undefined,
      providerConfig: undefined,
    } as never);

    expect(result).toEqual({
      apiKey: "gcp-vertex-credentials",
      source: "gcp-vertex-credentials (ADC)",
      mode: "api-key",
    });
  });

  it("returns undefined when ADC is not available", async () => {
    hasAnthropicVertexAvailableAuthMock.mockReturnValue(false);
    const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);

    const result = provider.resolveSyntheticAuth?.({
      provider: "anthropic-vertex",
      config: undefined,
      providerConfig: undefined,
    } as never);

    expect(result).toBeUndefined();
  });
});
