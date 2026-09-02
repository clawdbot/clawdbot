import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import {
  createProviderDynamicModelContext,
  runSingleProviderCatalog,
} from "../test-support/provider-model-test-helpers.js";
import fireworksPlugin from "./index.js";
import {
  FIREWORKS_BASE_URL,
  FIREWORKS_DEFAULT_CONTEXT_WINDOW,
  FIREWORKS_DEFAULT_MAX_TOKENS,
  FIREWORKS_DEFAULT_MODEL_ID,
} from "./provider-catalog.js";
import { resolveThinkingProfile } from "./provider-policy-api.js";

const FIREWORKS_KIMI_K2_6_MODEL_ID = "accounts/fireworks/models/kimi-k2p6";
const FIREWORKS_KIMI_K2_6_TURBO_MODEL_ID = "accounts/fireworks/routers/kimi-k2p6-turbo";

function createFireworksDefaultRuntimeModel(params: { reasoning: boolean }): ProviderRuntimeModel {
  return {
    id: FIREWORKS_DEFAULT_MODEL_ID,
    name: FIREWORKS_DEFAULT_MODEL_ID,
    provider: "fireworks",
    api: "openai-completions",
    baseUrl: FIREWORKS_BASE_URL,
    reasoning: params.reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS,
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
    if (!resolved) {
      throw new Error("expected Fireworks api-key auth choice");
    }
    expect(resolved.provider.id).toBe("fireworks");
    expect(resolved.method.id).toBe("api-key");
  });

  it("builds the static Fireworks catalog", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const catalogProvider = await runSingleProviderCatalog({ catalog: provider.staticCatalog });

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe(FIREWORKS_BASE_URL);
    const models = catalogProvider.models;
    if (!models) {
      throw new Error("expected Fireworks catalog models");
    }
    expect(models.map((model) => model.id)).toEqual([
      FIREWORKS_DEFAULT_MODEL_ID,
      FIREWORKS_KIMI_K2_6_MODEL_ID,
      FIREWORKS_KIMI_K2_6_TURBO_MODEL_ID,
    ]);
    expect(models[0]?.name).toBe("GLM 5.2 Fast");
    expect(models[0]?.reasoning).toBe(true);
    expect(models[0]?.input).toEqual(["text"]);
    expect(models[0]?.contextWindow).toBe(FIREWORKS_DEFAULT_CONTEXT_WINDOW);
    expect(models[0]?.maxTokens).toBe(FIREWORKS_DEFAULT_MAX_TOKENS);
    expect(models[0]?.cost).toEqual({
      input: 2.1,
      output: 6.6,
      cacheRead: 0.21,
      cacheWrite: 0,
    });
    expect(models[1]?.name).toBe("Kimi K2.6");
    expect(models[1]?.reasoning).toBe(false);
    expect(models[1]?.input).toEqual(["text", "image"]);
    expect(models[1]?.contextWindow).toBe(262144);
    expect(models[1]?.maxTokens).toBe(262144);
    expect(models[1]?.cost).toEqual({
      input: 0.95,
      output: 4,
      cacheRead: 0.16,
      cacheWrite: 0,
    });
    expect(models[2]).toMatchObject({
      name: "Kimi K2.6 Fast",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 256000,
      cost: {
        input: 2,
        output: 8,
        cacheRead: 0.3,
        cacheWrite: 0,
      },
    });
  });

  it("resolves forward-compat Fireworks model ids from the default template", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/qwen3.6-plus",
        models: [createFireworksDefaultRuntimeModel({ reasoning: true })],
      }),
    );

    expect(resolved?.provider).toBe("fireworks");
    expect(resolved?.id).toBe("accounts/fireworks/models/qwen3.6-plus");
    expect(resolved?.api).toBe("openai-completions");
    expect(resolved?.baseUrl).toBe(FIREWORKS_BASE_URL);
    expect(resolved?.reasoning).toBe(true);
    expect(resolved?.input).toEqual(["text", "image"]);
  });

  it("disables reasoning metadata for Fireworks Kimi dynamic models", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/kimi-k2p5",
        models: [createFireworksDefaultRuntimeModel({ reasoning: true })],
      }),
    );

    expect(resolved?.provider).toBe("fireworks");
    expect(resolved?.id).toBe("accounts/fireworks/models/kimi-k2p5");
    expect(resolved?.reasoning).toBe(false);
    expect(resolved?.input).toEqual(["text", "image"]);
  });

  it("keeps Fireworks GLM dynamic models text-only", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/glm-5p1",
        models: [createFireworksDefaultRuntimeModel({ reasoning: false })],
      }),
    );

    expect(resolved?.provider).toBe("fireworks");
    expect(resolved?.id).toBe("accounts/fireworks/models/glm-5p1");
    expect(resolved?.input).toEqual(["text"]);
  });

  it("disables reasoning metadata for Fireworks Kimi k2.5 aliases", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/routers/kimi-k2.5-turbo",
        models: [createFireworksDefaultRuntimeModel({ reasoning: true })],
      }),
    );

    expect(resolved?.provider).toBe("fireworks");
    expect(resolved?.id).toBe("accounts/fireworks/routers/kimi-k2.5-turbo");
    expect(resolved?.reasoning).toBe(false);
  });

  it("defers manifest catalog models to core static-catalog resolution", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    for (const modelId of [
      FIREWORKS_DEFAULT_MODEL_ID,
      FIREWORKS_KIMI_K2_6_MODEL_ID,
      FIREWORKS_KIMI_K2_6_TURBO_MODEL_ID,
    ]) {
      const resolved = provider.resolveDynamicModel?.(
        createProviderDynamicModelContext({
          provider: "fireworks",
          modelId,
          models: [createFireworksDefaultRuntimeModel({ reasoning: false })],
        }),
      );

      expect(resolved).toBeUndefined();
    }
  });

  it("exposes off-only thinking policy for Fireworks Kimi models", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: FIREWORKS_KIMI_K2_6_TURBO_MODEL_ID,
      }),
    ).toEqual({
      levels: [{ id: "off" }],
      defaultLevel: "off",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: FIREWORKS_KIMI_K2_6_MODEL_ID,
      }),
    ).toEqual({
      levels: [{ id: "off" }],
      defaultLevel: "off",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: FIREWORKS_DEFAULT_MODEL_ID,
      }),
    ).toBeUndefined();
    expect(resolveThinkingProfile({ modelId: FIREWORKS_KIMI_K2_6_MODEL_ID })).toEqual({
      levels: [{ id: "off" }],
      defaultLevel: "off",
    });
    expect(
      resolveThinkingProfile({
        modelId: "accounts/fireworks/models/qwen3.6-plus",
      }),
    ).toBeUndefined();
  });
});
