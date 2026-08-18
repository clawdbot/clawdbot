import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it } from "vitest";
import { LLAMA_SERVER_LOCAL_AUTH_MARKER } from "./defaults.js";
import { registerExternalLlamaServerProvider } from "./register.js";

function captureProvider() {
  type Provider = Parameters<OpenClawPluginApi["registerProvider"]>[0];
  type CatalogProvider = Parameters<OpenClawPluginApi["registerModelCatalogProvider"]>[0];
  const providers: Provider[] = [];
  const modelCatalogProviders: CatalogProvider[] = [];
  registerExternalLlamaServerProvider({
    registerProvider: (provider: Provider) => providers.push(provider),
    registerModelCatalogProvider: (provider: CatalogProvider) =>
      modelCatalogProviders.push(provider),
  } as unknown as OpenClawPluginApi);
  const provider = providers[0];
  if (!provider) {
    throw new Error("expected llama-server provider registration");
  }
  return { captured: { modelCatalogProviders }, provider };
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

describe("external llama-server registration", () => {
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

  it("preserves existing managed config when the provider takes ownership", () => {
    const { provider } = captureProvider();
    const config = {
      agents: {
        defaults: { model: { primary: "llama-server/model" } },
      },
      models: {
        providers: {
          "llama-server": {
            ...configuredProvider(),
            apiKey: "existing-key",
            headers: { "X-Tenant": "one" },
            localService: {
              command: "/usr/local/bin/llama-server",
              args: ["--model", "/models/model.gguf"],
              healthUrl: "http://localhost:8080/health",
            },
          },
        },
      },
    };

    expect(
      provider.normalizeConfig?.({
        provider: "llama-server",
        providerConfig: config.models.providers["llama-server"],
      }),
    ).toMatchObject({
      baseUrl: "http://localhost:8080/v1",
      apiKey: "existing-key",
      headers: { "X-Tenant": "one" },
      localService: {
        command: "/usr/local/bin/llama-server",
        args: ["--model", "/models/model.gguf"],
        healthUrl: "http://localhost:8080/health",
      },
    });
    expect(config.agents.defaults.model.primary).toBe("llama-server/model");
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
