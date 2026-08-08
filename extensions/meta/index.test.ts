// Meta tests cover plugin registration and catalog shape.
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { buildMetaProvider } from "./api.js";
import plugin from "./index.js";

function requireThinkingProfileResolver(
  provider: ReturnType<typeof capturePluginRegistration>["providers"][number],
) {
  if (!provider.resolveThinkingProfile) {
    throw new Error("Expected resolveThinkingProfile on Meta provider");
  }
  return provider.resolveThinkingProfile;
}

describe("meta provider", () => {
  it("registers the Meta provider with api-key auth", () => {
    const captured = capturePluginRegistration(plugin);
    const [provider] = captured.providers;
    if (!provider) {
      throw new Error("Expected Meta provider");
    }
    expect(provider).toMatchObject({
      id: "meta",
      label: "Meta",
      docsPath: "/providers/meta",
    });
    expect(provider.auth).toHaveLength(1);
    expect(provider.auth[0]).toMatchObject({
      id: "api-key",
      kind: "api_key",
      label: "Meta API key",
      starterModel: "meta/muse-spark-1.1",
    });
  });

  it("builds the muse-spark-1.1 catalog entry over openai-responses", () => {
    const providerConfig = buildMetaProvider();
    expect(providerConfig.baseUrl).toBe("https://api.meta.ai/v1");
    expect(providerConfig.api).toBe("openai-responses");
    const model = providerConfig.models.find((m) => m.id === "muse-spark-1.1");
    if (!model) {
      throw new Error("Expected muse-spark-1.1 model");
    }
    expect(model.contextWindow).toBe(1048576);
    expect(model.maxTokens).toBe(131072);
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(["text", "image"]);
    expect(model.cost).toEqual({
      input: 1.25,
      output: 4.25,
      cacheRead: 0.15,
      cacheWrite: 0,
    });
  });

  it("builds the muse-spark-1.2 catalog entry over openai-responses", () => {
    const providerConfig = buildMetaProvider();
    expect(providerConfig.baseUrl).toBe("https://api.meta.ai/v1");
    expect(providerConfig.api).toBe("openai-responses");
    const model = providerConfig.models.find((m) => m.id === "muse-spark-1.2");
    if (!model) {
      throw new Error("Expected muse-spark-1.2 model");
    }
    expect(model.contextWindow).toBe(1048576);
    expect(model.maxTokens).toBe(131072);
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(["text", "image"]);
    expect(model.cost).toEqual({
      input: 1.25,
      output: 4.25,
      cacheRead: 0.15,
      cacheWrite: 0,
    });
  });

  it("builds the discounted muse-spark-1.2-contributor catalog entry", () => {
    const providerConfig = buildMetaProvider();
    const model = providerConfig.models.find((m) => m.id === "muse-spark-1.2-contributor");
    if (!model) {
      throw new Error("Expected muse-spark-1.2-contributor model");
    }
    expect(model.contextWindow).toBe(1048576);
    expect(model.maxTokens).toBe(131072);
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(["text", "image"]);
    expect(model.cost).toEqual({
      input: 0.1,
      output: 0.2,
      cacheRead: 0.002,
      cacheWrite: 0,
    });
  });

  it("publishes a non-empty display name for every catalog model", () => {
    const models = buildMetaProvider().models;
    expect(models.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "muse-spark-1.1", name: "Muse Spark 1.1" },
      { id: "muse-spark-1.2", name: "Muse Spark 1.2" },
      { id: "muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor" },
    ]);
    expect(models.every((model) => model.name.trim().length > 0)).toBe(true);
  });

  it("advertises a high default thinking profile for every reasoning model", () => {
    const captured = capturePluginRegistration(plugin);
    const [provider] = captured.providers;
    if (!provider) {
      throw new Error("Expected Meta provider");
    }
    const resolveThinkingProfile = requireThinkingProfileResolver(provider);
    const reasoningModels = buildMetaProvider().models.filter((model) => model.reasoning);
    expect(reasoningModels.map((model) => model.id)).toEqual([
      "muse-spark-1.1",
      "muse-spark-1.2",
      "muse-spark-1.2-contributor",
    ]);
    for (const model of reasoningModels) {
      const profile = resolveThinkingProfile({
        provider: "meta",
        modelId: model.id,
        reasoning: model.reasoning,
      });
      expect(profile?.defaultLevel).toBe("high");
      expect(profile?.levels.map((level) => level.id)).toEqual([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      expect(
        resolveThinkingProfile({
          provider: "meta",
          modelId: model.id,
        })?.defaultLevel,
      ).toBe("high");
    }
  });

  it("respects an explicit non-reasoning catalog fact", () => {
    const captured = capturePluginRegistration(plugin);
    const [provider] = captured.providers;
    if (!provider) {
      throw new Error("Expected Meta provider");
    }
    const resolveThinkingProfile = requireThinkingProfileResolver(provider);
    expect(
      resolveThinkingProfile({
        provider: "meta",
        modelId: "muse-spark-1.2",
        reasoning: false,
      }),
    ).toBeUndefined();
  });
});
