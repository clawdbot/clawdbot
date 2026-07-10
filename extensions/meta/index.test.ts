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
    });
  });

  it("builds the muse-spark-1.1 catalog entry over openai-responses", () => {
    const providerConfig = buildMetaProvider();
    expect(providerConfig.baseUrl).toBe("https://api.ai.meta.com/v1");
    expect(providerConfig.api).toBe("openai-responses");
    const model = providerConfig.models.find((m) => m.id === "muse-spark-1.1");
    if (!model) {
      throw new Error("Expected muse-spark-1.1 model");
    }
    expect(model.contextWindow).toBe(1048576);
    expect(model.reasoning).toBe(true);
    expect(model.input).toContain("image");
  });

  it("advertises a high default thinking profile for muse-spark-1.1", () => {
    const captured = capturePluginRegistration(plugin);
    const [provider] = captured.providers;
    if (!provider) {
      throw new Error("Expected Meta provider");
    }
    const resolveThinkingProfile = requireThinkingProfileResolver(provider);
    const profile = resolveThinkingProfile({
      provider: "meta",
      modelId: "muse-spark-1.1",
    } as never);
    expect(profile?.defaultLevel).toBe("high");
    expect(profile?.levels.map((level) => level.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
});
