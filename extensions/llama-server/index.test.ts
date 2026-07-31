import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { LLAMA_SERVER_LOCAL_AUTH_MARKER } from "./src/defaults.js";

function captureProvider() {
  const captured = capturePluginRegistration(plugin);
  const provider = captured.providers[0];
  if (!provider) {
    throw new Error("expected llama-server provider registration");
  }
  return { captured, provider };
}

function configuredProvider() {
  return {
    baseUrl: "http://localhost:8080/v1",
    api: "openai-completions" as const,
    models: [
      {
        id: "model",
        name: "model",
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 2048,
      },
    ],
  };
}

describe("llama-server plugin", () => {
  it("registers the provider and unified live catalog", () => {
    const { captured, provider } = captureProvider();

    expect(provider.id).toBe("llama-server");
    expect(provider.catalog).toBeDefined();
    expect(captured.modelCatalogProviders).toEqual([
      expect.objectContaining({ provider: "llama-server", kinds: ["text"] }),
    ]);
  });

  it("registers llama.cpp GBNF schema projection", () => {
    const { provider } = captureProvider();
    expect(provider).toMatchObject({
      normalizeToolSchemas: expect.any(Function),
      inspectToolSchemas: expect.any(Function),
    });
  });

  it("normalizes config onto the OpenAI completions transport", () => {
    const { provider } = captureProvider();
    expect(
      provider.normalizeConfig?.({
        provider: "llama-server",
        providerConfig: {
          ...configuredProvider(),
          baseUrl: "localhost:8080/",
          api: "openai-responses",
        },
      }),
    ).toMatchObject({
      baseUrl: "http://localhost:8080/v1",
      api: "openai-completions",
      request: { allowPrivateNetwork: true },
    });
  });

  it("uses synthetic auth unless a real API key is configured", () => {
    const { provider } = captureProvider();
    expect(
      provider.resolveSyntheticAuth?.({
        provider: "llama-server",
        config: {},
        providerConfig: configuredProvider(),
      }),
    ).toEqual({
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      source: "models.providers.llama-server (synthetic local key)",
      mode: "api-key",
    });
    expect(
      provider.resolveSyntheticAuth?.({
        provider: "llama-server",
        config: {},
        providerConfig: { ...configuredProvider(), apiKey: "real-key" },
      }),
    ).toBeUndefined();
    expect(
      provider.resolveSyntheticAuth?.({
        provider: "llama-server",
        config: {},
        providerConfig: {
          ...configuredProvider(),
          headers: { Authorization: "Bearer proxy-key" },
        },
      }),
    ).toEqual({
      apiKey: LLAMA_SERVER_LOCAL_AUTH_MARKER,
      source: "models.providers.llama-server (synthetic local key)",
      mode: "api-key",
    });
  });

  it("defers both supported synthetic auth markers", () => {
    const { provider } = captureProvider();
    const context = {
      provider: "llama-server",
      config: {},
      providerConfig: configuredProvider(),
    };
    expect(
      provider.shouldDeferSyntheticProfileAuth?.({
        ...context,
        resolvedApiKey: LLAMA_SERVER_LOCAL_AUTH_MARKER,
      }),
    ).toBe(true);
    expect(
      provider.shouldDeferSyntheticProfileAuth?.({
        ...context,
        resolvedApiKey: CUSTOM_LOCAL_AUTH_MARKER,
      }),
    ).toBe(true);
    expect(
      provider.shouldDeferSyntheticProfileAuth?.({ ...context, resolvedApiKey: "real-key" }),
    ).toBe(false);
  });
});
