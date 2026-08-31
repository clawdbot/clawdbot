import { buildOpenAICompatibleLiveModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
// Qwen tests cover provider catalog plugin behavior.
import { describe, expect, it } from "vitest";
import {
  applyQwenNativeStreamingUsageCompat,
  buildQwenProvider,
  buildQwenTokenPlanProvider,
  QWEN_BASE_URL,
  QWEN_36_FLASH_MODEL_ID,
  QWEN_37_MAX_MODEL_ID,
  QWEN_37_PLUS_MODEL_ID,
  QWEN_STANDARD_GLOBAL_BASE_URL,
  QWEN_DEFAULT_MODEL_ID,
  QWEN_TOKEN_PLAN_CN_BASE_URL,
  QWEN_TOKEN_PLAN_DEFAULT_MODEL_ID,
  QWEN_TOKEN_PLAN_GLOBAL_BASE_URL,
  resolveQwenTokenPlanBaseUrl,
} from "./api.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

type QwenProvider = ReturnType<typeof buildQwenProvider>;

function getQwenModelIds(provider: QwenProvider): string[] {
  return provider.models.map((model) => model.id);
}

describe("qwen provider catalog", () => {
  it("builds the bundled Qwen provider defaults", () => {
    const provider = buildQwenProvider();

    expect(provider.baseUrl).toBe(QWEN_BASE_URL);
    expect(provider.api).toBe("openai-completions");
    const modelIds = getQwenModelIds(provider);
    expect(modelIds.length).toBeGreaterThan(0);
    expect(modelIds).toContain(QWEN_DEFAULT_MODEL_ID);
    expect(modelIds).not.toContain(QWEN_36_FLASH_MODEL_ID);
    expect(modelIds).toContain("qwen3.6-plus");
    expect(modelIds).not.toContain(QWEN_37_MAX_MODEL_ID);
    expect(modelIds).toContain(QWEN_37_PLUS_MODEL_ID);
  });

  it("only advertises Standard-only Qwen models on Standard endpoints", () => {
    const coding = buildQwenProvider({ baseUrl: QWEN_BASE_URL });
    const codingTrailingDot = buildQwenProvider({
      baseUrl: " https://coding-intl.dashscope.aliyuncs.com./v1 ",
    });
    const standard = buildQwenProvider({ baseUrl: QWEN_STANDARD_GLOBAL_BASE_URL });

    expect(getQwenModelIds(coding)).toContain("qwen3.6-plus");
    expect(getQwenModelIds(codingTrailingDot)).toContain("qwen3.6-plus");
    expect(getQwenModelIds(standard)).toContain("qwen3.6-plus");
    expect(getQwenModelIds(coding)).not.toContain(QWEN_36_FLASH_MODEL_ID);
    expect(getQwenModelIds(codingTrailingDot)).not.toContain(QWEN_36_FLASH_MODEL_ID);
    expect(getQwenModelIds(coding)).not.toContain(QWEN_37_MAX_MODEL_ID);
    expect(getQwenModelIds(coding)).toContain(QWEN_37_PLUS_MODEL_ID);
    expect(coding.models.find((model) => model.id === "qwen3.6-plus")?.reasoning).toBe(true);

    expect(standard.models.find((model) => model.id === QWEN_36_FLASH_MODEL_ID)).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    });
    expect(standard.models.find((model) => model.id === QWEN_37_MAX_MODEL_ID)).toMatchObject({
      reasoning: true,
      input: ["text"],
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    });
    expect(standard.models.find((model) => model.id === QWEN_37_PLUS_MODEL_ID)).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    });
    for (const id of ["qwen3.8-max", "qwen3.8-flash"]) {
      expect(getQwenModelIds(coding)).not.toContain(id);
      expect(getQwenModelIds(codingTrailingDot)).not.toContain(id);
      expect(standard.models.find((model) => model.id === id)).toMatchObject({
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        maxTokens: 131_072,
      });
    }
  });

  it("opts native Qwen baseUrls into streaming usage only inside the extension", () => {
    const nativeProvider = applyQwenNativeStreamingUsageCompat(buildQwenProvider());
    expect(nativeProvider.models.length).toBeGreaterThan(0);
    expect(
      nativeProvider.models.every((model) => {
        if (!model.compat) {
          throw new Error(`expected Qwen model ${model.id} compat`);
        }
        return model.compat.supportsUsageInStreaming === true;
      }),
    ).toBe(true);

    const customProvider = applyQwenNativeStreamingUsageCompat({
      ...buildQwenProvider(),
      baseUrl: "https://proxy.example.com/v1",
    });
    expect(
      customProvider.models.some(
        (model) => model.compat && model.compat.supportsUsageInStreaming === true,
      ),
    ).toBe(false);
  });
});

