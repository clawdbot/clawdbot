// Documents provider/model id normalization from built-ins and plugin manifests.
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderPlugin } from "../plugins/provider-plugin.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import {
  normalizeConfiguredProviderCatalogModelId,
  normalizeStaticProviderModelId,
} from "./model-ref-shared.js";
import { resolveModelRefWithConfiguredAliases } from "./model-selection-shared.js";
import { normalizeProviderModelIdWithRuntime } from "./provider-model-normalization.runtime.js";

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
            id: "custom",
            modelIdNormalization: {
              providers: {
                custom: {
                  aliases: { latest: "custom/modern-model" },
                },
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

describe("retained provider model normalization", () => {
  it("uses retained and prepared owners without reopening the strict cold facade", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "fixture/input": { alias: "selected" },
            "proxy/proxy/model": { alias: "literal" },
          },
        },
      },
      models: {
        providers: {
          proxy: { api: "ollama", baseUrl: "http://fixture.invalid", models: [] },
        },
      },
    };
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "fixture-owner",
          providers: ["fixture"],
          modelIdNormalization: {
            providers: { fixture: { aliases: { blank: "manifest-model" } } },
          },
        },
      ],
    });
    const hookError = new Error("retained hook failed");
    const normalizeModelId = vi.fn(function (
      this: ProviderPlugin,
      { modelId }: { modelId: string },
    ) {
      if (modelId === "blank") {
        return " ";
      }
      if (modelId === "throw") {
        throw hookError;
      }
      return ` ${this.pluginId}/${modelId} `;
    });
    const provider: ProviderPlugin = {
      id: "fixture",
      label: "Fixture",
      aliases: ["fixture-alias"],
      hookAliases: ["fixture-hook", "ollama"],
      auth: [],
      normalizeModelId,
    };
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.providers.push({
      pluginId: "fixture-owner",
      source: "/tmp/fixture-owner/index.js",
      provider,
    });
    const ambientNormalizer = vi.fn(() => "ambient-model");
    const ambientRegistry = createEmptyPluginRegistry();
    ambientRegistry.providers.push({
      pluginId: "ambient-owner",
      source: "/tmp/ambient-owner/index.js",
      provider: { ...provider, normalizeModelId: ambientNormalizer },
    });
    const preparedPlugin = { ...provider, pluginId: "prepared-owner" };
    const normalize = (providerId = "fixture", modelId = "input", prepared = false) =>
      normalizeProviderModelIdWithRuntime({
        ...(prepared ? { providerPlugin: preparedPlugin } : {}),
        provider: providerId,
        config,
        pluginMetadataSnapshot: metadataSnapshot,
        context: { provider: providerId, modelId },
      });
    const coldError = new Error("strict cold normalization facade entered");
    const tsxApi: typeof import("tsx/cjs/api") = createRequire(import.meta.url)("tsx/cjs/api");
    const coldLoad = vi.spyOn(tsxApi, "require").mockImplementation(() => {
      throw coldError;
    });
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(ambientRegistry);
    try {
      withPluginRuntimeGenerationScope({ config, metadataSnapshot, pluginRegistry }, () => {
        for (const providerId of ["fixture", "fixture-alias", "fixture-hook", "proxy"]) {
          expect(normalize(providerId, "input", true)).toBe("fixture-owner/input");
        }
        expect(normalize("fixture", "blank")).toBe("manifest-model");
        expect(() => normalize("fixture", "throw")).toThrow(hookError);
        expect(provider).not.toHaveProperty("pluginId");
      });
      withPluginRuntimeGenerationScope({ config, metadataSnapshot }, () => {
        expect(normalize("fixture", "blank")).toBe("manifest-model");
        expect(
          normalizeProviderModelIdWithRuntime({
            provider: "fixture",
            pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
            plugins: metadataSnapshot.plugins,
            context: { provider: "fixture", modelId: "blank" },
          }),
        ).toBeUndefined();
      });
      expect(normalizeModelId).toHaveBeenCalledTimes(6);
      expect(ambientNormalizer).not.toHaveBeenCalled();
      expect(coldLoad).not.toHaveBeenCalled();

      expect(normalize("fixture-hook", "input", true)).toBe("prepared-owner/input");
      expect(normalize("proxy", "input", true)).toBe("prepared-owner/input");
      const resolvePreparedAlias = (raw: string) =>
        resolveModelRefWithConfiguredAliases({
          cfg: config,
          raw,
          defaultProvider: provider.id,
          pluginMetadataSnapshot: metadataSnapshot,
          providerPlugin: preparedPlugin,
        });
      expect(resolvePreparedAlias("selected")).toEqual({
        provider: "fixture",
        model: "prepared-owner/input",
      });
      expect(resolvePreparedAlias("literal")).toEqual({ provider: "proxy", model: "proxy/model" });
      expect(normalizeModelId).toHaveBeenCalledTimes(9);
      expect(
        normalizeProviderModelIdWithRuntime({
          provider: "fixture",
          pluginMetadataSnapshot: metadataSnapshot,
          providerPlugin: { ...provider, normalizeModelId: undefined },
          context: { provider: "fixture", modelId: "blank" },
        }),
      ).toBe("manifest-model");
      expect(() => normalize("foreign-provider", "input", true)).toThrow(coldError);

      // Request-only and process registries must still use the strict cold resolver.
      expect(() => withPluginRuntimeRegistryScope(pluginRegistry, () => normalize())).toThrow(
        coldError,
      );
      expect(() => normalize()).toThrow(coldError);
      expect(coldLoad).toHaveBeenCalledTimes(3);
    } finally {
      coldLoad.mockRestore();
      resetPluginRuntimeStateForTest();
    }
  });
});
