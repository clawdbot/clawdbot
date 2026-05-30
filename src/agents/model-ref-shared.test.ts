import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "../plugins/current-plugin-metadata-snapshot.js";
import {
  normalizeConfiguredProviderCatalogModelId,
  normalizeStaticProviderModelId,
} from "./model-ref-shared.js";

beforeEach(() => {
  clearCurrentPluginMetadataSnapshot();
});

afterEach(() => {
  clearCurrentPluginMetadataSnapshot();
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
    expect(normalizeStaticProviderModelId("anthropic", "sonnet-4.6")).toBe("claude-sonnet-4-6");
    expect(normalizeStaticProviderModelId("vercel-ai-gateway", "sonnet-4.6")).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(normalizeStaticProviderModelId("huggingface", "huggingface/vendor/model")).toBe(
      "vendor/model",
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

  it("uses current plugin metadata manifest normalization by default", () => {
    setCurrentPluginMetadataSnapshot(
      {
        policyHash: "test-policy",
        index: {
          version: 1,
          hostContractVersion: "test",
          compatRegistryVersion: "test",
          migrationVersion: 1,
          policyHash: "test-policy",
          generatedAtMs: 0,
          installRecords: {},
          plugins: [],
          diagnostics: [],
        },
        plugins: [
          {
            modelIdNormalization: {
              providers: {
                custom: {
                  aliases: { latest: "custom/modern-model" },
                },
              },
            },
          },
        ],
        registryDiagnostics: [],
        manifestRegistry: { plugins: [] },
        diagnostics: [],
        byPluginId: new Map(),
        normalizePluginId: (pluginId: string) => pluginId,
        owners: {
          channels: new Map(),
          channelConfigs: new Map(),
          providers: new Map(),
          modelCatalogProviders: new Map(),
          cliBackends: new Map(),
          setupProviders: new Map(),
          commandAliases: new Map(),
          contracts: new Map(),
        },
        metrics: {
          registrySnapshotMs: 0,
          manifestRegistryMs: 0,
          ownerMapsMs: 0,
          totalMs: 0,
          indexPluginCount: 0,
          manifestPluginCount: 1,
        },
      } as never,
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
