import { describe, expect, it } from "vitest";
import {
  applyQwenNativeStreamingUsageCompat,
  buildQwenProvider,
  QWEN_BASE_URL,
  QWEN_STANDARD_GLOBAL_BASE_URL,
  QWEN_DEFAULT_MODEL_ID,
} from "./api.js";

describe("qwen provider catalog", () => {
  it("builds the bundled Qwen provider defaults", () => {
    const provider = buildQwenProvider();

    expect(provider.baseUrl).toBe(QWEN_BASE_URL);
    expect(provider.api).toBe("openai-completions");
    expect(provider.models?.length).toBeGreaterThan(0);
    expect(provider.models?.map((model) => model.id)).toContain(QWEN_DEFAULT_MODEL_ID);
    expect(provider.models?.map((model) => model.id)).not.toContain("qwen3.6-plus");
  });

  it("only advertises qwen3.6-plus on Standard endpoints", () => {
    const coding = buildQwenProvider({ baseUrl: QWEN_BASE_URL });
    const codingTrailingDot = buildQwenProvider({
      baseUrl: " https://coding-intl.dashscope.aliyuncs.com./v1 ",
    });
    const standard = buildQwenProvider({ baseUrl: QWEN_STANDARD_GLOBAL_BASE_URL });

    expect(coding.models?.map((model) => model.id)).not.toContain("qwen3.6-plus");
    expect(codingTrailingDot.models?.map((model) => model.id)).not.toContain("qwen3.6-plus");
    expect(standard.models?.map((model) => model.id)).toContain("qwen3.6-plus");
  });

  it("opts native Qwen baseUrls into streaming usage only inside the extension", () => {
    const nativeProvider = applyQwenNativeStreamingUsageCompat(buildQwenProvider());
    expect(
      nativeProvider.models?.every((model) => model.compat?.supportsUsageInStreaming === true),
    ).toBe(true);

    const customProvider = applyQwenNativeStreamingUsageCompat({
      ...buildQwenProvider(),
      baseUrl: "https://proxy.example.com/v1",
    });
    expect(
      customProvider.models?.some((model) => model.compat?.supportsUsageInStreaming === true),
    ).toBe(false);
  });
});
