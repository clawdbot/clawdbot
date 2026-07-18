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
  it("ships the exact 14-model Global catalog through manifest and runtime", () => {
    const provider = buildQwenTokenPlanProvider();
    const modelIds = provider.models.map((model) => model.id);

    expect(provider.baseUrl).toBe(QWEN_TOKEN_PLAN_GLOBAL_BASE_URL);
    expect(provider.api).toBe("openai-completions");
    expect(modelIds).toEqual([
      "qwen3.7-max",
      QWEN_TOKEN_PLAN_DEFAULT_MODEL_ID,
      "qwen3.6-plus",
      "qwen3.6-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "deepseek-v3.2",
      "kimi-k2.7-code",
      "kimi-k2.6",
      "kimi-k2.5",
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "MiniMax-M2.5",
    ]);
    expect(provider.models.every((model) => model.reasoning)).toBe(true);
    expect(manifest.modelCatalog.providers["qwen-token-plan"].models).toEqual(provider.models);
    expect(manifest.modelCatalog.discovery["qwen-token-plan"]).toBe("static");
  });

  it("uses region-scoped endpoints with the documented GLM 5.2 window", () => {
    expect(resolveQwenTokenPlanBaseUrl("global")).toBe(QWEN_TOKEN_PLAN_GLOBAL_BASE_URL);
    expect(resolveQwenTokenPlanBaseUrl("cn")).toBe(QWEN_TOKEN_PLAN_CN_BASE_URL);

    const globalProvider = buildQwenTokenPlanProvider();
    const cnProvider = buildQwenTokenPlanProvider({ baseUrl: QWEN_TOKEN_PLAN_CN_BASE_URL });
    expect(globalProvider.models.find((model) => model.id === "glm-5.2")?.contextWindow).toBe(
      1_000_000,
    );
    expect(cnProvider.models.find((model) => model.id === "glm-5.2")?.contextWindow).toBe(
      1_000_000,
    );
  });

  it("uses current model limits instead of the stale contributor catalog", () => {
    const provider = buildQwenTokenPlanProvider();

    expect(provider.models.find((model) => model.id === "qwen3.6-flash")?.maxTokens).toBe(65_536);
    expect(provider.models.find((model) => model.id === "deepseek-v4-pro")).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 393_216,
    });
    expect(provider.models.find((model) => model.id === "kimi-k2.7-code")?.maxTokens).toBe(98_304);
    expect(provider.models.find((model) => model.id === "MiniMax-M2.5")).toMatchObject({
      contextWindow: 196_608,
      maxTokens: 32_768,
    });
  });

  it.each([QWEN_TOKEN_PLAN_GLOBAL_BASE_URL, QWEN_TOKEN_PLAN_CN_BASE_URL])(
    "opts Token Plan endpoint %s into native streaming usage",
    (baseUrl) => {
      const provider = applyQwenNativeStreamingUsageCompat(buildQwenTokenPlanProvider({ baseUrl }));
      expect(provider.models).toHaveLength(14);
      expect(
        provider.models.every((model) => model.compat?.supportsUsageInStreaming === true),
      ).toBe(true);
    },
  );
});
