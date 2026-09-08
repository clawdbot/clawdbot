import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../plugin-sdk/plugin-test-runtime.js";
import { loadBundledPluginPublicSurface } from "../../plugin-sdk/test-helpers/public-surface-loader.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { materializePreparedRuntimeModel } from "./materialize-model.js";

describe("Arcee OpenRouter profile materialization", () => {
  it("retains the selected default while materializing its vendor wire id", async () => {
    const plugin = await loadBundledPluginPublicSurface<{
      default: Parameters<typeof registerSingleProviderPlugin>[0];
    }>({ pluginId: "arcee", artifactBasename: "index.js" });
    const provider = await registerSingleProviderPlugin(plugin.default);
    const model: ProviderRuntimeModel = {
      provider: "arcee",
      id: "trinity-large-thinking",
      name: "Trinity Large Thinking",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 32768,
    };
    const materialized = await materializePreparedRuntimeModel({
      provider: "arcee",
      modelId: "trinity-large-thinking",
      model,
      config: {},
      forceResolve: true,
      plan: {
        providerForAuth: "openrouter",
        authProfileProviderForAuth: "openrouter",
        selectedAuthMode: "api-key",
        forwardedAuthProfileId: "openrouter:default",
      },
      resolveModel: async (request) => {
        expect(request.authProfileId).toBe("openrouter:default");
        return {
          model: provider.normalizeResolvedModel?.({ provider: "arcee", modelId: model.id, model }),
        };
      },
    });
    expect(materialized).toMatchObject({
      provider: "arcee",
      id: "arcee-ai/trinity-large-thinking",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("still rejects another model after credential selection", async () => {
    await expect(
      materializePreparedRuntimeModel({
        provider: "arcee",
        modelId: "trinity-large-thinking",
        config: {},
        forceResolve: true,
        plan: {
          providerForAuth: "openrouter",
          authProfileProviderForAuth: "openrouter",
          selectedAuthMode: "api-key",
          forwardedAuthProfileId: "openrouter:default",
        },
        resolveModel: async () => ({
          model: {
            provider: "arcee",
            id: "arcee-ai/trinity-large-preview",
            api: "openai-completions",
            baseUrl: "https://openrouter.ai/api/v1",
          },
        }),
      }),
    ).rejects.toThrow("Unable to rematerialize");
  });
});
