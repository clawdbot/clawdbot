import { describe, expect, it } from "vitest";
import {
  applyMoonshotNativeStreamingUsageCompat,
  buildMoonshotProvider,
  MOONSHOT_BASE_URL,
  MOONSHOT_CN_BASE_URL,
} from "./api.js";

type MoonshotProvider = ReturnType<typeof buildMoonshotProvider>;
type MoonshotModel = MoonshotProvider["models"][number];

function requireMoonshotModel(provider: MoonshotProvider, modelId: string): MoonshotModel {
  const model = provider.models.find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new Error(`expected Moonshot model ${modelId}`);
  }
  return model;
}

function requireFirstMoonshotModel(provider: MoonshotProvider): MoonshotModel {
  const model = provider.models[0];
  if (!model) {
    throw new Error("expected first Moonshot model");
  }
  return model;
}

function requireMoonshotCompat(model: MoonshotModel): NonNullable<MoonshotModel["compat"]> {
  if (!model.compat) {
    throw new Error(`expected Moonshot model ${model.id} compat`);
  }
  return model.compat;
}

describe("moonshot provider catalog", () => {
  it("builds the bundled Moonshot provider defaults", () => {
    const provider = buildMoonshotProvider();

    expect(provider.baseUrl).toBe(MOONSHOT_BASE_URL);
    expect(provider.api).toBe("openai-completions");
    expect(provider.models.map((model) => model.id)).toEqual([
      "kimi-k2.6",
      "kimi-k2.5",
      "kimi-k2-thinking",
      "kimi-k2-thinking-turbo",
      "kimi-k2-turbo",
    ]);
    expect(requireMoonshotModel(provider, "kimi-k2.6").cost).toEqual({
      input: 0.95,
      output: 4,
      cacheRead: 0.16,
      cacheWrite: 0,
    });
    expect(requireMoonshotModel(provider, "kimi-k2.5").cost).toEqual({
      input: 0.6,
      output: 3,
      cacheRead: 0.1,
      cacheWrite: 0,
    });
  });

  it("opts native Moonshot baseUrls into streaming usage only inside the extension", () => {
    const defaultProvider = applyMoonshotNativeStreamingUsageCompat(buildMoonshotProvider());
    expect(
      requireMoonshotCompat(requireFirstMoonshotModel(defaultProvider)).supportsUsageInStreaming,
    ).toBe(true);

    const cnProvider = applyMoonshotNativeStreamingUsageCompat({
      ...buildMoonshotProvider(),
      baseUrl: MOONSHOT_CN_BASE_URL,
    });
    expect(
      requireMoonshotCompat(requireFirstMoonshotModel(cnProvider)).supportsUsageInStreaming,
    ).toBe(true);

    const customProvider = applyMoonshotNativeStreamingUsageCompat({
      ...buildMoonshotProvider(),
      baseUrl: "https://proxy.example.com/v1",
    });
    expect(
      "supportsUsageInStreaming" in (requireFirstMoonshotModel(customProvider).compat ?? {}),
    ).toBe(false);
  });
});
