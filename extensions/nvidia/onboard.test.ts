import {
  expectProviderOnboardMergedLegacyConfig,
  expectProviderOnboardPrimaryModel,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import { applyNvidiaConfig, applyNvidiaProviderConfig } from "./onboard.js";

describe("nvidia onboard", () => {
  it("adds NVIDIA provider with correct settings", () => {
    const cfg = applyNvidiaConfig({});
    expect(cfg.models?.providers?.nvidia).toMatchObject({
      baseUrl: "https://integrate.api.nvidia.com/v1",
      api: "openai-completions",
    });
    expect(cfg.models?.providers?.nvidia?.models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2.5",
      "minimaxai/minimax-m2.5",
      "z-ai/glm5",
    ]);
    // Config stores the canonical form; the picker label shows the literal
    // form via preserveLiteralProviderPrefix.
    expectProviderOnboardPrimaryModel({
      applyConfig: applyNvidiaConfig,
      modelRef: "nvidia/nemotron-3-super-120b-a12b",
    });
  });

  it("merges NVIDIA models and keeps existing provider overrides", () => {
    const provider = expectProviderOnboardMergedLegacyConfig({
      applyProviderConfig: applyNvidiaProviderConfig,
      providerId: "nvidia",
      providerApi: "openai-completions",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      legacyApi: "openai-completions",
      legacyModelId: "custom-model",
      legacyModelName: "Custom",
    });
    expect(provider?.models.map((model) => model.id)).toEqual([
      "custom-model",
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2.5",
      "minimaxai/minimax-m2.5",
      "z-ai/glm5",
    ]);
  });
});
