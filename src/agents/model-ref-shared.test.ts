import { describe, expect, it } from "vitest";
import {
  normalizeConfiguredProviderCatalogModelId,
  normalizeStaticProviderModelId,
} from "./model-ref-shared.js";

describe("normalizeStaticProviderModelId", () => {
  it("re-adds the nvidia prefix for bare model ids", () => {
    expect(normalizeStaticProviderModelId("nvidia", "nemotron-3-super-120b-a12b")).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
  });

  it("does not double-prefix already prefixed models", () => {
    expect(normalizeStaticProviderModelId("nvidia", "nvidia/nemotron-3-super-120b-a12b")).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
  });

  it("keeps OpenRouter bare compatibility ids provider-qualified without manifest lookup", () => {
    expect(
      normalizeStaticProviderModelId("openrouter", "auto", {
        allowManifestNormalization: false,
      }),
    ).toBe("openrouter/auto");
  });

  it("normalizes retired XAI beta ids without manifest lookup", () => {
    expect(
      normalizeStaticProviderModelId("xai", "grok-4.20-experimental-beta-0304-reasoning", {
        allowManifestNormalization: false,
      }),
    ).toBe("grok-4.20-beta-latest-reasoning");
  });

  it("normalizes the shipped retired Together default without manifest lookup", () => {
    expect(
      normalizeStaticProviderModelId("together", "moonshotai/Kimi-K2.5", {
        allowManifestNormalization: false,
      }),
    ).toBe("moonshotai/Kimi-K2.6");
  });
});

describe("normalizeConfiguredProviderCatalogModelId", () => {
  const manifestPlugins = [
    {
      modelIdNormalization: {
        providers: {
          custom: {
            aliases: {
              latest: "modern-model",
            },
            prefixWhenBare: "vendor",
          },
        },
      },
    },
  ];

  it("applies supplied manifest normalization policies to configured catalog ids", () => {
    expect(normalizeConfiguredProviderCatalogModelId("custom", "latest", { manifestPlugins })).toBe(
      "vendor/modern-model",
    );
  });

  it("can skip manifest normalization while retaining built-in normalization", () => {
    expect(
      normalizeConfiguredProviderCatalogModelId("custom", "latest", {
        allowManifestNormalization: false,
        manifestPlugins,
      }),
    ).toBe("latest");
  });

  it("normalizes nested retired Google Gemini ids in proxy-prefixed rows", () => {
    expect(
      normalizeConfiguredProviderCatalogModelId("kilocode", "kilocode/google/gemini-3-pro-preview"),
    ).toBe("kilocode/google/gemini-3.1-pro-preview");
  });
});
