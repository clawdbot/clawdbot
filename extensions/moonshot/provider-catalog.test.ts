// Moonshot tests cover provider catalog plugin behavior.
import { describe, expect, it } from "vitest";
import {
  applyMoonshotNativeStreamingUsageCompat,
  buildMoonshotProvider,
  MOONSHOT_BASE_URL,
  MOONSHOT_CN_BASE_URL,
} from "./api.js";

type MoonshotProvider = ReturnType<typeof buildMoonshotProvider>;
type MoonshotModel = MoonshotProvider["models"][number];

function requireFirstMoonshotModel(provider: MoonshotProvider): MoonshotModel {
  const model = provider.models[0];
  if (!model) {
    throw new Error("expected first Moonshot model");
  }
  return model;
}

describe("moonshot provider catalog", () => {
  it("builds the bundled Moonshot provider defaults", () => {
    const provider = buildMoonshotProvider();

    expect(provider.baseUrl).toBe(MOONSHOT_BASE_URL);
    expect(provider.api).toBe("openai-completions");
    expect(provider.models.map((model) => model.id)).toEqual([
      "kimi-k3",
      "kimi-k2.7-code",
      "kimi-k2.7-code-highspeed",
    ]);
    expect(provider.models.find((model) => model.id === "kimi-k3")).toMatchObject({
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        xhigh: "max",
        max: "max",
      },
      input: ["text", "image"],
      contextWindow: 1_048_576,
      maxTokens: 1_048_576,
      cost: {
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 0,
      },
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "high", "max"],
      },
    });
    expect(provider.models.find((model) => model.id === "kimi-k2.7-code")).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 262144,
      cost: {
        input: 0.95,
        output: 4,
        cacheRead: 0.19,
        cacheWrite: 0,
      },
    });
    expect(provider.models.find((model) => model.id === "kimi-k2.7-code-highspeed")).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 262144,
      cost: {
        input: 1.9,
        output: 8,
        cacheRead: 0.38,
        cacheWrite: 0,
      },
    });
  });

  it("opts native Moonshot baseUrls into streaming usage only inside the extension", () => {
    const defaultProvider = applyMoonshotNativeStreamingUsageCompat(buildMoonshotProvider());
    expect(requireFirstMoonshotModel(defaultProvider).compat?.supportsUsageInStreaming).toBe(true);

    const cnProvider = applyMoonshotNativeStreamingUsageCompat({
      ...buildMoonshotProvider(),
      baseUrl: MOONSHOT_CN_BASE_URL,
    });
    expect(requireFirstMoonshotModel(cnProvider).compat?.supportsUsageInStreaming).toBe(true);

    const customProvider = applyMoonshotNativeStreamingUsageCompat({
      ...buildMoonshotProvider(),
      baseUrl: "https://proxy.example.com/v1",
    });
    expect(
      "supportsUsageInStreaming" in (requireFirstMoonshotModel(customProvider).compat ?? {}),
    ).toBe(false);
  });
});
