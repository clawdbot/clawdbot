import { describe, expect, it } from "vitest";
import {
  applyProviderNativeStreamingUsageCompat,
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
