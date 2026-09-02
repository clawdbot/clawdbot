// Openzoo tests cover index plugin behavior.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-setup";
import { expectPassthroughReplayPolicy } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import {
  buildOpenzooModelDefinition,
  OPENZOO_LOCAL_API_KEY_PLACEHOLDER,
} from "./provider-models.js";

function createProviderConfig(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    baseUrl: "http://localhost:8402/v1",
    api: "openai-completions",
    models: [buildOpenzooModelDefinition()],
    ...overrides,
  };
}

describe("openzoo provider plugin", () => {
  it("registers a keyless custom auth method with app-guided detection", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("openzoo");
    expect(provider.label).toBe("openzoo");
    expect(provider.docsPath).toBe("/providers/openzoo");
    expect(provider.envVars).toBeUndefined();
    expect(provider.auth.map((method) => [method.id, method.kind])).toEqual([["custom", "custom"]]);
    const method = provider.auth[0];
    expect(typeof method?.appGuidedSetup?.detectAvailability).toBe("function");
    expect(typeof method?.appGuidedSetup?.detect).toBe("function");
    expect(typeof method?.appGuidedSetup?.prepare).toBe("function");
    expect(typeof method?.runNonInteractive).toBe("function");
    expect(typeof method?.validateNonInteractive).toBe("function");
    expect(provider.wizard?.setup).toMatchObject({ choiceId: "openzoo", methodId: "custom" });
  });

  it("runs the late catalog and a network-free static catalog", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.catalog?.order).toBe("late");
    const ctx = {
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    } as ProviderCatalogContext;
    expect(await provider.staticCatalog?.run(ctx)).toEqual({
      provider: {
        baseUrl: "http://localhost:8402/v1",
        api: "openai-completions",
        models: [buildOpenzooModelDefinition()],
      },
    });
  });

  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "openzoo",
      modelId: "google/gemini-2.5-pro",
      sanitizeThoughtSignatures: true,
    });
  });

  it("synthesizes local auth only for keyless configured providers", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.resolveSyntheticAuth?.({
        provider: "openzoo",
        config: {},
        providerConfig: createProviderConfig(),
      }),
    ).toEqual({
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      source: "models.providers.openzoo (synthetic local key)",
      mode: "api-key",
    });
    expect(
      provider.resolveSyntheticAuth?.({
        provider: "openzoo",
        config: {},
        providerConfig: createProviderConfig({ apiKey: OPENZOO_LOCAL_API_KEY_PLACEHOLDER }),
      }),
    ).toMatchObject({ apiKey: CUSTOM_LOCAL_AUTH_MARKER });
    expect(
      provider.resolveSyntheticAuth?.({
        provider: "openzoo",
        config: {},
        providerConfig: createProviderConfig({ apiKey: "real-key" }),
      }),
    ).toBeUndefined();
    expect(
      provider.resolveSyntheticAuth?.({
        provider: "openzoo",
        config: {},
        providerConfig: createProviderConfig({ headers: { Authorization: "Bearer token" } }),
      }),
    ).toBeUndefined();
    expect(
      provider.resolveSyntheticAuth?.({
        provider: "openzoo",
        config: {},
        providerConfig: undefined,
      }),
    ).toBeUndefined();
  });

  it("defers stored keyless profile auth so real credentials can win", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const base = { provider: "openzoo", config: {}, providerConfig: createProviderConfig() };

    expect(
      provider.shouldDeferSyntheticProfileAuth?.({
        ...base,
        resolvedApiKey: OPENZOO_LOCAL_API_KEY_PLACEHOLDER,
      }),
    ).toBe(true);
    expect(
      provider.shouldDeferSyntheticProfileAuth?.({
        ...base,
        resolvedApiKey: CUSTOM_LOCAL_AUTH_MARKER,
      }),
    ).toBe(true);
    expect(
      provider.shouldDeferSyntheticProfileAuth?.({ ...base, resolvedApiKey: "real-key" }),
    ).toBe(false);
  });

  it("publishes configured openzoo models through plugin-owned catalog augmentation", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.augmentModelCatalog?.({
        config: {
          models: {
            providers: {
              openzoo: {
                models: [
                  {
                    id: "anthropic/claude-sonnet-5",
                    name: "Claude Sonnet 5",
                    input: ["text", "image"],
                    reasoning: false,
                    contextWindow: 128000000,
                  },
                ],
              },
            },
          },
        },
      } as never),
    ).toEqual([
      {
        provider: "openzoo",
        id: "anthropic/claude-sonnet-5",
        name: "Claude Sonnet 5",
        input: ["text", "image"],
        reasoning: false,
        contextWindow: 128000000,
      },
    ]);
  });
});
