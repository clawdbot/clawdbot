// Nexforce tests cover index plugin behavior.
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import nexforcePlugin from "./index.js";

describe("nexforce provider plugin", () => {
  it("registers Nexforce with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(nexforcePlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "nexforce-api-key",
    });

    expect(provider.id).toBe("nexforce");
    expect(provider.label).toBe("Nexforce Router");
    expect(provider.envVars).toEqual(["NEXFORCE_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    if (!resolved) {
      throw new Error("expected Nexforce api-key auth choice");
    }
    expect(resolved.provider.id).toBe("nexforce");
    expect(resolved.method.id).toBe("api-key");
  });

  it("builds the static Nexforce model catalog", async () => {
    const provider = await registerSingleProviderPlugin(nexforcePlugin);
    const staticResult = await provider.staticCatalog?.run({ config: {}, env: {} } as never);
    if (!staticResult || !("provider" in staticResult)) {
      throw new Error("expected static Nexforce provider catalog");
    }

    expect(staticResult.provider.api).toBe("openai-completions");
    expect(staticResult.provider.baseUrl).toBe("https://router.nexforce.ai/v1");
    expect(staticResult.provider.models.map((model) => model.id)).toEqual([
      "smart-route",
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.4",
      "deepseek/deepseek-v4-flash",
      "google/gemini-3.6-flash",
      "z-ai/glm-5",
    ]);
    const smartRoute = staticResult.provider.models.find((model) => model.id === "smart-route");
    expect(smartRoute?.name).toBe("Nexforce Smart Route");
    expect(smartRoute?.input).toEqual(["text"]);
  });

  it("owns OpenAI-compatible replay policy", async () => {
    const provider = await registerSingleProviderPlugin(nexforcePlugin);

    const replayPolicy = provider.buildReplayPolicy?.({ modelApi: "openai-completions" } as never);
    expect(replayPolicy?.sanitizeToolCallIds).toBe(true);
    expect(replayPolicy?.toolCallIdMode).toBe("strict");
    expect(replayPolicy?.validateGeminiTurns).toBe(true);
    expect(replayPolicy?.validateAnthropicTurns).toBe(true);
  });

  it("publishes configured Nexforce models through plugin-owned catalog augmentation", async () => {
    const provider = await registerSingleProviderPlugin(nexforcePlugin);

    expect(
      provider.augmentModelCatalog?.({
        config: {
          models: {
            providers: {
              nexforce: {
                models: [
                  {
                    id: "custom/model",
                    name: "Custom model",
                    input: ["text"],
                    reasoning: false,
                    contextWindow: 65536,
                  },
                ],
              },
            },
          },
        },
      } as never),
    ).toEqual([
      {
        provider: "nexforce",
        id: "custom/model",
        name: "Custom model",
        input: ["text"],
        reasoning: false,
        contextWindow: 65536,
      },
    ]);
  });
});
