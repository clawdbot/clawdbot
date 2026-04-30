import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginManifestRegistryForPluginRegistry: vi.fn(),
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: mocks.loadPluginManifestRegistryForPluginRegistry,
}));

import {
  buildManifestBuiltInModelSuppressionResolver,
  clearManifestModelSuppressionCacheForTest,
  resolveManifestBuiltInModelSuppression,
} from "./manifest-model-suppression.js";

describe("manifest model suppression", () => {
  beforeEach(() => {
    clearManifestModelSuppressionCacheForTest();
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReset();
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "openai",
          providers: ["openai"],
          modelCatalog: {
            aliases: {
              "azure-openai-responses": {
                provider: "openai",
              },
            },
            suppressions: [
              {
                provider: "azure-openai-responses",
                model: "gpt-5.3-codex-spark",
                reason: "Use openai/gpt-5.5.",
              },
              {
                provider: "openrouter",
                model: "foreign-row",
              },
            ],
          },
        },
      ],
    });
  });

  describe("buildManifestBuiltInModelSuppressionResolver", () => {
    it("reads planned manifest suppressions once per resolver creation", () => {
      const config = { plugins: { entries: { openai: { enabled: true } } } };

      const resolver = buildManifestBuiltInModelSuppressionResolver({
        config,
        env: process.env,
      });

      expect(mocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledTimes(1);

      resolver({
        provider: "azure-openai-responses",
        id: "gpt-5.3-codex-spark",
      });
      resolver({
        provider: "azure-openai-responses",
        id: "gpt-5.3-codex-spark",
      });

      expect(mocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledTimes(1);
    });
  });

  it("resolves manifest suppressions for declared provider aliases", () => {
    expect(
      resolveManifestBuiltInModelSuppression({
        provider: "azure-openai-responses",
        id: "GPT-5.3-Codex-Spark",
        env: process.env,
      }),
    ).toEqual({
      suppress: true,
      errorMessage:
        "Unknown model: azure-openai-responses/gpt-5.3-codex-spark. Use openai/gpt-5.5.",
    });
  });

  it("ignores suppressions for providers the plugin does not own", () => {
    expect(
      resolveManifestBuiltInModelSuppression({
        provider: "openrouter",
        id: "foreign-row",
        env: process.env,
      }),
    ).toBeUndefined();
  });

  it("reads planned manifest suppressions fresh per lookup", () => {
    const config = { plugins: { entries: { openai: { enabled: true } } } };

    resolveManifestBuiltInModelSuppression({
      provider: "azure-openai-responses",
      id: "gpt-5.3-codex-spark",
      config,
      env: process.env,
    });
    resolveManifestBuiltInModelSuppression({
      provider: "azure-openai-responses",
      id: "gpt-5.3-codex-spark",
      config,
      env: process.env,
    });

    expect(mocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledTimes(2);
  });

  it("reuses planned manifest suppressions inside a resolver instance", () => {
    const config = { plugins: { entries: { openai: { enabled: true } } } };

    const resolver = buildManifestBuiltInModelSuppressionResolver({
      config,
      env: process.env,
    });

    expect(
      resolver({
        provider: "azure-openai-responses",
        id: "gpt-5.3-codex-spark",
      })?.suppress,
    ).toBe(true);
    expect(
      resolver({
        provider: "azure-openai-responses",
        id: "gpt-4.1",
      }),
    ).toBeUndefined();
    expect(mocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledTimes(1);
  });

  it("matches conditional suppressions by base URL host", () => {
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "qwen",
          providers: ["qwen", "modelstudio"],
          modelCatalog: {
            suppressions: [
              {
                provider: "qwen",
                model: "qwen3.6-plus",
                reason: "Use qwen/qwen3.5-plus.",
                when: {
                  baseUrlHosts: [
                    "coding.dashscope.aliyuncs.com",
                    "coding-intl.dashscope.aliyuncs.com",
                  ],
                  providerConfigApiIn: ["qwen", "modelstudio"],
                },
              },
            ],
          },
        },
      ],
    });

    expect(
      resolveManifestBuiltInModelSuppression({
        provider: "qwen",
        id: "qwen3.6-plus",
        baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
        env: process.env,
      })?.suppress,
    ).toBe(true);
    expect(
      resolveManifestBuiltInModelSuppression({
        provider: "qwen",
        id: "qwen3.6-plus",
        baseUrl: " https://coding-intl.dashscope.aliyuncs.com./v1 ",
        env: process.env,
      })?.suppress,
    ).toBe(true);
    expect(
      resolveManifestBuiltInModelSuppression({
        provider: "qwen",
        id: "qwen3.6-plus",
        baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        env: process.env,
      }),
    ).toBeUndefined();
  });

  it("does not apply conditional suppressions to custom providers with a foreign api owner", () => {
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "qwen",
          providers: ["modelstudio"],
          modelCatalog: {
            suppressions: [
              {
                provider: "modelstudio",
                model: "qwen3.6-plus",
                when: {
                  baseUrlHosts: ["coding-intl.dashscope.aliyuncs.com"],
                  providerConfigApiIn: ["qwen", "modelstudio"],
                },
              },
            ],
          },
        },
      ],
    });

    expect(
      resolveManifestBuiltInModelSuppression({
        provider: "modelstudio",
        id: "qwen3.6-plus",
        config: {
          models: {
            providers: {
              modelstudio: {
                api: "openai-completions",
                baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
                models: [],
              },
            },
          },
        },
        env: process.env,
      }),
    ).toBeUndefined();
  });
});
