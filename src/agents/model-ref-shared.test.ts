// Documents provider/model id normalization from built-ins and plugin manifests.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  normalizeConfiguredProviderCatalogModelId,
  normalizeStaticProviderModelId,
} from "./model-ref-shared.js";

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
});

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
});

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

  it("applies shipped bundled provider model aliases without manifest lookup", () => {
    // Shipped aliases must work before plugin metadata is loaded so catalog and
    // config parsing can normalize common refs during startup.
    expect(normalizeStaticProviderModelId("anthropic", "sonnet-4.6")).toBe("claude-sonnet-4-6");
    expect(normalizeStaticProviderModelId("vercel-ai-gateway", "sonnet-4.6")).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(normalizeStaticProviderModelId("huggingface", "huggingface/vendor/model")).toBe(
      "vendor/model",
    );
  });

  it("strips native Anthropic provider prefixes from static catalog ids", () => {
    expect(normalizeStaticProviderModelId("anthropic", "anthropic/claude-haiku-4-5")).toBe(
      "claude-haiku-4-5",
    );
  });

  it("uses supplied manifest normalization policies when provided", () => {
    const manifestPlugins = [
      {
        modelIdNormalization: {
          providers: {
            custom: {
              prefixWhenBare: "vendor",
            },
          },
        },
      },
    ];

    expect(normalizeStaticProviderModelId("custom", "model", { manifestPlugins })).toBe(
      "vendor/model",
    );
  });

  it("keeps OpenRouter bare compatibility ids provider-qualified without manifest lookup", () => {
    expect(
      normalizeStaticProviderModelId("openrouter", "auto", {
        allowManifestNormalization: false,
      }),
    ).toBe("openrouter/auto");
  });

  it("preserves provider-owned XAI beta aliases without manifest lookup", () => {
    expect(
      normalizeStaticProviderModelId("xai", "grok-4.20-experimental-beta-0304-reasoning", {
        allowManifestNormalization: false,
      }),
    ).toBe("grok-4.20-experimental-beta-0304-reasoning");
  });

  it("normalizes the shipped retired Together default without manifest lookup", () => {
    expect(
      normalizeStaticProviderModelId("together", "moonshotai/Kimi-K2.5", {
        allowManifestNormalization: false,
      }),
    ).toBe("moonshotai/Kimi-K2.6");
  });

  it("uses current plugin metadata manifest normalization by default", () => {
    // Runtime callers use the current metadata snapshot by default, so plugin
    // normalization policy applies even without an explicit manifest list.
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "custom-normalizer",
            modelIdNormalization: {
              providers: {
                custom: { aliases: { latest: "custom/modern-model" } },
              },
            },
          },
        ],
      }),
      { config: {} },
    );

    expect(normalizeStaticProviderModelId("custom", "latest")).toBe("custom/modern-model");
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
