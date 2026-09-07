import { describe, expect, it } from "vitest";
import { resolveImageGenerationMaxInputImages } from "./capabilities.js";
import type { ImageGenerationProvider } from "./types.js";

function createProvider(): ImageGenerationProvider {
  return {
    id: "test",
    capabilities: {
      generate: {},
      edit: {
        enabled: true,
        maxInputImages: 1,
        maxInputImagesByModel: {
          "family/pro/edit": 12,
        },
        maxInputImagesByModelPrefix: {
          family: 5,
          "family/pro": 10,
        },
      },
    },
    async generateImage() {
      throw new Error("not used");
    },
  };
}

describe("resolveImageGenerationMaxInputImages", () => {
  it("prefers exact limits, then the longest prefix, then the provider default", () => {
    const provider = createProvider();

    expect(resolveImageGenerationMaxInputImages({ provider, model: "family/pro/edit" })).toBe(12);
    expect(resolveImageGenerationMaxInputImages({ provider, model: "family/pro/v2" })).toBe(10);
    expect(resolveImageGenerationMaxInputImages({ provider, model: "family/basic" })).toBe(5);
    expect(resolveImageGenerationMaxInputImages({ provider, model: "other" })).toBe(1);
  });
});
