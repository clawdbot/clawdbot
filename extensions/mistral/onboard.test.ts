import {
  expectProviderOnboardMergedLegacyConfig,
  expectProviderOnboardPrimaryAndFallbacks,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import { buildMistralModelDefinition as buildBundledMistralModelDefinition } from "./model-definitions.js";
import {
  applyMistralConfig,
  applyMistralProviderConfig,
  MISTRAL_DEFAULT_MODEL_REF,
} from "./onboard.js";

describe("mistral onboard", () => {
  it("adds Mistral provider with correct settings", () => {
    const cfg = applyMistralConfig({});
    expect(cfg.models?.providers?.mistral?.baseUrl).toBe("https://api.mistral.ai/v1");
    expect(cfg.models?.providers?.mistral?.api).toBe("openai-completions");
    expectProviderOnboardPrimaryAndFallbacks({
      applyConfig: applyMistralConfig,
      modelRef: MISTRAL_DEFAULT_MODEL_REF,
    });
  });

  it("merges Mistral models and keeps existing provider overrides", () => {
    const provider = expectProviderOnboardMergedLegacyConfig({
      applyProviderConfig: applyMistralProviderConfig,
      providerId: "mistral",
      providerApi: "openai-completions",
      baseUrl: "https://api.mistral.ai/v1",
      legacyApi: "anthropic-messages",
      legacyModelId: "custom-model",
      legacyModelName: "Custom",
    });
    expect(provider?.models.map((m) => m.id)).toEqual(["custom-model", "mistral-large-latest"]);
    const mistralDefault = provider?.models.find((model) => model.id === "mistral-large-latest");
    expect(mistralDefault?.contextWindow).toBe(262144);
    expect(mistralDefault?.maxTokens).toBe(16384);
  });

  it("uses the bundled mistral default model definition", () => {
    const bundled = buildBundledMistralModelDefinition();
    const cfg = applyMistralProviderConfig({});
    const defaultModel = cfg.models?.providers?.mistral?.models.find(
      (model) => model.id === bundled.id,
    );

    expect(defaultModel).toEqual(bundled);
  });

  it("adds the expected alias for the default model", () => {
    const cfg = applyMistralProviderConfig({});
    expect(cfg.agents?.defaults?.models?.[MISTRAL_DEFAULT_MODEL_REF]?.alias).toBe("Mistral");
  });
});
