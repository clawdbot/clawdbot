import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  createConfigWithFallbacks,
  createLegacyProviderConfig,
  EXPECTED_FALLBACKS,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import { applyXaiConfig, applyXaiProviderConfig, XAI_DEFAULT_MODEL_REF } from "./onboard.js";

describe("xai onboard", () => {
  it("adds xAI provider with correct settings", () => {
    const cfg = applyXaiConfig({});
    expect(cfg.models?.providers?.xai?.baseUrl).toBe("https://api.x.ai/v1");
    expect(cfg.models?.providers?.xai?.api).toBe("openai-responses");
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(XAI_DEFAULT_MODEL_REF);
  });

  it("merges xAI models and keeps existing provider overrides", () => {
    const legacy = createLegacyProviderConfig({
      providerId: "xai",
      api: "anthropic-messages",
      modelId: "custom-model",
      modelName: "Custom",
    });
    const xaiProvider = legacy.models?.providers?.xai;
    if (!xaiProvider) {
      throw new Error("expected xAI provider fixture");
    }
    xaiProvider.models.push(
      {
        id: "grok-3",
        name: "Grok 3",
        reasoning: false,
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
      },
      {
        id: "grok-code-fast-1",
        name: "Grok Code Fast 1",
        reasoning: true,
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
      },
    );

    const cfg = applyXaiProviderConfig(legacy);

    expect(cfg.models?.providers?.xai?.baseUrl).toBe("https://api.x.ai/v1");
    expect(cfg.models?.providers?.xai?.api).toBe("openai-responses");
    expect(cfg.models?.providers?.xai?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.xai?.models.map((m) => m.id)).toEqual([
      "custom-model",
      "grok-4.3",
      "grok-4.20-beta-latest-reasoning",
      "grok-4.20-beta-latest-non-reasoning",
    ]);
  });

  it("publishes current xAI models newest first for fresh setup", () => {
    const cfg = applyXaiProviderConfig({});

    expect(cfg.models?.providers?.xai?.baseUrl).toBe("https://api.x.ai/v1");
    expect(cfg.models?.providers?.xai?.api).toBe("openai-responses");
    expect(cfg.models?.providers?.xai?.models.map((m) => m.id)).toEqual([
      "grok-4.3",
      "grok-4.20-beta-latest-reasoning",
      "grok-4.20-beta-latest-non-reasoning",
    ]);
  });

  it("adds expected alias for the default model", () => {
    const cfg = applyXaiProviderConfig({});
    expect(cfg.agents?.defaults?.models?.[XAI_DEFAULT_MODEL_REF]?.alias).toBe("Grok");
  });

  it("preserves existing model fallbacks", () => {
    const cfg = applyXaiConfig(createConfigWithFallbacks());
    expect(resolveAgentModelFallbackValues(cfg.agents?.defaults?.model)).toEqual([
      ...EXPECTED_FALLBACKS,
    ]);
  });
});
