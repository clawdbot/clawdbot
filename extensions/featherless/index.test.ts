// Featherless tests cover provider registration, catalog, and dynamic model behavior.
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { createProviderDynamicModelContext } from "../test-support/provider-model-test-helpers.js";
import featherlessPlugin from "./index.js";
import {
  FEATHERLESS_BASE_URL,
  FEATHERLESS_DEFAULT_CONTEXT_WINDOW,
  FEATHERLESS_DEFAULT_MAX_TOKENS,
  FEATHERLESS_DEFAULT_MODEL_ID,
  FEATHERLESS_DEFAULT_MODEL_REF,
  FEATHERLESS_DYNAMIC_COMPAT,
  FEATHERLESS_DYNAMIC_CONTEXT_WINDOW,
  FEATHERLESS_DYNAMIC_MAX_TOKENS,
} from "./models.js";
import { applyFeatherlessConfig } from "./onboard.js";

function createDefaultRuntimeModel(): ProviderRuntimeModel {
  return {
    id: FEATHERLESS_DEFAULT_MODEL_ID,
    name: "Qwen3 32B",
    provider: "featherless",
    api: "openai-completions",
    baseUrl: FEATHERLESS_BASE_URL,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: FEATHERLESS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: FEATHERLESS_DEFAULT_MAX_TOKENS,
    compat: { thinkingFormat: "qwen-chat-template" },
  };
}

describe("featherless provider plugin", () => {
  it("registers Featherless AI with api-key auth metadata", async () => {
    const provider = await registerSingleProviderPlugin(featherlessPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "featherless-api-key",
    });

    expect(provider.id).toBe("featherless");
    expect(provider.label).toBe("Featherless AI");
    expect(provider.envVars).toEqual(["FEATHERLESS_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(provider.normalizeToolSchemas).toEqual(expect.any(Function));
    expect(resolved?.provider.id).toBe("featherless");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("applies the curated default during onboarding", () => {
    const config = applyFeatherlessConfig({});

    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      FEATHERLESS_DEFAULT_MODEL_REF,
    );
    expect(config.agents?.defaults?.models?.[FEATHERLESS_DEFAULT_MODEL_REF]?.alias).toBe(
      "Qwen3 32B",
    );
  });

  it("builds the curated Featherless catalog", async () => {
    const provider = await registerSingleProviderPlugin(featherlessPlugin);
    const result = await provider.staticCatalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({}),
    } as never);
    if (!result || !("provider" in result)) {
      throw new Error("expected Featherless static catalog");
    }

    expect(result.provider.baseUrl).toBe(FEATHERLESS_BASE_URL);
    expect(result.provider.api).toBe("openai-completions");
    expect(result.provider.models).toEqual([
      expect.objectContaining({
        id: FEATHERLESS_DEFAULT_MODEL_ID,
        reasoning: true,
        input: ["text"],
        contextWindow: FEATHERLESS_DEFAULT_CONTEXT_WINDOW,
        maxTokens: FEATHERLESS_DEFAULT_MAX_TOKENS,
        compat: expect.objectContaining({
          maxTokensField: "max_tokens",
          thinkingFormat: "qwen-chat-template",
        }),
      }),
    ]);
  });

  it("resolves arbitrary Featherless model ids from conservative text defaults", async () => {
    const provider = await registerSingleProviderPlugin(featherlessPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "featherless",
        modelId: "moonshotai/Kimi-K2-Instruct",
        models: [createDefaultRuntimeModel()],
      }),
    );

    expect(resolved).toMatchObject({
      id: "moonshotai/Kimi-K2-Instruct",
      provider: "featherless",
      api: "openai-completions",
      baseUrl: FEATHERLESS_BASE_URL,
      reasoning: false,
      input: ["text"],
      contextWindow: FEATHERLESS_DYNAMIC_CONTEXT_WINDOW,
      maxTokens: FEATHERLESS_DYNAMIC_MAX_TOKENS,
      compat: FEATHERLESS_DYNAMIC_COMPAT,
    });
  });

  it("applies provider compat to configured models without overriding explicit values", async () => {
    const provider = await registerSingleProviderPlugin(featherlessPlugin);
    const normalized = provider.normalizeResolvedModel?.({
      provider: "featherless",
      modelId: "google/gemma-3-27b-it",
      model: {
        ...createDefaultRuntimeModel(),
        id: "google/gemma-3-27b-it",
        name: "Gemma 3 27B",
        compat: {
          supportsStore: true,
          thinkingFormat: "deepseek",
        },
      },
    });

    expect(normalized?.compat).toMatchObject({
      ...FEATHERLESS_DYNAMIC_COMPAT,
      supportsStore: true,
      thinkingFormat: "deepseek",
    });
  });

  it("defers the curated model to static catalog resolution", async () => {
    const provider = await registerSingleProviderPlugin(featherlessPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "featherless",
        modelId: FEATHERLESS_DEFAULT_MODEL_ID,
        models: [createDefaultRuntimeModel()],
      }),
    );

    expect(resolved).toBeUndefined();
  });

  it("uses the shared OpenAI-compatible replay policy", async () => {
    const provider = await registerSingleProviderPlugin(featherlessPlugin);
    const policy = provider.buildReplayPolicy?.({
      provider: "featherless",
      modelApi: "openai-completions",
      modelId: FEATHERLESS_DEFAULT_MODEL_ID,
    });

    expect(policy).toMatchObject({
      sanitizeToolCallIds: true,
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });
    expect(policy).not.toHaveProperty("dropReasoningFromHistory");
  });
});
