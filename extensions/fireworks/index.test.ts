import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-auth-choice.runtime.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import fireworksPlugin from "./index.js";
import {
  FIREWORKS_BASE_URL,
  FIREWORKS_DEFAULT_CONTEXT_WINDOW,
  FIREWORKS_DEFAULT_MAX_TOKENS,
  FIREWORKS_DEFAULT_MODEL_ID,
} from "./provider-catalog.js";

function createDynamicContext(params: {
  provider: string;
  modelId: string;
  models: ProviderRuntimeModel[];
}): ProviderResolveDynamicModelContext {
  return {
    provider: params.provider,
    modelId: params.modelId,
    modelRegistry: {
      find(providerId: string, modelId: string) {
        return (
          params.models.find(
            (model) =>
              model.provider === providerId && model.id.toLowerCase() === modelId.toLowerCase(),
          ) ?? null
        );
      },
    } as ModelRegistry,
  };
}

describe("fireworks provider plugin", () => {
  it("registers Fireworks with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "fireworks-api-key",
    });

    expect(provider.id).toBe("fireworks");
    expect(provider.label).toBe("Fireworks");
    expect(provider.aliases).toEqual(["fireworks-ai"]);
    expect(provider.envVars).toEqual(["FIREWORKS_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(resolved?.provider.id).toBe("fireworks");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("builds the Fireworks Fire Pass starter catalog", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const catalog = await provider.catalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      resolveProviderAuth: () => ({
        apiKey: "test-key",
        mode: "api_key",
        source: "env",
      }),
    } as never);

    expect(catalog && "provider" in catalog).toBe(true);
    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected single-provider catalog");
    }

    expect(catalog.provider.api).toBe("openai-completions");
    expect(catalog.provider.baseUrl).toBe(FIREWORKS_BASE_URL);
    expect(catalog.provider.models?.map((model) => model.id)).toEqual([FIREWORKS_DEFAULT_MODEL_ID]);
    expect(catalog.provider.models?.[0]).toMatchObject({
      reasoning: false,
      input: ["text", "image"],
      contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
      maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS,
    });
  });

  it("resolves forward-compat Fireworks model ids from the default template", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createDynamicContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/qwen3.6-plus",
        models: [
          {
            id: FIREWORKS_DEFAULT_MODEL_ID,
            name: FIREWORKS_DEFAULT_MODEL_ID,
            provider: "fireworks",
            api: "openai-completions",
            baseUrl: FIREWORKS_BASE_URL,
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
            maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS,
          },
        ],
      }),
    );

    expect(resolved).toMatchObject({
      provider: "fireworks",
      id: "accounts/fireworks/models/qwen3.6-plus",
      api: "openai-completions",
      baseUrl: FIREWORKS_BASE_URL,
      reasoning: true,
    });
  });

  it("disables reasoning metadata for Fireworks Kimi dynamic models", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createDynamicContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/kimi-k2p5",
        models: [
          {
            id: FIREWORKS_DEFAULT_MODEL_ID,
            name: FIREWORKS_DEFAULT_MODEL_ID,
            provider: "fireworks",
            api: "openai-completions",
            baseUrl: FIREWORKS_BASE_URL,
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
            maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS,
          },
        ],
      }),
    );

    expect(resolved).toMatchObject({
      provider: "fireworks",
      id: "accounts/fireworks/models/kimi-k2p5",
      reasoning: false,
    });
  });

  it("disables reasoning metadata for Fireworks Kimi k2.5 aliases", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createDynamicContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/routers/kimi-k2.5-turbo",
        models: [
          {
            id: FIREWORKS_DEFAULT_MODEL_ID,
            name: FIREWORKS_DEFAULT_MODEL_ID,
            provider: "fireworks",
            api: "openai-completions",
            baseUrl: FIREWORKS_BASE_URL,
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
            maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS,
          },
        ],
      }),
    );

    expect(resolved).toMatchObject({
      provider: "fireworks",
      id: "accounts/fireworks/routers/kimi-k2.5-turbo",
      reasoning: false,
    });
  });
});
