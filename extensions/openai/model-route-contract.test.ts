import { describe, expect, it } from "vitest";
import {
  OPENAI_CHATGPT_MODERN_MODEL_IDS,
  OPENAI_DUAL_ROUTE_MODEL_IDS,
  OPENAI_PLATFORM_ONLY_ROUTE_MODEL_IDS,
  OPENAI_PROVIDER_MODERN_MODEL_IDS,
  OPENAI_SUBSCRIPTION_ONLY_ROUTE_MODEL_IDS,
  isOpenAIDualRouteModelId,
  isOpenAIPlatformOnlyRouteModelId,
  isOpenAISubscriptionOnlyRouteModelId,
  normalizeOpenAIModelRouteId,
} from "./model-route-contract.js";
import { buildOpenAICodexProviderHooks } from "./openai-chatgpt-provider.js";
import { buildOpenAIProvider } from "./openai-provider.js";
import { resolveModelRoutes } from "./provider-policy-api.js";

function resolveUnconfiguredModel(modelId: string) {
  return resolveModelRoutes({
    provider: "openai",
    modelId,
    env: {},
  });
}

describe("OpenAI model route contract", () => {
  it("preserves custom model spelling while matching built-in routes case-insensitively", () => {
    expect(normalizeOpenAIModelRouteId("  openai/Future-MODEL  ")).toBe("openai/Future-MODEL");
    expect(normalizeOpenAIModelRouteId("future-model")).toBe("future-model");
    expect(normalizeOpenAIModelRouteId("GPT-5.4-CODEX")).toBe("gpt-5.4");

    expect(isOpenAIDualRouteModelId("GPT-5.5")).toBe(true);
    expect(isOpenAIPlatformOnlyRouteModelId("CHAT-LATEST")).toBe(true);
    expect(isOpenAISubscriptionOnlyRouteModelId("GPT-5.3-CODEX-SPARK")).toBe(true);
  });

  it("keeps route eligibility aligned with both provider runtime surfaces", () => {
    const provider = buildOpenAIProvider();
    const chatGPTHooks = buildOpenAICodexProviderHooks();
    const routeModelIds = [
      ...OPENAI_DUAL_ROUTE_MODEL_IDS,
      ...OPENAI_PLATFORM_ONLY_ROUTE_MODEL_IDS,
      ...OPENAI_SUBSCRIPTION_ONLY_ROUTE_MODEL_IDS,
    ];

    expect(new Set(routeModelIds).size).toBe(routeModelIds.length);

    for (const modelId of OPENAI_PROVIDER_MODERN_MODEL_IDS) {
      expect(provider.isModernModelRef?.({ provider: "openai", modelId })).toBe(true);
    }
    for (const modelId of OPENAI_CHATGPT_MODERN_MODEL_IDS) {
      expect(chatGPTHooks.isModernModelRef?.({ provider: "openai", modelId })).toBe(true);
    }

    for (const modelId of OPENAI_DUAL_ROUTE_MODEL_IDS) {
      const resolution = resolveUnconfiguredModel(modelId);
      expect(
        resolution.kind === "routes" ? resolution.routes.map((route) => route.api) : [],
      ).toEqual(["openai-responses", "openai-chatgpt-responses"]);
    }
    for (const modelId of OPENAI_PLATFORM_ONLY_ROUTE_MODEL_IDS) {
      expect(resolveUnconfiguredModel(modelId)).toMatchObject({
        kind: "routes",
        defaultRuntimeId: "codex",
        routes: [{ api: "openai-responses", authRequirement: "api-key" }],
      });
    }
    for (const modelId of OPENAI_SUBSCRIPTION_ONLY_ROUTE_MODEL_IDS) {
      expect(resolveUnconfiguredModel(modelId)).toMatchObject({
        kind: "routes",
        defaultRuntimeId: "codex",
        routes: [{ api: "openai-chatgpt-responses", authRequirement: "subscription" }],
      });
    }
  });
});
