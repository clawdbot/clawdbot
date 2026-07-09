// Qwen tests cover provider catalog plugin behavior.
import { describe, expect, it } from "vitest";
import {
  applyQwenNativeStreamingUsageCompat,
  buildQwenProvider,
  QWEN_BASE_URL,
  QWEN_36_FLASH_MODEL_ID,
  QWEN_37_MAX_MODEL_ID,
  QWEN_37_PLUS_MODEL_ID,
  QWEN_STANDARD_GLOBAL_BASE_URL,
  QWEN_DEFAULT_MODEL_ID,
} from "./api.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildQwenOAuthProvider } from "./provider-catalog.js";

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

  it("keeps unsupported Qwen models out of the portal catalog", () => {
    const portal = buildQwenOAuthProvider();
    const portalQwen36 = portal.models.find((model) => model.id === "qwen3.6-plus");
    const manifestQwen36 = manifest.modelCatalog.providers["qwen-oauth"].models.find(
      (model) => model.id === "qwen3.6-plus",
    );

    expect(getQwenModelIds(portal)).not.toContain(QWEN_36_FLASH_MODEL_ID);
    expect(
      manifest.modelCatalog.providers["qwen-oauth"].models.map((model) => model.id),
    ).not.toContain(QWEN_36_FLASH_MODEL_ID);
    expect(getQwenModelIds(portal)).not.toContain(QWEN_37_MAX_MODEL_ID);
    expect(getQwenModelIds(portal)).not.toContain(QWEN_37_PLUS_MODEL_ID);
    expect(portalQwen36?.reasoning).toBe(true);
    expect(manifestQwen36?.reasoning).toBe(portalQwen36?.reasoning);
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
