// Nvidia tests cover onboard plugin behavior.
import {
  expectProviderOnboardMergedLegacyConfig,
  expectProviderOnboardPrimaryModel,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import { applyNvidiaConfig, applyNvidiaProviderConfig } from "./onboard.js";

describe("nvidia onboard", () => {
  it("adds NVIDIA provider with correct settings", () => {
    const cfg = applyNvidiaConfig({});
    const provider = cfg.models?.providers?.nvidia;
    if (!provider) {
      throw new Error("expected NVIDIA provider config");
    }
    expect(provider.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/nemotron-3-super-120b-a12b",
      "z-ai/glm-5.2",
      "moonshotai/kimi-k2.6",
      "minimaxai/minimax-m3",
      "deepseek-ai/deepseek-v4-pro",
      "qwen/qwen3.5-397b-a17b",
    ]);
    // Config stores the canonical form; the picker label shows the literal
    // form via preserveLiteralProviderPrefix.
    expectProviderOnboardPrimaryModel({
      applyConfig: applyNvidiaConfig,
      modelRef: "nvidia/nemotron-3-ultra-550b-a55b",
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
      "nvidia/custom-model",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/nemotron-3-super-120b-a12b",
      "z-ai/glm-5.2",
      "moonshotai/kimi-k2.6",
      "minimaxai/minimax-m3",
      "deepseek-ai/deepseek-v4-pro",
      "qwen/qwen3.5-397b-a17b",
    ]);
  });

  it("preserves an existing deprecated exact-reference model", () => {
    const provider = expectProviderOnboardMergedLegacyConfig({
      applyProviderConfig: applyNvidiaProviderConfig,
      providerId: "nvidia",
      providerApi: "openai-completions",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      legacyApi: "openai-completions",
      legacyModelId: "moonshotai/kimi-k2.5",
      legacyModelName: "Kimi K2.5",
    });

    expect(provider?.models.map((model) => model.id)).toEqual([
      "moonshotai/kimi-k2.5",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/nemotron-3-super-120b-a12b",
      "z-ai/glm-5.2",
      "moonshotai/kimi-k2.6",
      "minimaxai/minimax-m3",
      "deepseek-ai/deepseek-v4-pro",
      "qwen/qwen3.5-397b-a17b",
    ]);
  });
});
