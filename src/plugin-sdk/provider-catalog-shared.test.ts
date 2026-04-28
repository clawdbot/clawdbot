import { describe, expect, it } from "vitest";
import type { ModelCatalogProvider } from "../model-catalog/types.js";
import {
  applyProviderNativeStreamingUsageCompat,
  buildManifestModelProviderConfig,
  readConfiguredProviderCatalogEntries,
  supportsNativeStreamingUsageCompat,
} from "./provider-catalog-shared.js";
import type { ModelDefinitionConfig } from "./provider-model-shared.js";

function buildModel(id: string, supportsUsageInStreaming?: boolean): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1024,
    maxTokens: 1024,
    ...(supportsUsageInStreaming === undefined ? {} : { compat: { supportsUsageInStreaming } }),
  };
}

describe("provider-catalog-shared native streaming usage compat", () => {
  it("detects native streaming usage compat from the endpoint capabilities", () => {
    expect(
      supportsNativeStreamingUsageCompat({
        providerId: "custom-qwen",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      }),
    ).toBe(true);
    expect(
      supportsNativeStreamingUsageCompat({
        providerId: "custom-kimi",
        baseUrl: "https://api.moonshot.ai/v1",
      }),
    ).toBe(true);
    expect(
      supportsNativeStreamingUsageCompat({
        providerId: "custom-proxy",
        baseUrl: "https://proxy.example.com/v1",
      }),
    ).toBe(false);
  });

  it("opts models into streaming usage for native endpoints while preserving explicit overrides", () => {
    const provider = applyProviderNativeStreamingUsageCompat({
      providerId: "custom-qwen",
      providerConfig: {
        api: "openai-completions",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        models: [buildModel("qwen-plus"), buildModel("qwen-max", false)],
      },
    });

    expect(provider.models?.[0]?.compat?.supportsUsageInStreaming).toBe(true);
    expect(provider.models?.[1]?.compat?.supportsUsageInStreaming).toBe(false);
  });
});

describe("provider-catalog-shared configured catalog entries", () => {
  it("preserves configured audio and video input modalities", () => {
    expect(
      readConfiguredProviderCatalogEntries({
        providerId: "kilocode",
        config: {
          models: {
            providers: {
              kilocode: {
                baseUrl: "https://api.kilo.ai/api/gateway/",
                api: "openai-completions",
                models: [
                  {
                    id: "google/gemini-3-pro-preview",
                    name: "Gemini 3 Pro Preview",
                    input: ["text", "image", "video", "audio"],
                    reasoning: true,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 1048576,
                    maxTokens: 65536,
                  },
                ],
              },
            },
          },
        },
      }),
    ).toEqual([
      {
        provider: "kilocode",
        id: "google/gemini-3-pro-preview",
        name: "Gemini 3 Pro Preview",
        input: ["text", "image", "video", "audio"],
        reasoning: true,
        contextWindow: 1048576,
      },
    ]);
  });
});

describe("provider-catalog-shared manifest provider configs", () => {
  it("converts manifest model catalog rows into provider config rows", () => {
    const catalog: ModelCatalogProvider = {
      baseUrl: "https://api.example.test/v1",
      api: "openai-completions",
      headers: { "x-provider": "example" },
      models: [
        {
          id: "example-model",
          name: "Example Model",
          input: ["text", "image"],
          reasoning: true,
          contextWindow: 128_000,
          contextTokens: 64_000,
          maxTokens: 8192,
          cost: {
            input: 1,
            output: 2,
            cacheRead: 0.25,
            cacheWrite: 0.5,
            tieredPricing: [
              {
                input: 0.5,
                output: 1,
                cacheRead: 0.1,
                cacheWrite: 0.2,
                range: [0, 1_000_000],
              },
            ],
          },
          compat: { supportsUsageInStreaming: true },
        },
      ],
    };

    expect(buildManifestModelProviderConfig({ providerId: "example", catalog })).toEqual({
      baseUrl: "https://api.example.test/v1",
      api: "openai-completions",
      headers: { "x-provider": "example" },
      models: [
        {
          id: "example-model",
          name: "Example Model",
          reasoning: true,
          input: ["text", "image"],
          cost: {
            input: 1,
            output: 2,
            cacheRead: 0.25,
            cacheWrite: 0.5,
            tieredPricing: [
              {
                input: 0.5,
                output: 1,
                cacheRead: 0.1,
                cacheWrite: 0.2,
                range: [0, 1_000_000],
              },
            ],
          },
          contextWindow: 128_000,
          contextTokens: 64_000,
          maxTokens: 8192,
          compat: { supportsUsageInStreaming: true },
        },
      ],
    });
  });

  it("rejects incomplete manifest rows before building provider runtime config", () => {
    expect(() =>
      buildManifestModelProviderConfig({
        providerId: "example",
        catalog: {
          baseUrl: "https://api.example.test/v1",
          models: [
            {
              id: "missing-context",
              maxTokens: 8192,
            },
          ],
        },
      }),
    ).toThrow("missing contextWindow");
  });

  it("rejects catalog data that cannot become runtime provider config", () => {
    expect(() =>
      buildManifestModelProviderConfig({
        providerId: "example",
        catalog: {
          models: [
            {
              id: "missing-base-url",
              contextWindow: 1024,
              maxTokens: 1024,
            },
          ],
        },
      }),
    ).toThrow("providers.example.baseUrl");

    expect(() =>
      buildManifestModelProviderConfig({
        providerId: "example",
        catalog: {
          baseUrl: "https://api.example.test/v1",
          models: [
            {
              id: "document-model",
              input: ["document"],
              contextWindow: 1024,
              maxTokens: 1024,
            },
          ],
        },
      }),
    ).toThrow("unsupported runtime input document");
  });

  it("rejects manifest catalogs when normalization drops a model row", () => {
    expect(() =>
      buildManifestModelProviderConfig({
        providerId: "example",
        catalog: {
          baseUrl: "https://api.example.test/v1",
          models: [
            {
              id: "valid",
              contextWindow: 1024,
              maxTokens: 1024,
            },
            {
              id: "",
              contextWindow: 1024,
              maxTokens: 1024,
            },
          ],
        },
      }),
    ).toThrow("providers.example.models");
  });
});
