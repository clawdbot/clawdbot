// Verifies provider snapshot matching stays cheap for large catalogs.
import { afterEach, describe, expect, it } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { providerConfigMatchesRuntimeSnapshot } from "./model-auth-provider-config.js";

function createModelEntry(index: number): ModelDefinitionConfig {
  return {
    id: `openrouter/model-${index}`,
    name: `Model ${index}`,
    reasoning: index % 2 === 0,
    input: ["text", "image"],
    cost: { input: 1.5, output: 6, cacheRead: 0.15, cacheWrite: 1.5 },
    contextWindow: 128_000,
    maxTokens: 8192,
    headers: { "X-Model-Index": String(index) },
    params: { temperature: 0.7, top_p: 1, frequency_penalty: 0 },
  };
}

function createProviderConfig(
  models: ModelDefinitionConfig[],
  apiKey: string,
): ModelProviderConfig {
  return {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey,
    api: "openai-completions",
    models,
  };
}

function createConfig(params: {
  models?: ModelDefinitionConfig[];
  apiKey?: string;
  extraProviders?: OpenClawConfig["models"];
}): OpenClawConfig {
  return {
    models: {
      providers: {
        openrouter: createProviderConfig(params.models ?? [], params.apiKey ?? "sk-openrouter"),
        openai: createProviderConfig([], "sk-openai"),
        ...params.extraProviders?.providers,
      },
    },
  };
}

function measureMs(run: () => void): number {
  const startedAt = performance.now();
  run();
  return performance.now() - startedAt;
}

describe("providerConfigMatchesRuntimeSnapshot", () => {
  afterEach(() => {
    resetConfigRuntimeState();
  });

  it("matches equivalent small provider snapshots and rejects mismatches", () => {
    const inputConfig = createConfig({ apiKey: "sk-match" });
    const matchingRuntime = createConfig({ apiKey: "sk-match" });
    const mismatchedRuntime = createConfig({ apiKey: "sk-other" });

    expect(
      providerConfigMatchesRuntimeSnapshot({
        inputConfig,
        runtimeConfig: matchingRuntime,
        provider: "openrouter",
      }),
    ).toBe(true);
    expect(
      providerConfigMatchesRuntimeSnapshot({
        inputConfig,
        runtimeConfig: mismatchedRuntime,
        provider: "openrouter",
      }),
    ).toBe(false);
  });

  it("keeps large catalog snapshot matching off the recursive stringify hot path", () => {
    const models = Array.from({ length: 400 }, (_, index) => createModelEntry(index));
    const inputConfig = createConfig({ models, apiKey: "sk-openrouter" });
    const runtimeConfig = createConfig({ models, apiKey: "sk-openrouter" });
    const mismatchedRuntime = createConfig({ models, apiKey: "sk-other" });
    setRuntimeConfigSnapshot(runtimeConfig, inputConfig);

    const params = {
      inputConfig,
      runtimeConfig,
      provider: "openrouter",
    };

    const firstMs = measureMs(() => {
      expect(providerConfigMatchesRuntimeSnapshot(params)).toBe(true);
    });
    expect(
      providerConfigMatchesRuntimeSnapshot({
        inputConfig,
        runtimeConfig: mismatchedRuntime,
        provider: "openrouter",
      }),
    ).toBe(false);

    const repeatedMs = measureMs(() => {
      for (let i = 0; i < 50; i += 1) {
        expect(providerConfigMatchesRuntimeSnapshot(params)).toBe(true);
      }
    });
    expect(firstMs).toBeLessThan(250);
    expect(repeatedMs).toBeLessThan(50);
  });
});
