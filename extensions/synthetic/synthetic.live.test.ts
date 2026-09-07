import { buildOpenAICompatibleLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import { buildSyntheticProvider, SYNTHETIC_MODEL_DISCOVERY } from "./provider-catalog.js";

const describeLive = isLiveTestEnabled() ? describe : describe.skip;

describeLive("Synthetic public catalog live", () => {
  it("discovers current small models with native capabilities and pricing", async () => {
    const provider = await buildOpenAICompatibleLiveModelProviderConfig({
      providerId: "synthetic",
      providerConfig: buildSyntheticProvider(),
      modelDiscovery: SYNTHETIC_MODEL_DISCOVERY,
    });
    expect(provider.api).toBe("anthropic-messages");
    expect(provider.models.find((model) => model.id === "hf:Qwen/Qwen3.8-27B")).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262_144,
      maxTokens: 65_536,
      compat: { supportsTools: true },
      cost: { input: 0.45, output: 2.2, cacheRead: 0.09 },
    });
    expect(provider.models.some((model) => model.id.startsWith("syn:"))).toBe(true);
  });
});
