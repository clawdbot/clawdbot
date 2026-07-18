import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Qwen tests cover index plugin behavior.
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ProviderCatalogResult } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it, vi } from "vitest";
import {
  QWEN_36_FLASH_MODEL_ID,
  QWEN_36_PLUS_MODEL_ID,
  QWEN_37_MAX_MODEL_ID,
  QWEN_37_PLUS_MODEL_ID,
  QWEN_BASE_URL,
  QWEN_TOKEN_PLAN_CN_BASE_URL,
  QWEN_TOKEN_PLAN_GLOBAL_BASE_URL,
  QWEN_TOKEN_PLAN_LEGACY_PROVIDER_ID,
  QWEN_TOKEN_PLAN_PROVIDER_ID,
} from "./api.js";
import qwenPlugin from "./index.js";
import { applyQwenTokenPlanConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { wrapQwenProviderStream } from "./stream.js";

function requireCatalogProvider(result: ProviderCatalogResult): ModelProviderConfig {
  if (!result || !("provider" in result)) {
    throw new Error("single provider catalog result missing");
  }
  return result.provider;
}

async function registerQwenProvider() {
  const { providers } = await registerProviderPlugin({
    plugin: qwenPlugin,
    id: "qwen",
    name: "Qwen Provider",
  });
  return requireRegisteredProvider(providers, "qwen");
}

describe("qwen provider plugin", () => {
  it("keeps Standard-only models out of Coding Plan normalized catalogs", async () => {
    const provider = await registerQwenProvider();

    const normalized = provider.normalizeConfig?.({
      provider: "qwen",
      providerConfig: {
        baseUrl: QWEN_BASE_URL,
        models: [
          { id: "qwen3.5-plus" },
          { id: QWEN_36_FLASH_MODEL_ID },
          { id: QWEN_36_PLUS_MODEL_ID },
          { id: QWEN_37_MAX_MODEL_ID },
          { id: QWEN_37_PLUS_MODEL_ID },
        ],
      },
    } as never);

    expect(normalized?.models?.map((model) => model.id)).toEqual([
      "qwen3.5-plus",
      QWEN_36_PLUS_MODEL_ID,
      QWEN_37_PLUS_MODEL_ID,
    ]);
  });

  it("does not expose runtime model suppression hooks", async () => {
    const provider = await registerQwenProvider();

    expect(provider.suppressBuiltInModel).toBeUndefined();
  });

  it("does not register retired Qwen Portal providers", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: qwenPlugin,
      id: "qwen",
      name: "Qwen Provider",
    });
    const retiredProviderIds = ["qwen-oauth", "qwen-portal", "qwen-cli"];

    expect(providers.map((provider) => provider.id)).not.toEqual(
      expect.arrayContaining(retiredProviderIds),
    );
    expect(manifest.providers).not.toEqual(expect.arrayContaining(retiredProviderIds));
    expect(manifest.modelCatalog.providers).not.toHaveProperty("qwen-oauth");
  });

  it("registers canonical and legacy Token Plan owners without catalog aliasing", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: qwenPlugin,
      id: "qwen",
      name: "Qwen Provider",
    });
    const provider = requireRegisteredProvider(providers, "qwen-token-plan");

    expect(provider.aliases).toBeUndefined();
    expect(provider.envVars).toEqual(["QWEN_TOKEN_PLAN_API_KEY"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key", "api-key-cn"]);

    const runtimeChoiceIds = (provider.auth ?? [])
      .map((method) => method.wizard?.choiceId)
      .filter((id): id is string => typeof id === "string")
      .toSorted();
    const manifestChoiceIds = manifest.providerAuthChoices
      .filter((choice) => choice.provider === "qwen-token-plan")
      .map((choice) => choice.choiceId)
      .toSorted();
    expect(runtimeChoiceIds).toEqual(["qwen-token-plan", "qwen-token-plan-cn"]);
    expect(manifestChoiceIds).toEqual(runtimeChoiceIds);

    const result = await provider.staticCatalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({}),
    } as never);
    const catalogProvider = requireCatalogProvider(result);
    expect(catalogProvider.baseUrl).toBe(QWEN_TOKEN_PLAN_GLOBAL_BASE_URL);
    expect(catalogProvider.models).toHaveLength(14);

    const legacy = requireRegisteredProvider(providers, QWEN_TOKEN_PLAN_LEGACY_PROVIDER_ID);
    expect(legacy.auth).toEqual([]);
    expect(legacy.catalog).toBeUndefined();
    expect(legacy.staticCatalog).toBeUndefined();
    expect(legacy.wrapStreamFn).toBe(wrapQwenProviderStream);
    expect(legacy.resolveThinkingProfile).toBeUndefined();
  });

  it("does not reinterpret exact legacy Anthropic config as canonical configuration", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: qwenPlugin,
      id: "qwen",
      name: "Qwen Provider",
    });
    const provider = requireRegisteredProvider(providers, QWEN_TOKEN_PLAN_PROVIDER_ID);

    const result = await provider.catalog?.run({
      config: {
        models: {
          providers: {
            [QWEN_TOKEN_PLAN_LEGACY_PROVIDER_ID]: {
              api: "anthropic-messages",
              baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
              apiKey: "legacy-inline-key",
              models: [{ id: "qwen3.7-plus" }],
            },
          },
        },
      },
      env: {},
      resolveProviderApiKey: (providerId: string) =>
        providerId === QWEN_TOKEN_PLAN_PROVIDER_ID ? { apiKey: "canonical-key" } : {},
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    } as never);

    expect(requireCatalogProvider(result)).toMatchObject({
      api: "openai-completions",
      apiKey: "canonical-key",
      baseUrl: QWEN_TOKEN_PLAN_GLOBAL_BASE_URL,
    });
  });

  it.each([
    {
      [QWEN_TOKEN_PLAN_LEGACY_PROVIDER_ID]: {
        baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
        models: [{ id: "legacy-only" }],
      },
      [QWEN_TOKEN_PLAN_PROVIDER_ID]: { baseUrl: QWEN_TOKEN_PLAN_CN_BASE_URL },
    },
    {
      [QWEN_TOKEN_PLAN_PROVIDER_ID]: { baseUrl: QWEN_TOKEN_PLAN_CN_BASE_URL },
      [QWEN_TOKEN_PLAN_LEGACY_PROVIDER_ID]: {
        baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
        models: [{ id: "legacy-only" }],
      },
    },
  ])("uses canonical Token Plan config regardless of provider insertion order", async (entries) => {
    const { providers } = await registerProviderPlugin({
      plugin: qwenPlugin,
      id: "qwen",
      name: "Qwen Provider",
    });
    const provider = requireRegisteredProvider(providers, QWEN_TOKEN_PLAN_PROVIDER_ID);
    const resolveProviderApiKey = vi.fn((providerId: string) =>
      providerId === QWEN_TOKEN_PLAN_PROVIDER_ID ? { apiKey: "canonical-key" } : {},
    );
    const result = await provider.catalog?.run({
      config: { models: { providers: entries } },
      env: {},
      resolveProviderApiKey,
    } as never);

    const catalogProvider = requireCatalogProvider(result);
    expect(catalogProvider).toMatchObject({
      api: "openai-completions",
      apiKey: "canonical-key",
      baseUrl: QWEN_TOKEN_PLAN_CN_BASE_URL,
    });
    expect(catalogProvider.models).toHaveLength(14);
    expect(catalogProvider.models?.map((model) => model.id)).not.toContain("legacy-only");
    expect(resolveProviderApiKey).toHaveBeenCalledTimes(1);
    expect(resolveProviderApiKey).toHaveBeenCalledWith(QWEN_TOKEN_PLAN_PROVIDER_ID);
  });

  it("exposes on-only thinking controls for thinking-only Token Plan models", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: qwenPlugin,
      id: "qwen",
      name: "Qwen Provider",
    });
    const provider = requireRegisteredProvider(providers, QWEN_TOKEN_PLAN_PROVIDER_ID);
    const expected = {
      levels: [{ id: "low", label: "on" }],
      defaultLevel: "low",
      preserveWhenCatalogReasoningFalse: true,
    };

    expect(provider.resolveThinkingProfile?.({ modelId: "kimi-k2.7-code" } as never)).toEqual(
      expected,
    );
    expect(provider.resolveThinkingProfile?.({ modelId: "MiniMax-M2.5" } as never)).toEqual(
      expected,
    );
    expect(provider.resolveThinkingProfile?.({ modelId: "qwen3.7-plus" } as never)).toBeUndefined();
    expect(provider.resolveThinkingProfile?.({ modelId: "deepseek-v4-pro" } as never)).toEqual({
      levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((id) => ({ id })),
      defaultLevel: "high",
    });
    expect(provider.resolveThinkingProfile?.({ modelId: "glm-5.2" } as never)).toEqual({
      levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((id) => ({ id })),
      defaultLevel: "high",
    });
    for (const modelId of ["glm-5.1", "glm-5"]) {
      expect(provider.resolveThinkingProfile?.({ modelId } as never)).toEqual({
        levels: ["off", "minimal", "low", "medium", "high", "xhigh"].map((id) => ({ id })),
        defaultLevel: "high",
      });
    }
  });

  it("switches Token Plan regions without replacing custom catalog rows", () => {
    const initialGlobal = applyQwenTokenPlanConfig({}, "global");
    const globalProvider = initialGlobal.models?.providers?.[QWEN_TOKEN_PLAN_PROVIDER_ID];
    if (!globalProvider) {
      throw new Error("Token Plan provider missing after onboarding");
    }
    const globalModels = [...(globalProvider.models ?? [])];
    const glmIndex = globalModels.findIndex((model) => model.id === "glm-5.2");
    const glmModel = globalModels[glmIndex];
    if (!glmModel) {
      throw new Error("GLM 5.2 missing from Token Plan catalog");
    }
    globalModels[glmIndex] = { ...glmModel, name: "Custom GLM 5.2" };
    globalModels.push({
      id: "custom-model",
      name: "Custom model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 2048,
    });
    const global: OpenClawConfig = {
      ...initialGlobal,
      models: {
        ...initialGlobal.models,
        providers: {
          ...initialGlobal.models?.providers,
          [QWEN_TOKEN_PLAN_PROVIDER_ID]: {
            ...globalProvider,
            models: globalModels,
          },
        },
      },
    };
    const cnFromGlobal = applyQwenTokenPlanConfig(global, "cn");
    const globalAgain = applyQwenTokenPlanConfig(cnFromGlobal, "global");

    const tokenPlanProvider = (config: OpenClawConfig) =>
      config.models?.providers?.[QWEN_TOKEN_PLAN_PROVIDER_ID];
    const glmContext = (config: OpenClawConfig) =>
      tokenPlanProvider(config)?.models?.find((model) => model.id === "glm-5.2")?.contextWindow;
    expect(glmContext(global)).toBe(1_000_000);
    expect(glmContext(cnFromGlobal)).toBe(1_000_000);
    expect(glmContext(globalAgain)).toBe(1_000_000);
    expect(tokenPlanProvider(cnFromGlobal)?.baseUrl).toBe(QWEN_TOKEN_PLAN_CN_BASE_URL);
    expect(tokenPlanProvider(globalAgain)?.baseUrl).toBe(QWEN_TOKEN_PLAN_GLOBAL_BASE_URL);
    expect(
      tokenPlanProvider(globalAgain)?.models?.find((model) => model.id === "glm-5.2")?.name,
    ).toBe("Custom GLM 5.2");
    expect(tokenPlanProvider(globalAgain)?.models?.map((model) => model.id)).toContain(
      "custom-model",
    );
    const modelIds = tokenPlanProvider(globalAgain)?.models?.map((model) => model.id) ?? [];
    expect(new Set(modelIds).size).toBe(modelIds.length);
  });
});
