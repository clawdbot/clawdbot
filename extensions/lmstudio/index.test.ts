import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER } from "./src/defaults.js";

function registerProvider() {
  const captured = capturePluginRegistration(plugin);
  const provider = captured.providers[0];
  expect(provider?.id).toBe("lmstudio");
  return provider;
}

function createRemoteProviderConfig(overrides?: Partial<ModelProviderConfig>): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: "http://lmstudio.internal:1234/v1",
    models: [
      {
        id: "qwen/qwen3.5-9b",
        name: "Qwen 3.5 9B",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 8192,
      },
    ],
    ...overrides,
  };
}

describe("lmstudio plugin", () => {
  it("canonicalizes base URLs during provider normalization", () => {
    const provider = registerProvider();

    expect(
      provider?.normalizeConfig?.({
        provider: "lmstudio",
        providerConfig: createRemoteProviderConfig({
          baseUrl: "http://localhost:1234/api/v1/",
        }),
      }),
    ).toMatchObject({
      baseUrl: "http://localhost:1234/v1",
    });
  });

  it("synthesizes placeholder auth for configured lmstudio models without API key auth", () => {
    const provider = registerProvider();

    expect(
      provider?.resolveSyntheticAuth?.({
        provider: "lmstudio",
        config: {},
        providerConfig: createRemoteProviderConfig({
          headers: {
            "X-Proxy-Auth": "proxy-token",
          },
        }),
      }),
    ).toEqual({
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      source: "models.providers.lmstudio (synthetic local key)",
      mode: "api-key",
    });
  });

  it("still synthesizes placeholder auth when explicit api-key auth has no key", () => {
    const provider = registerProvider();

    expect(
      provider?.resolveSyntheticAuth?.({
        provider: "lmstudio",
        config: {},
        providerConfig: createRemoteProviderConfig({
          auth: "api-key",
        }),
      }),
    ).toEqual({
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      source: "models.providers.lmstudio (synthetic local key)",
      mode: "api-key",
    });
  });

  it("does not synthesize placeholder auth when Authorization header is configured", () => {
    const provider = registerProvider();

    expect(
      provider?.resolveSyntheticAuth?.({
        provider: "lmstudio",
        config: {},
        providerConfig: createRemoteProviderConfig({
          headers: {
            Authorization: "Bearer proxy-token",
          },
        }),
      }),
    ).toBeUndefined();
  });

  it("defers stored lmstudio-local profile auth so real credentials can win", () => {
    const provider = registerProvider();

    expect(
      provider?.shouldDeferSyntheticProfileAuth?.({
        provider: "lmstudio",
        config: {},
        providerConfig: createRemoteProviderConfig(),
        resolvedApiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
      }),
    ).toBe(true);

    expect(
      provider?.shouldDeferSyntheticProfileAuth?.({
        provider: "lmstudio",
        config: {},
        providerConfig: createRemoteProviderConfig(),
        resolvedApiKey: CUSTOM_LOCAL_AUTH_MARKER,
      }),
    ).toBe(true);

    expect(
      provider?.shouldDeferSyntheticProfileAuth?.({
        provider: "lmstudio",
        config: {},
        providerConfig: createRemoteProviderConfig(),
        resolvedApiKey: "lmstudio-real-key",
      }),
    ).toBe(false);
  });

  it("augments the catalog with configured lmstudio models", () => {
    const provider = registerProvider();
    const config = {
      models: {
        providers: {
          lmstudio: {
            models: [
              {
                id: "qwen3-8b-instruct",
                name: "Qwen 3 8B Instruct",
                contextWindow: 32768,
                contextTokens: 8192,
                reasoning: true,
                input: ["text", "image"],
                compat: {
                  supportsReasoningEffort: true,
                  supportedReasoningEfforts: ["off", "on"],
                  reasoningEffortMap: { off: "off", high: "on" },
                },
              },
              {
                id: "phi-4",
              },
              {
                id: " ",
                name: "ignored",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      provider?.augmentModelCatalog?.({
        config,
        agentDir: "/tmp/openclaw",
        env: {},
        entries: [],
      }),
    ).toEqual([
      {
        provider: "lmstudio",
        id: "qwen3-8b-instruct",
        name: "Qwen 3 8B Instruct",
        compat: {
          supportsUsageInStreaming: true,
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["off", "on"],
          reasoningEffortMap: { off: "off", high: "on" },
        },
        contextWindow: 32768,
        contextTokens: 8192,
        reasoning: true,
        input: ["text", "image"],
      },
      {
        provider: "lmstudio",
        id: "phi-4",
        name: "phi-4",
        compat: { supportsUsageInStreaming: true },
        contextWindow: undefined,
        contextTokens: undefined,
        reasoning: undefined,
        input: undefined,
      },
    ]);
  });
});