describe("qwen token plan provider catalog", () => {
  it("advertises current plan models while retaining the deprecated compatibility row", () => {
    const provider = buildQwenTokenPlanProvider();
    const models = provider.models;
    const modelIds = models.map((model) => model.id);

    expect(provider.baseUrl).toBe(QWEN_TOKEN_PLAN_GLOBAL_BASE_URL);
    expect(provider.api).toBe("openai-completions");
    expect(modelIds).toEqual([
      QWEN_TOKEN_PLAN_DEFAULT_MODEL_ID,
      "qwen3.8-max",
      "qwen3.8-flash",
      "qwen3.6-plus",
      "qwen3-coder-next",
      "kimi-k2.5",
      "glm-5",
      "MiniMax-M2.5",
    ]);
    const manifestModels = manifest.modelCatalog.providers["qwen-token-plan"].models as Array<
      Record<string, unknown>
    >;
    expect(manifestModels.find((model) => model.id === "qwen3-coder-next")).toMatchObject({
      status: "deprecated",
      replacedBy: QWEN_TOKEN_PLAN_DEFAULT_MODEL_ID,
    });
    expect(models.every((model) => model.reasoning)).toBe(true);
    expect(manifestModels.map((model) => model.id)).toEqual(modelIds);
    expect(manifest.modelCatalog.discovery["qwen-token-plan"]).toBe("refreshable");
  });

  it("uses region-scoped endpoints with the documented Qwen3.7-Plus window", () => {
    expect(resolveQwenTokenPlanBaseUrl("global")).toBe(QWEN_TOKEN_PLAN_GLOBAL_BASE_URL);
    expect(resolveQwenTokenPlanBaseUrl("cn")).toBe(QWEN_TOKEN_PLAN_CN_BASE_URL);

    const globalProvider = buildQwenTokenPlanProvider();
    const cnProvider = buildQwenTokenPlanProvider({ baseUrl: QWEN_TOKEN_PLAN_CN_BASE_URL });
    expect(globalProvider.models.find((model) => model.id === "qwen3.7-plus")?.contextWindow).toBe(
      1_000_000,
    );
    expect(cnProvider.models.find((model) => model.id === "qwen3.7-plus")?.contextWindow).toBe(
      1_000_000,
    );
  });

  it("uses current model limits instead of the stale contributor catalog", () => {
    const models = buildQwenTokenPlanProvider().models;

    expect(models.find((model) => model.id === "qwen3-coder-next")).toMatchObject({
      contextWindow: 262_144,
      maxTokens: 65_536,
    });
    expect(models.find((model) => model.id === "kimi-k2.5")?.maxTokens).toBe(98_304);
    expect(models.find((model) => model.id === "MiniMax-M2.5")).toMatchObject({
      contextWindow: 196_608,
      maxTokens: 32_768,
    });
  });

  it.each([QWEN_TOKEN_PLAN_GLOBAL_BASE_URL, QWEN_TOKEN_PLAN_CN_BASE_URL])(
    "opts Token Plan endpoint %s into native streaming usage",
    (baseUrl) => {
      const provider = applyQwenNativeStreamingUsageCompat(buildQwenTokenPlanProvider({ baseUrl }));
      expect(provider.models.map((model) => model.id)).toEqual(
        expect.arrayContaining(["qwen3.8-max", "qwen3.8-flash"]),
      );
      expect(
        provider.models.every((model) => model.compat?.supportsUsageInStreaming === true),
      ).toBe(true);
    },
  );
});

it.each(["qwen", "qwen-token-plan"])(
  "keeps %s flagship metadata while discovering uncurated models",
  async (providerId) => {
    const providerConfig =
      providerId === "qwen"
        ? buildQwenProvider({ baseUrl: QWEN_STANDARD_GLOBAL_BASE_URL })
        : buildQwenTokenPlanProvider();
    const provider = await buildOpenAICompatibleLiveModelProviderConfig({
      providerId,
      providerConfig,
      apiKey: `discovery-${providerId}`,
      fetchGuard: async ({ url }) => ({
        response: new Response(
          JSON.stringify({
            data: [
              { id: "qwen3.8-max" },
              { id: "qwen3.8-flash" },
              {
                id: "qwen3.8-27b",
                reasoning: true,
                input: ["text", "image"],
                context_window: 1_000_000,
                max_output_tokens: 131_072,
              },
            ],
          }),
        ),
        finalUrl: url,
        release: async () => {},
      }),
    });
    expect(provider.models.map((model) => model.id)).toEqual([
      "qwen3.8-27b",
      "qwen3.8-flash",
      "qwen3.8-max",
    ]);
    for (const model of provider.models) {
      expect(model).toMatchObject({
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        maxTokens: 131_072,
      });
    }
    expect(providerConfig.models.some((model) => model.id === "qwen3.8-27b")).toBe(false);
  },
);
