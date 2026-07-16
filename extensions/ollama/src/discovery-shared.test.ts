// Ollama tests cover discovery shared plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it } from "vitest";
import { isLocalOllamaBaseUrl, resolveOllamaDiscoveryResult } from "./discovery-shared.js";

describe("isLocalOllamaBaseUrl", () => {
  it.each([
    undefined,
    "",
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    "http://0.0.0.0:11434",
    "http://[::1]:11434",
    "http://10.0.0.5:11434",
    "http://172.16.0.10:11434",
    "http://172.31.255.254:11434",
    "http://192.168.1.100:11434",
    "http://gpu-node-1:11434",
    "http://mac-studio.local:11434",
    "http://docker.orb.internal:11434",
    "http://host.docker.internal:11434",
    "http://host.orb.internal:11434",
    "http://[fd00::1]:11434",
    "http://[fe90::1]:11434",
  ])("classifies %s as local", (baseUrl) => {
    expect(isLocalOllamaBaseUrl(baseUrl)).toBe(true);
  });

  it.each([
    "https://ollama.com",
    "https://api.ollama.com/v1",
    "https://ollama.example.com:11434",
    "http://8.8.8.8:11434",
    "http://172.15.255.254:11434",
    "http://172.32.0.1:11434",
    "http://193.168.1.1:11434",
    "http://[2001:4860:4860::8888]:11434",
    "http://10.example.com:11434",
    "not a url",
  ])("classifies %s as remote", (baseUrl) => {
    expect(isLocalOllamaBaseUrl(baseUrl)).toBe(false);
  });
});

describe("resolveOllamaDiscoveryResult — hosted Ollama Cloud guard", () => {
  const discoveredModel = {
    id: "discovered-model",
    name: "discovered-model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    compat: { supportsTools: true, supportsUsageInStreaming: true },
    params: { num_ctx: 128000 },
  } satisfies ModelProviderConfig["models"][number];

  const cloudModel = {
    id: "minimax-m3:cloud",
    name: "minimax-m3:cloud",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    compat: { supportsTools: true, supportsUsageInStreaming: true },
    params: { num_ctx: 128000 },
  } satisfies ModelProviderConfig["models"][number];

  const buildMockProvider = async (
    _configuredBaseUrl?: string,
    _opts?: { quiet?: boolean },
  ): Promise<ModelProviderConfig> => ({
    baseUrl: "https://ollama.com",
    api: "ollama",
    models: [discoveredModel],
  });

  it.each([
    "https://ollama.com",
    "https://ollama.com:11434",
    "https://api.ollama.com",
    "https://api.ollama.com/v1",
    "https://sub.ollama.com",
  ])("returns null for hosted base URL %s without explicit models", async (baseUrl) => {
    const result = await resolveOllamaDiscoveryResult({
      ctx: {
        config: {
          models: {
            providers: {
              ollama: {
                baseUrl,
                apiKey: "test-key",
                api: "ollama",
              },
            },
          },
        },
        env: {},
        resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      },
      pluginConfig: {},
      buildProvider: buildMockProvider,
    });
    expect(result).toBeNull();
  });

  it("returns explicit models for remote base URL when models are configured", async () => {
    const result = await resolveOllamaDiscoveryResult({
      ctx: {
        config: {
          models: {
            providers: {
              ollama: {
                baseUrl: "https://ollama.com",
                apiKey: "test-key",
                api: "ollama",
                models: [cloudModel],
              },
            },
          },
        },
        env: {},
        resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      },
      pluginConfig: {},
      buildProvider: buildMockProvider,
    });
    expect(result).not.toBeNull();
    const discoveryResult = expectDefined(result, "Ollama Cloud discovery result");
    expect(discoveryResult.provider.models).toHaveLength(1);
    expect(expectDefined(discoveryResult.provider.models[0], "Ollama Cloud model").id).toBe(
      "minimax-m3:cloud",
    );
  });

  it("does not call buildProvider for remote base URL without explicit models", async () => {
    let providerCalled = false;
    const trackingBuildProvider = async (
      _configuredBaseUrl?: string,
      _opts?: { quiet?: boolean },
    ): Promise<ModelProviderConfig> => {
      providerCalled = true;
      return buildMockProvider();
    };

    const result = await resolveOllamaDiscoveryResult({
      ctx: {
        config: {
          models: {
            providers: {
              ollama: {
                baseUrl: "https://ollama.com",
                apiKey: "test-key",
                api: "ollama",
              },
            },
          },
        },
        env: {},
        resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      },
      pluginConfig: {},
      buildProvider: trackingBuildProvider,
    });
    expect(result).toBeNull();
    expect(providerCalled).toBe(false);
  });

  it.each([
    undefined,
    "",
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    "https://ollama.mycompany.com",
    "https://ollama.example.com",
    "http://10.0.0.5:11434",
    "not a url",
  ])("still auto-discovers for non-hosted base URL %s", async (baseUrl) => {
    const result = await resolveOllamaDiscoveryResult({
      ctx: {
        config: {
          models: {
            providers: {
              ollama: {
                baseUrl,
                apiKey: "test-key",
                api: "ollama",
              },
            },
          },
        },
        env: {},
        resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      },
      pluginConfig: {},
      buildProvider: buildMockProvider,
    });
    // Remote self-hosted base URL should still reach the discovery path
    expect(result).not.toBeNull();
  });

  it("still auto-discovers for local base URL when no explicit models", async () => {
    const result = await resolveOllamaDiscoveryResult({
      ctx: {
        config: {
          models: {
            providers: {
              ollama: {
                baseUrl: "http://localhost:11434",
                api: "ollama",
              },
            },
          },
        },
        env: { OLLAMA_API_KEY: "ollama-local" },
        resolveProviderApiKey: () => ({ apiKey: "ollama-local" }),
      },
      pluginConfig: {},
      buildProvider: buildMockProvider,
    });
    // Local base URL should still reach the discovery path
    expect(result).not.toBeNull();
  });
});
